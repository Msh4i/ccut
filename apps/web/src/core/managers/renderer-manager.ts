import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportPhase, ExportResult } from "@/export";
import type { UnreadableAudio } from "@/export/errors";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { preflightStickers } from "@/services/renderer/sticker-preflight";
import { type BuildSceneParams, buildScene } from "@/services/renderer/scene-builder";
import {
	EXPORT_CHANNELS,
	EXPORT_SAMPLE_RATE,
	createTimelineAudioBuffer,
	timelineHasAudio,
} from "@/media/audio";
import {
	assertAudioReadable,
	preflightAudio,
} from "@/services/renderer/audio-track";
import { getDesktopExportBridge } from "@/export/desktop-bridge";
import { estimateExportBytes } from "@/export/memory-limit";
import { openExportSink, type ExportSink } from "@/export/sink";
import { formatTimecode } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import { videoCache } from "@/services/video-cache/service";
import { createExportMemoryGuard, readRendererDataBytes } from "@/export/renderer-memory-guard";
import { downloadBlob } from "@/utils/browser";

/**
 * What the playback frame cache may hold while an export runs. The export reads every frame once,
 * so a cache of several GB (the "High" mode allows 6) only competes with the encoder and the
 * compositor for memory; a machine that runs out of memory then stalls or kills the session.
 */
export const EXPORT_CACHE_BUDGET_BYTES = 512 * 1024 ** 2;

/** What the export is doing now; frame counts while encoding. */
export type ExportPhaseUpdate =
	| { phase: Exclude<ExportPhase, "encoding"> }
	| { phase: "encoding"; framesDone: number; frameCount: number };

/**
 * Asked when some audio could not be read: true = export anyway (those clips are
 * silent; with `allUnreadable`, no sound at all), false = stop (a cancel).
 */
export type ConfirmUnreadableAudio = (question: {
	skipped: UnreadableAudio[];
	allUnreadable: boolean;
}) => Promise<boolean>;

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	/** What the preview's scene was built from: a snapshot builds its own copy from it. */
	private previewSceneParams: BuildSceneParams | null = null;
	private _isDegraded = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	/**
	 * The preview's scene, built from `params`. A render writes the resolved
	 * state of each node of the scene it draws, so another render (a snapshot)
	 * never draws these nodes: it builds its own scene from the same params.
	 */
	setPreviewScene({ params }: { params: BuildSceneParams }): void {
		this.previewSceneParams = params;
		this.renderTree = buildScene(params);
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/** A PNG of the frame under the playhead, or null (an agent's "get_preview_frame"). */
	async captureSnapshotBlob(): Promise<Blob | null> {
		const snapshot = await this.createSnapshot();
		return snapshot.success ? snapshot.blob : null;
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		try {
			const sceneParams = this.previewSceneParams;
			const activeProject = this.editor.project.getActive();

			if (!sceneParams || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			// Its own nodes, built from the preview's scene inputs: the snapshot
			// shows what the preview shows, and the playing preview, resolving its
			// own nodes at preview resolution meanwhile, cannot write into it.
			await renderer.renderToCanvas({
				node: buildScene(sceneParams),
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Exports the active scene. The destination is opened first (the desktop
	 * app's save dialog, or memory in a browser), before any long work; then
	 * stickers, audio and frames. Whatever happens after the destination was
	 * opened, an export that does not succeed leaves no file behind: the sink is
	 * aborted in `finally` (a no-op after a successful commit).
	 */
	async exportProject({
		options,
		onProgress,
		signal,
		prepare,
		onPhase,
		confirmUnreadableAudio,
		openSink = openExportSink,
		bridge = getDesktopExportBridge(),
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		signal?: AbortSignal;
		/** Runs after the destination is open, before anything else (fonts). */
		prepare?: () => Promise<unknown>;
		onPhase?: (update: ExportPhaseUpdate) => void;
		/** Without it, unreadable audio stops the export with AUDIO_UNREADABLE. */
		confirmUnreadableAudio?: ConfirmUnreadableAudio;
		openSink?: typeof openExportSink;
		bridge?: ReturnType<typeof getDesktopExportBridge>;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio } = options;
		const isCancelled = () => !!signal?.aborted;

		let sink: ExportSink | null = null;
		let releaseCacheHold: (() => void) | null = null;
		try {
			const tracks = this.editor.scenes.getActiveScene().tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			// The save dialog comes before minutes of work; cancelling it is a cancel.
			sink = await openSink({
				bridge,
				format,
				suggestedName: activeProject.metadata.name,
				estimatedBytes: estimateExportBytes({
					format,
					quality,
					width: canvasSize.width,
					height: canvasSize.height,
					durationSeconds: duration / TICKS_PER_SECOND,
					includeAudio: !!includeAudio,
				}),
			});
			if (!sink || isCancelled()) {
				return { success: false, cancelled: true };
			}
			// The preview is not drawing while the export runs: its cached frames go now.
			// The export only moves forward: what a passed clip held goes at once (see FORWARD_ONLY_RELEASE_AFTER_MS).
			releaseCacheHold = videoCache.holdBudgetAtMost({ capBytes: EXPORT_CACHE_BUDGET_BYTES, forwardOnly: true });
			onPhase?.({ phase: "preparing" });
			await prepare?.();

			// Like an image, a sticker that cannot be loaded stops the export (it
			// would otherwise be missing from the video without a word). Cancel is
			// heard here too: a stalled sticker can take 10 s to give up.
			const stickers = await preflightStickers({
				tracks,
				isCancelled,
			});
			if (stickers === "cancelled") {
				return { success: false, cancelled: true };
			}

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				const hasAudio = timelineHasAudio({ tracks, mediaAssets });
				// An AAC encoder that cannot start stops the export now, not after the
				// mix (a long one takes minutes).
				await preflightAudio({
					format,
					quality,
					includeAudio,
					hasAudio,
					sampleRate: EXPORT_SAMPLE_RATE,
					numberOfChannels: EXPORT_CHANNELS,
				});
				onProgress?.({ progress: 0.05 });
				const mix = await createTimelineAudioBuffer({
					tracks,
					mediaAssets,
					duration,
				});
				if (isCancelled()) {
					return { success: false, cancelled: true };
				}
				// Clips whose audio could not be read are never silent without a word:
				// the user is asked, or (no one to ask) the export stops.
				const allUnreadable = hasAudio && !mix.buffer;
				if (confirmUnreadableAudio && (mix.skipped.length > 0 || allUnreadable)) {
					const exportAnyway = await confirmUnreadableAudio({ skipped: [...mix.skipped], allUnreadable });
					if (!exportAnyway || isCancelled()) {
						return { success: false, cancelled: true };
					}
				} else {
					assertAudioReadable({ mix, hasAudio });
				}
				audioBuffer = mix.buffer;
			}

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});

			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality,
				shouldIncludeAudio: !!includeAudio,
				audioBuffer: audioBuffer || undefined,
				sink,
				signal,
				memoryGuard: createExportMemoryGuard({
					read: () => readRendererDataBytes({ host: typeof window === "undefined" ? null : window }),
					relieve: () => videoCache.releaseHeldMemory(),
				}),
			});

			exporter.on("frames", (framesDone, frameCount) =>
				onPhase?.({ phase: "encoding", framesDone, frameCount }),
			);
			exporter.on("finalizing", () => onPhase?.({ phase: "finalizing" }));
			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio
					? 0.05 + progress * 0.95
					: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			const result = await exporter.export({ rootNode: scene });
			if (!result) {
				return { success: false, cancelled: true };
			}
			return result.kind === "buffer"
				? { success: true, buffer: result.buffer }
				: {
						success: true,
						file: {
							displayName: result.displayName,
							bytes: result.bytes,
							revealToken: result.revealToken,
						},
					};
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		} finally {
			releaseCacheHold?.();
			await sink?.abort();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
