import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { storageService } from "@/services/storage/service";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { ProjectManager } from "../project-manager";

const quotaError = new DOMException(
	"The quota has been exceeded.",
	"QuotaExceededError",
);

function buildProject({
	id = "p1",
	fps = 30,
}: { id?: string; fps?: number } = {}): TProject {
	const createdAt = new Date("2025-12-31T09:00:00.000Z");
	return {
		metadata: {
			id,
			name: "Project",
			duration: ZERO_MEDIA_TIME,
			createdAt,
			updatedAt: new Date("2026-01-01T10:00:00.000Z"),
		},
		scenes: [],
		currentSceneId: "scene-1",
		settings: {
			fps: { numerator: fps, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: CURRENT_PROJECT_VERSION,
	};
}

function createGate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function createProjectManager() {
	const save = {
		flush: mock(async () => {}),
		discard: mock(() => {}),
		markDirty: mock((_options?: { force?: boolean }) => {}),
		waitForIdle: mock(async () => {}),
	};
	const editor = {
		save,
		scenes: { getScenes: () => [], clearScenes: () => {} },
		media: { clearAllAssets: () => {} },
	};
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial EditorCore: only what ProjectManager touches in these tests.
	const projectManager = new ProjectManager(editor as unknown as EditorCore);
	projectManager.setActiveProject({ project: buildProject() });
	return { projectManager, save };
}

beforeEach(() => {
	spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	mock.restore();
});

describe("ProjectManager.saveCurrentProject", () => {
	test("rejects with the storage error instead of swallowing it", async () => {
		const { projectManager } = createProjectManager();
		const before = projectManager.getActive();
		spyOn(storageService, "saveProject").mockRejectedValue(quotaError);

		await expect(projectManager.saveCurrentProject()).rejects.toBe(quotaError);

		// Nothing is reported as saved.
		expect(projectManager.getActive()).toBe(before);
		expect(projectManager.getSavedProjects()).toEqual([]);
	});

	test("stores the project and refreshes the metadata on success", async () => {
		const { projectManager } = createProjectManager();
		const saveProject = spyOn(storageService, "saveProject").mockResolvedValue(
			undefined,
		);

		await projectManager.saveCurrentProject();

		expect(saveProject).toHaveBeenCalledTimes(1);
		const updatedAt = projectManager.getActive().metadata.updatedAt;
		expect(updatedAt.getTime()).toBeGreaterThan(
			new Date("2026-01-01T10:00:00.000Z").getTime(),
		);
		expect(projectManager.getSavedProjects().map((entry) => entry.id)).toEqual([
			"p1",
		]);
	});

	test("does nothing without an active project", async () => {
		const { projectManager } = createProjectManager();
		projectManager.closeProject();
		const saveProject = spyOn(storageService, "saveProject").mockResolvedValue(
			undefined,
		);

		await projectManager.saveCurrentProject();

		expect(saveProject).not.toHaveBeenCalled();
	});
});

describe("ProjectManager.prepareExit", () => {
	test("resolves when the final save succeeded", async () => {
		const { projectManager, save } = createProjectManager();

		await projectManager.prepareExit();

		expect(save.flush).toHaveBeenCalledTimes(1);
	});

	test("rejects when the final save fails, so the caller can keep the project open", async () => {
		const { projectManager, save } = createProjectManager();
		save.flush.mockRejectedValue(quotaError);

		await expect(projectManager.prepareExit()).rejects.toBe(quotaError);
	});

	test("still saves when the thumbnail cannot be generated", async () => {
		// The stand-in editor has no scene to render, so the thumbnail step throws.
		const { projectManager, save } = createProjectManager();

		await projectManager.prepareExit();

		expect(save.flush).toHaveBeenCalledTimes(1);
	});

	test("does nothing without an active project", async () => {
		const { projectManager, save } = createProjectManager();
		projectManager.closeProject();

		await projectManager.prepareExit();

		expect(save.flush).not.toHaveBeenCalled();
	});
});

describe("leaving the active project", () => {
	test("closeProject drops the unsaved state of the closed project", () => {
		const { projectManager, save } = createProjectManager();

		projectManager.closeProject();

		expect(save.discard).toHaveBeenCalledTimes(1);
	});

	test("deleting the active project drops its unsaved state too", async () => {
		const { projectManager, save } = createProjectManager();
		spyOn(storageService, "deleteProjectMedia").mockResolvedValue(undefined);
		spyOn(storageService, "deleteProject").mockResolvedValue(undefined);

		await projectManager.deleteProjects({ ids: ["p1"] });

		expect(save.discard).toHaveBeenCalledTimes(1);
	});

	test("deleting another project leaves the active project's unsaved state alone", async () => {
		const { projectManager, save } = createProjectManager();
		spyOn(storageService, "deleteProjectMedia").mockResolvedValue(undefined);
		spyOn(storageService, "deleteProject").mockResolvedValue(undefined);

		await projectManager.deleteProjects({ ids: ["other"] });

		expect(save.discard).not.toHaveBeenCalled();
	});
});

describe("ProjectManager.saveCurrentProject while the project changes", () => {
	test("keeps a settings change made while the write runs", async () => {
		const { projectManager } = createProjectManager();
		const gate = createGate();
		spyOn(storageService, "saveProject").mockImplementation(() => gate.promise);

		const saving = projectManager.saveCurrentProject();
		projectManager.setActiveProject({ project: buildProject({ fps: 60 }) });
		gate.release();
		await saving;

		expect(projectManager.getActive().settings.fps.numerator).toBe(60);
	});

	test("takes only the saved fields over, so a thumbnail set meanwhile survives", async () => {
		const { projectManager } = createProjectManager();
		const gate = createGate();
		spyOn(storageService, "saveProject").mockImplementation(() => gate.promise);

		const saving = projectManager.saveCurrentProject();
		await projectManager.updateThumbnail({ thumbnail: "data:image/png;x" });
		gate.release();
		await saving;

		expect(projectManager.getActive().metadata.thumbnail).toBe(
			"data:image/png;x",
		);
		expect(projectManager.getActive().metadata.updatedAt.getTime()).toBeGreaterThan(
			new Date("2026-01-01T10:00:00.000Z").getTime(),
		);
	});

	test("does not make the old project active again when another one was loaded meanwhile", async () => {
		const { projectManager } = createProjectManager();
		const gate = createGate();
		spyOn(storageService, "saveProject").mockImplementation(() => gate.promise);

		const saving = projectManager.saveCurrentProject();
		projectManager.setActiveProject({ project: buildProject({ id: "p2" }) });
		gate.release();
		await saving;

		expect(projectManager.getActive().metadata.id).toBe("p2");
	});

	test("does not reopen a project that was closed while the write ran", async () => {
		const { projectManager } = createProjectManager();
		const gate = createGate();
		spyOn(storageService, "saveProject").mockImplementation(() => gate.promise);

		const saving = projectManager.saveCurrentProject();
		projectManager.closeProject();
		gate.release();
		await saving;

		expect(projectManager.getActiveOrNull()).toBeNull();
	});

	test("refreshes the list entry of a project that was closed meanwhile, without adding unknown ones", async () => {
		const { projectManager } = createProjectManager();
		const saveProject = spyOn(storageService, "saveProject");
		saveProject.mockResolvedValueOnce(undefined);
		await projectManager.saveCurrentProject();
		const firstUpdatedAt = projectManager.getSavedProjects()[0].updatedAt;
		await Bun.sleep(3);

		const gate = createGate();
		saveProject.mockImplementationOnce(() => gate.promise);
		const saving = projectManager.saveCurrentProject();
		projectManager.closeProject();
		gate.release();
		await saving;

		expect(projectManager.getSavedProjects()).toHaveLength(1);
		expect(
			projectManager.getSavedProjects()[0].updatedAt.getTime(),
		).toBeGreaterThan(firstUpdatedAt.getTime());
	});

	test("does not put a deleted project back into the list", async () => {
		const { projectManager } = createProjectManager();
		const saveProject = spyOn(storageService, "saveProject");
		saveProject.mockResolvedValueOnce(undefined);
		await projectManager.saveCurrentProject();
		spyOn(storageService, "deleteProject").mockResolvedValue(undefined);
		spyOn(storageService, "deleteProjectMedia").mockResolvedValue(undefined);

		const gate = createGate();
		saveProject.mockImplementationOnce(() => gate.promise);
		const saving = projectManager.saveCurrentProject();
		await projectManager.deleteProjects({ ids: ["p1"] });
		gate.release();
		await saving;

		expect(projectManager.getSavedProjects()).toEqual([]);
		expect(projectManager.getActiveOrNull()).toBeNull();
	});
});

describe("ProjectManager.deleteProjects", () => {
	test("waits for a running save before it deletes the active project", async () => {
		const { projectManager, save } = createProjectManager();
		const idle = createGate();
		save.waitForIdle.mockImplementation(() => idle.promise);
		const deleteProject = spyOn(storageService, "deleteProject").mockResolvedValue(
			undefined,
		);
		spyOn(storageService, "deleteProjectMedia").mockResolvedValue(undefined);

		const deleting = projectManager.deleteProjects({ ids: ["p1"] });
		await Bun.sleep(5);
		expect(deleteProject).not.toHaveBeenCalled();

		idle.release();
		await deleting;

		expect(deleteProject).toHaveBeenCalledTimes(1);
	});

	test("never saves the project while it is being deleted", async () => {
		const { projectManager } = createProjectManager();
		const gate = createGate();
		spyOn(storageService, "deleteProject").mockImplementation(() => gate.promise);
		spyOn(storageService, "deleteProjectMedia").mockResolvedValue(undefined);
		const saveProject = spyOn(storageService, "saveProject").mockResolvedValue(
			undefined,
		);

		const deleting = projectManager.deleteProjects({ ids: ["p1"] });
		await Bun.sleep(5);
		await projectManager.saveCurrentProject();
		gate.release();
		await deleting;

		expect(saveProject).not.toHaveBeenCalled();
	});

	test("deletes the record before its media", async () => {
		const { projectManager } = createProjectManager();
		const calls: string[] = [];
		spyOn(storageService, "deleteProject").mockImplementation(async () => {
			calls.push("record");
		});
		spyOn(storageService, "deleteProjectMedia").mockImplementation(async () => {
			calls.push("media");
		});

		await projectManager.deleteProjects({ ids: ["p1"] });

		expect(calls).toEqual(["record", "media"]);
	});

	test("a failed record delete keeps the media and the open project, and keeps it dirty", async () => {
		const { projectManager, save } = createProjectManager();
		spyOn(storageService, "deleteProject").mockRejectedValue(new Error("busy"));
		const deleteMedia = spyOn(
			storageService,
			"deleteProjectMedia",
		).mockResolvedValue(undefined);

		await projectManager.deleteProjects({ ids: ["p1"] });

		expect(deleteMedia).not.toHaveBeenCalled();
		expect(projectManager.getActiveOrNull()).not.toBeNull();
		expect(save.markDirty).toHaveBeenCalledWith({ force: true });
	});
});

describe("ProjectManager.renameProject", () => {
	test("renames the open project in memory and lets autosave store it", async () => {
		const { projectManager, save } = createProjectManager();
		const loadProject = spyOn(storageService, "loadProject");
		const saveProject = spyOn(storageService, "saveProject");

		await projectManager.renameProject({ id: "p1", name: "Renamed" });

		expect(projectManager.getActive().metadata.name).toBe("Renamed");
		expect(loadProject).not.toHaveBeenCalled();
		expect(saveProject).not.toHaveBeenCalled();
		expect(save.markDirty).toHaveBeenCalledWith({ force: true });
	});

	test("renames a project that is not open directly in storage", async () => {
		const { projectManager, save } = createProjectManager();
		spyOn(storageService, "loadProject").mockResolvedValue({
			project: buildProject({ id: "other" }),
		});
		const saveProject = spyOn(storageService, "saveProject").mockResolvedValue(
			undefined,
		);

		await projectManager.renameProject({ id: "other", name: "Renamed" });

		expect(saveProject).toHaveBeenCalledTimes(1);
		expect(saveProject.mock.calls[0][0].project.metadata.name).toBe("Renamed");
		expect(projectManager.getSavedProjects()[0].name).toBe("Renamed");
		expect(projectManager.getActive().metadata.name).toBe("Project");
		expect(save.markDirty).not.toHaveBeenCalled();
	});
});

describe("ProjectManager.duplicateProjects", () => {
	function setUpDuplicate() {
		const { projectManager } = createProjectManager();
		const calls: string[] = [];
		spyOn(storageService, "loadProject").mockResolvedValue({
			project: buildProject({ id: "source" }),
		});
		spyOn(storageService, "loadAllMediaAssets").mockResolvedValue([
			{ id: "m1", name: "clip", type: "video", file: new File(["x"], "clip.mp4") },
		]);
		const saveMediaAsset = spyOn(storageService, "saveMediaAsset");
		const saveProject = spyOn(storageService, "saveProject");
		const deleteProject = spyOn(storageService, "deleteProject").mockImplementation(
			async () => {
				calls.push("deleteRecord");
			},
		);
		const deleteMedia = spyOn(storageService, "deleteProjectMedia").mockImplementation(
			async () => {
				calls.push("deleteMedia");
			},
		);
		saveMediaAsset.mockImplementation(async () => {
			calls.push("media");
		});
		saveProject.mockImplementation(async () => {
			calls.push("record");
		});
		return { projectManager, calls, saveMediaAsset, saveProject, deleteProject, deleteMedia };
	}

	test("copies the media first and writes the new record last", async () => {
		const { projectManager, calls } = setUpDuplicate();

		const ids = await projectManager.duplicateProjects({ ids: ["source"] });

		expect(ids).toHaveLength(1);
		expect(calls).toEqual(["media", "record"]);
	});

	test("a failed media copy leaves no half-built project behind", async () => {
		const { projectManager, calls, saveMediaAsset, saveProject, deleteProject, deleteMedia } =
			setUpDuplicate();
		saveMediaAsset.mockRejectedValue(new Error("disk full"));

		await expect(
			projectManager.duplicateProjects({ ids: ["source"] }),
		).rejects.toThrow("disk full");

		expect(saveProject).not.toHaveBeenCalled();
		expect(projectManager.getSavedProjects()).toEqual([]);
		// The partly copied media of the new id is removed, record first.
		expect(deleteProject).toHaveBeenCalledTimes(1);
		expect(deleteMedia).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["deleteRecord", "deleteMedia"]);
	});

	test("a failed record write removes the copied media", async () => {
		const { projectManager, saveProject, deleteMedia } = setUpDuplicate();
		saveProject.mockRejectedValue(new Error("quota"));

		await expect(
			projectManager.duplicateProjects({ ids: ["source"] }),
		).rejects.toThrow("quota");

		expect(deleteMedia).toHaveBeenCalledTimes(1);
		expect(projectManager.getSavedProjects()).toEqual([]);
	});
});
