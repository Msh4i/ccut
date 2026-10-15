import type { EditorCore } from "@/core";
import type {
	TProject,
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
	TProjectSettings,
	TTimelineViewState,
} from "@/project/types";
import type { ExportOptions, ExportResult, ExportState } from "@/export";
import { getDesktopExportBridge } from "@/export/desktop-bridge";
import { createEtaEstimator } from "@/export/eta";
import { IDLE_EXPORT_STATE } from "@/export/job-view";
import { storageService } from "@/services/storage/service";
import { toast } from "sonner";
import { generateUUID } from "@/utils/id";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import { buildDefaultScene, getProjectDurationFromScenes } from "@/timeline/scenes";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import {
	CURRENT_PROJECT_VERSION,
	migrations,
	runStorageMigrations,
	type MigrationProgress,
} from "@/services/storage/migrations";
import { ensureCustomFontsRegistered } from "@/fonts/custom-fonts";
import { prepareAndReportFonts } from "@/fonts/report-font-problems";
import { DEFAULTS } from "@/timeline/defaults";
import { getRaisedProjectFpsForImportedMedia } from "@/fps/utils";
import type { MediaAsset } from "@/media/types";

export interface MigrationState {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

export class ProjectManager {
	private active: TProject | null = null;
	private savedProjects: TProjectMetadata[] = [];
	private isLoading = true;
	private isInitialized = false;
	private invalidProjectIds = new Set<string>();
	private storageMigrationPromise: Promise<void> | null = null;
	private listeners = new Set<() => void>();
	private migrationState: MigrationState = {
		isMigrating: false,
		fromVersion: null,
		toVersion: null,
		projectName: null,
	};
	private exportState: ExportState = IDLE_EXPORT_STATE;
	private exportAbort: AbortController | null = null;
	private answerAudioQuestion: ((exportAnyway: boolean) => void) | null = null;
	// Ids being deleted: no save may write them back meanwhile.
	private deletingIds = new Set<string>();

	constructor(private editor: EditorCore) {}

	private async ensureStorageMigrations(): Promise<void> {
		if (this.storageMigrationPromise) {
			await this.storageMigrationPromise;
			return;
		}

		this.storageMigrationPromise = (async () => {
			await runStorageMigrations({
				migrations,
				onProgress: (progress: MigrationProgress) => {
					this.migrationState = progress;
					this.notify();
				},
			});
		})().catch((error: unknown) => {
			// Allow a retry on the next call instead of caching the failure.
			this.storageMigrationPromise = null;
			throw error;
		});

		await this.storageMigrationPromise;
	}

	async createNewProject({ name }: { name: string }): Promise<string> {
		const mainScene = buildDefaultScene({ name: "Main scene", isMain: true });
		const newProject: TProject = {
			metadata: {
				id: generateUUID(),
				name,
				duration: getProjectDurationFromScenes({ scenes: [mainScene] }),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			scenes: [mainScene],
			currentSceneId: mainScene.id,
			settings: {
				fps: DEFAULT_FPS,
				canvasSize: DEFAULT_CANVAS_SIZE,
				canvasSizeMode: "preset",
				lastCustomCanvasSize: null,
				originalCanvasSize: null,
				background: {
					type: "color",
					color: DEFAULT_BACKGROUND_COLOR,
				},
			},
			version: CURRENT_PROJECT_VERSION,
		};

		this.active = newProject;
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.scenes.initializeScenes({
			scenes: newProject.scenes,
			currentSceneId: newProject.currentSceneId,
		});

		try {
			await storageService.saveProject({ project: newProject });
			this.updateMetadata(newProject);

			return newProject.metadata.id;
		} catch (error) {
			toast.error("Failed to save new project");
			throw error;
		}
	}

	async loadProject({ id }: { id: string }): Promise<void> {
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		this.editor.save.pause();
		// Starts reading the font library now, in parallel with the project.
		void ensureCustomFontsRegistered();

		try {
			await this.ensureStorageMigrations();
			this.editor.media.clearAllAssets();
			this.editor.scenes.clearScenes();

			const result = await storageService.loadProject({ id });
			if (!result) {
				throw new Error(`Project with id ${id} not found`);
			}

			const project = result.project;

			this.active = project;
			this.notify();

			if (project.scenes && project.scenes.length > 0) {
				this.editor.scenes.initializeScenes({
					scenes: project.scenes,
					currentSceneId: project.currentSceneId,
				});
			}

			await this.editor.media.loadProjectMedia({ projectId: id });

			await prepareAndReportFonts({ scenes: project.scenes ?? [] });

			if (!project.metadata.thumbnail) {
				try {
					const didUpdateThumbnail = await this.updateThumbnailFromTimeline();
					if (didUpdateThumbnail) {
						await this.saveCurrentProject();
					}
				} catch (error) {
					console.error("Failed to generate project thumbnail:", error);
				}
			}
		} catch (error) {
			console.error("Failed to load project:", error);
			throw error;
		} finally {
			this.isLoading = false;
			this.notify();
			this.editor.save.resume();
		}
	}

	async saveCurrentProject(): Promise<void> {
		if (!this.active) return;
		if (this.deletingIds.has(this.active.metadata.id)) return;

		// A failed write rejects: SaveManager keeps the project dirty and retries,
		// and explicit saves (exit) must not report success.
		const scenes = this.editor.scenes.getScenes();
		const updatedProject = {
			...this.active,
			scenes,
			metadata: {
				...this.active.metadata,
				duration: getProjectDurationFromScenes({ scenes }),
				updatedAt: new Date(),
			},
		};

		await storageService.saveProject({ project: updatedProject });

		// The project may have changed while the write ran. Take over only what
		// was saved, and leave a project that was closed, switched or deleted alone.
		if (this.active?.metadata.id !== updatedProject.metadata.id) {
			if (this.savedProjects.some((p) => p.id === updatedProject.metadata.id)) {
				this.updateMetadata(updatedProject);
			}
			return;
		}
		this.active = {
			...this.active,
			scenes: updatedProject.scenes,
			metadata: {
				...this.active.metadata,
				duration: updatedProject.metadata.duration,
				updatedAt: updatedProject.metadata.updatedAt,
			},
		};
		this.updateMetadata(this.active);
	}

	/**
	 * Runs an export and keeps `exportState` honest: whatever happens (a result, a throw), the
	 * state ends idle with the result. A stuck `isExporting` would freeze the preview (it reads
	 * the flag on every frame) and lock the export window.
	 */
	async export({ options }: { options: ExportOptions }): Promise<ExportResult> {
		const controller = new AbortController();
		this.exportAbort = controller;
		const eta = createEtaEstimator();
		this.setExportState({ ...IDLE_EXPORT_STATE, isExporting: true });

		let result: ExportResult = { success: false, error: "Unknown export error" };
		try {
			// Playback would keep the audio running and decoders busy under the export.
			this.editor.playback.pause();
			result = await this.editor.renderer.exportProject({
				options,
				// Export burns in whatever font is available, so warn about missing ones.
				// Run once the destination is chosen: the save dialog comes first.
				prepare: () => prepareAndReportFonts({ scenes: this.editor.scenes.getScenes() }),
				signal: controller.signal,
				onPhase: (update) => {
					if (update.phase !== "encoding") {
						this.setExportState({ ...this.exportState, phase: update.phase, etaSeconds: null });
						return;
					}
					const { framesDone, frameCount } = update;
					this.setExportState({
						...this.exportState,
						phase: "encoding",
						framesDone,
						frameCount,
						progress: frameCount > 0 ? framesDone / frameCount : 0,
						etaSeconds: eta.update({ framesDone, frameCount }),
					});
				},
				confirmUnreadableAudio: (question) => this.askAboutUnreadableAudio({ question, signal: controller.signal }),
			});
		} catch (error) {
			// exportProject reports its failures as a result; this is a bug or something unforeseen.
			console.error("Export failed:", error);
			result = { success: false, error: error instanceof Error ? error.message : "Unknown export error" };
		} finally {
			// Only the export that is still current ends the shared state: a newer one owns it now.
			if (this.exportAbort === controller) {
				this.exportAbort = null;
				this.answerAudioQuestion = null;
				this.setExportState({ ...IDLE_EXPORT_STATE, progress: this.exportState.progress, result });
			}
		}
		return result;
	}

	/** Waits for "Export anyway" (true) or "Cancel" (false); cancelling the export answers false. */
	private askAboutUnreadableAudio({
		question,
		signal,
	}: {
		question: NonNullable<ExportState["audioQuestion"]>;
		signal: AbortSignal;
	}): Promise<boolean> {
		return new Promise((resolve) => {
			const answer = (exportAnyway: boolean) => {
				signal.removeEventListener("abort", onAbort);
				this.answerAudioQuestion = null;
				this.setExportState({ ...this.exportState, audioQuestion: null });
				resolve(exportAnyway);
			};
			const onAbort = () => answer(false);
			signal.addEventListener("abort", onAbort);
			this.answerAudioQuestion = answer;
			this.setExportState({ ...this.exportState, audioQuestion: question });
		});
	}

	answerUnreadableAudio({ exportAnyway }: { exportAnyway: boolean }): void {
		this.answerAudioQuestion?.(exportAnyway);
	}

	/**
	 * Stops the running export at its next check. The state says "cancelling" at once: the audio
	 * mix cannot be interrupted, so the export can run on for a while and the window must show
	 * that the click was heard. Not while the file is being finished: from there the exporter no
	 * longer looks at the signal and the file is saved, so a cancel would only mislead.
	 */
	cancelExport(): void {
		if (!this.exportAbort || this.exportAbort.signal.aborted) return;
		if (this.exportState.phase === "finalizing") return;
		this.setExportState({ ...this.exportState, cancelling: true });
		this.exportAbort.abort();
	}

	/** Shows the file just exported in its folder (desktop app); false if there is none. */
	async revealExportedFile(): Promise<boolean> {
		const token = this.exportState.result?.file?.revealToken;
		const bridge = getDesktopExportBridge();
		if (!token || !bridge) return false;
		try {
			return await bridge.reveal({ token });
		} catch {
			return false;
		}
	}

	/** Back to the settings after a result. Never while an export runs: it would hide a live export. */
	clearExportState(): void {
		if (this.exportState.isExporting) return;
		this.setExportState(IDLE_EXPORT_STATE);
	}

	private setExportState(state: ExportState): void {
		this.exportState = state;
		this.notify();
	}

	getExportState(): ExportState {
		return this.exportState;
	}

	async loadAllProjects(): Promise<void> {
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		try {
			await this.ensureStorageMigrations();
			try {
				const metadata = await storageService.loadAllProjectsMetadata();
				this.savedProjects = metadata;
				this.notify();
			} catch (error) {
				console.error("Failed to load projects:", error);
			} finally {
				this.isLoading = false;
				this.isInitialized = true;
				this.notify();
			}
		} catch (error) {
			console.error("Failed to run migrations:", error);
			this.isLoading = false;
			this.isInitialized = true;
			this.notify();
		}
	}

	async deleteProjects({ ids }: { ids: string[] }): Promise<void> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return;

		const idSet = new Set(uniqueIds);
		const isDeletingActive =
			this.active !== null && idSet.has(this.active.metadata.id);
		for (const id of uniqueIds) this.deletingIds.add(id);

		try {
			// A save that is already running must finish first, or it could write
			// the deleted record back.
			if (isDeletingActive) await this.editor.save.waitForIdle();

			await Promise.all(
				uniqueIds.map(async (id) => {
					// Record first: a failed record delete must not leave a project
					// whose media is already gone.
					await storageService.deleteProject({ id });
					await storageService.deleteProjectMedia({ projectId: id });
				}),
			);

			this.savedProjects = this.savedProjects.filter(
				(project) => !idSet.has(project.id),
			);

			const shouldClearActive =
				this.active && idSet.has(this.active.metadata.id);

			if (shouldClearActive) {
				this.active = null;
				this.editor.save.discard();
				this.editor.media.clearAllAssets();
				this.editor.scenes.clearScenes();
			}

			this.notify();
		} catch (error) {
			console.error("Failed to delete projects:", error);
			// Saves were skipped while deleting: the open project still has changes to store.
			if (isDeletingActive) this.editor.save.markDirty({ force: true });
		} finally {
			for (const id of uniqueIds) this.deletingIds.delete(id);
		}
	}

	closeProject(): void {
		this.active = null;
		this.editor.save.discard();
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.scenes.clearScenes();
	}

	async renameProject({
		id,
		name,
	}: {
		id: string;
		name: string;
	}): Promise<void> {
		// The open project is renamed in memory and stored by autosave: a
		// load-modify-save here could overwrite a newer autosave with stale scenes.
		if (this.active?.metadata.id === id) {
			this.active = {
				...this.active,
				metadata: { ...this.active.metadata, name, updatedAt: new Date() },
			};
			this.notify();
			this.updateMetadata(this.active);
			this.editor.save.markDirty({ force: true });
			return;
		}

		try {
			const result = await storageService.loadProject({ id });
			if (!result) {
				toast.error("Project not found", {
					description: "Please try again",
				});
				return;
			}

			const updatedProject: TProject = {
				...result.project,
				metadata: {
					...result.project.metadata,
					name,
					updatedAt: new Date(),
				},
			};

			await storageService.saveProject({ project: updatedProject });

			this.updateMetadata(updatedProject);
		} catch (error) {
			console.error("Failed to rename project:", error);
			toast.error("Failed to rename project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	}

	async duplicateProjects({ ids }: { ids: string[] }): Promise<string[]> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return [];

		try {
			const getDuplicateBaseName = ({ name }: { name: string }) => {
				const match = name.match(/^\((\d+)\)\s+(.+)$/);
				const number = match ? Number.parseInt(match[1], 10) : null;
				const baseName = match ? match[2] : name;
				return { baseName, number };
			};

			const loadResults = await Promise.all(
				uniqueIds.map(async (projectId) => {
					const result = await storageService.loadProject({ id: projectId });
					return { projectId, project: result?.project ?? null };
				}),
			);

			const missingProjectIds = loadResults
				.filter((result) => !result.project)
				.map((result) => result.projectId);

			if (missingProjectIds.length > 0) {
				toast.error(
					missingProjectIds.length === 1
						? "Project not found"
						: "Projects not found",
					{
						description:
							missingProjectIds.length === 1
								? "Please try again"
								: "Some projects could not be found",
					},
				);
				throw new Error(`Projects not found: ${missingProjectIds.join(", ")}`);
			}

			const projectsToDuplicate = loadResults.flatMap((result) =>
				result.project ? [result.project] : [],
			);

			const maxNumberByBaseName = new Map<string, number>();

			for (const project of this.savedProjects) {
				const { baseName, number } = getDuplicateBaseName({
					name: project.name,
				});

				if (number === null) continue;

				const currentMax = maxNumberByBaseName.get(baseName);
				if (currentMax === undefined || number > currentMax) {
					maxNumberByBaseName.set(baseName, number);
				}
			}

			const nextNumberByBaseName = new Map<string, number>();
			for (const [baseName, maxNumber] of maxNumberByBaseName) {
				nextNumberByBaseName.set(baseName, maxNumber + 1);
			}

			const duplicationPlans = projectsToDuplicate.map((project) => {
				const { baseName } = getDuplicateBaseName({
					name: project.metadata.name,
				});
				const nextNumber = nextNumberByBaseName.get(baseName) ?? 1;
				nextNumberByBaseName.set(baseName, nextNumber + 1);

				const newProjectId = generateUUID();
				const newProject: TProject = {
					...project,
					metadata: {
						...project.metadata,
						id: newProjectId,
						name: `(${nextNumber}) ${baseName}`,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				};

				return {
					newProjectId,
					newProject,
					sourceProjectId: project.metadata.id,
				};
			});

			// Media first and the record last: a project only exists once its media
			// is complete. On failure remove what was written for the new ids.
			try {
				await Promise.all(
					duplicationPlans.map(async ({ sourceProjectId, newProjectId }) => {
						const sourceMediaAssets = await storageService.loadAllMediaAssets({
							projectId: sourceProjectId,
						});

						await Promise.all(
							sourceMediaAssets.map((mediaAsset) =>
								storageService.saveMediaAsset({
									projectId: newProjectId,
									mediaAsset,
								}),
							),
						);
					}),
				);

				await Promise.all(
					duplicationPlans.map(({ newProject }) =>
						storageService.saveProject({ project: newProject }),
					),
				);
			} catch (error) {
				await Promise.allSettled(
					duplicationPlans.map(async ({ newProjectId }) => {
						await storageService.deleteProject({ id: newProjectId });
						await storageService.deleteProjectMedia({ projectId: newProjectId });
					}),
				);
				throw error;
			}

			for (const { newProject } of duplicationPlans) {
				this.updateMetadata(newProject);
			}

			return duplicationPlans.map((plan) => plan.newProjectId);
		} catch (error) {
			console.error("Failed to duplicate projects:", error);
			toast.error("Failed to duplicate projects", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
			throw error;
		}
	}

	async updateSettings({
		settings,
		pushHistory = true,
	}: {
		settings: Partial<TProjectSettings>;
		pushHistory?: boolean;
	}): Promise<void> {
		if (!this.active) return;

		const command = new UpdateProjectSettingsCommand(settings);
		if (pushHistory) {
			this.editor.command.execute({ command });
			return;
		}

		command.execute();
	}

	ratchetFpsForImportedMedia({
		importedAssets,
	}: {
		importedAssets: Array<Pick<MediaAsset, "type" | "fps">>;
	}): import("opencut-wasm").FrameRate | null {
		if (!this.active) return null;

		const nextFps = getRaisedProjectFpsForImportedMedia({
			currentFps: this.active.settings.fps,
			importedAssets,
		});
		if (nextFps === null) return null;

		new UpdateProjectSettingsCommand({ fps: nextFps }).execute();
		return nextFps;
	}

	async updateThumbnail({ thumbnail }: { thumbnail: string }): Promise<void> {
		if (!this.active) return;

		const updatedProject: TProject = {
			...this.active,
			metadata: { ...this.active.metadata, thumbnail, updatedAt: new Date() },
		};
		this.active = updatedProject;
		this.notify();
		this.updateMetadata(updatedProject);
		this.editor.save.markDirty();
	}

	async prepareExit(): Promise<void> {
		if (!this.active) return;

		try {
			await this.updateThumbnailFromTimeline();
		} catch (error) {
			console.error("Failed to generate project thumbnail on exit:", error);
		}

		// Rejects when the final save fails, so the caller can keep the project
		// open instead of dropping unsaved changes. A thumbnail problem must not
		// skip this save.
		await this.editor.save.flush();
	}

	getFilteredAndSortedProjects({
		searchQuery,
		sortOption,
	}: {
		searchQuery: string;
		sortOption: TProjectSortOption;
	}): TProjectMetadata[] {
		const filteredProjects = this.savedProjects.filter((project) =>
			project.name.toLowerCase().includes(searchQuery.toLowerCase()),
		);

		const [key, order] = sortOption.split("-") as [
			TProjectSortKey,
			"asc" | "desc",
		];

		const sortedProjects = [...filteredProjects].sort((a, b) => {
			const aValue = a[key];
			const bValue = b[key];

			if (order === "asc") {
				if (aValue < bValue) return -1;
				if (aValue > bValue) return 1;
				return 0;
			}
			if (aValue > bValue) return -1;
			if (aValue < bValue) return 1;
			return 0;
		});

		return sortedProjects;
	}

	isInvalidProjectId({ id }: { id: string }): boolean {
		return this.invalidProjectIds.has(id);
	}

	markProjectIdAsInvalid({ id }: { id: string }): void {
		this.invalidProjectIds.add(id);
		this.notify();
	}

	clearInvalidProjectIds(): void {
		this.invalidProjectIds.clear();
		this.notify();
	}

	getActive(): TProject {
		if (!this.active) {
			throw new Error("No active project");
		}
		return this.active;
	}

	/**
	 * for agents:
	 * in most cases, the project is guaranteed to be active, in which getActive() should be used instead.
	 * for very rare cases, this function may be used.
	 */
	getActiveOrNull(): TProject | null {
		return this.active;
	}

	getTimelineViewState(): TTimelineViewState {
		return this.active?.timelineViewState ?? DEFAULTS.timeline.viewState;
	}

	setTimelineViewState({ viewState }: { viewState: TTimelineViewState }): void {
		if (!this.active) return;
		this.active = {
			...this.active,
			timelineViewState: viewState ?? undefined,
		};
		this.editor.save.markDirty();
		this.notify();
	}

	getSavedProjects(): TProjectMetadata[] {
		return this.savedProjects;
	}

	getIsLoading(): boolean {
		return this.isLoading;
	}

	getIsInitialized(): boolean {
		return this.isInitialized;
	}

	getMigrationState(): MigrationState {
		return this.migrationState;
	}

	setActiveProject({ project }: { project: TProject }): void {
		this.active = project;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async updateThumbnailFromTimeline(): Promise<boolean> {
		if (!this.active) return false;

		const tracks = this.editor.scenes.getActiveScene().tracks;
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();
		const { canvasSize, background } = this.active.settings;

		const scene = buildScene({
			tracks,
			mediaAssets,
			duration: duration || 1,
			canvasSize,
			background,
		});

		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps: this.active.settings.fps,
		});

		const tempCanvas = document.createElement("canvas");
		tempCanvas.width = canvasSize.width;
		tempCanvas.height = canvasSize.height;

		await renderer.renderToCanvas({
			node: scene,
			time: 0,
			targetCanvas: tempCanvas,
		});

		const thumbnailDataUrl = tempCanvas.toDataURL("image/png");

		await this.updateThumbnail({ thumbnail: thumbnailDataUrl });
		return true;
	}

	private updateMetadata(project: TProject): void {
		const index = this.savedProjects.findIndex(
			(p) => p.id === project.metadata.id,
		);

		if (index !== -1) {
			this.savedProjects = this.savedProjects.with(index, project.metadata);
		} else {
			this.savedProjects = [project.metadata, ...this.savedProjects];
		}

		this.notify();
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
