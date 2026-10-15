import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import type { TProject } from "@/project/types";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { StorageService } from "@/services/storage/service";
import { mediaTime } from "@/wasm";
import { SaveManager } from "../save-manager";

// SaveManager wired to the real StorageService on a fake IndexedDB: what the
// user's data does when the browser refuses a write.

function buildProject({ name }: { name: string }): TProject {
	const createdAt = new Date("2025-12-31T09:00:00.000Z");
	const updatedAt = new Date("2026-01-01T10:00:00.000Z");
	return {
		metadata: {
			id: "p1",
			name,
			duration: mediaTime({ ticks: 360000 }),
			createdAt,
			updatedAt,
		},
		scenes: [
			{
				id: "scene-1",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [],
					main: {
						id: "main",
						name: "Main",
						type: "video",
						elements: [],
						muted: false,
						hidden: false,
					},
					audio: [],
				},
				bookmarks: [],
				createdAt,
				updatedAt,
			},
		],
		currentSceneId: "scene-1",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: CURRENT_PROJECT_VERSION,
	};
}

async function waitFor({ condition }: { condition: () => boolean }) {
	const deadline = Date.now() + 2000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(1);
	}
}

let service: StorageService;
let currentName = "";
const managers: SaveManager[] = [];

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	service = new StorageService();
	currentName = "edited once";
	spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	for (const manager of managers.splice(0)) manager.stop();
	mock.restore();
});

// Do not leave this file's data behind for the next test file.
afterAll(() => {
	globalThis.indexedDB = new IDBFactory();
});

function createManager() {
	const sceneListeners = new Set<() => void>();
	const reporter = {
		saveFailed: mock((_args: { error: unknown }) => {}),
		saveRecovered: mock(() => {}),
		dismissFailure: mock(() => {}),
	};
	const manager = new SaveManager({
		editor: {
			scenes: {
				subscribe: (listener: () => void) => {
					sceneListeners.add(listener);
					return () => sceneListeners.delete(listener);
				},
			},
			timeline: { subscribe: () => () => {} },
			project: {
				getActiveOrNull: () => ({ id: "p1" }),
				getIsLoading: () => false,
				getMigrationState: () => ({ isMigrating: false }),
				saveCurrentProject: () =>
					service.saveProject({ project: buildProject({ name: currentName }) }),
			},
		},
		debounceMs: 1,
		reporter,
		getRetryDelayMs: () => 60_000,
	});
	managers.push(manager);
	manager.start();
	return {
		manager,
		reporter,
		edit: () => {
			for (const listener of sceneListeners) listener();
		},
	};
}

async function storedName() {
	return (await service.loadProject({ id: "p1" }))?.project.metadata.name;
}

describe("autosave against a storage that refuses writes", () => {
	test("a rejected write leaves the project dirty and the next change persists it", async () => {
		const { manager, reporter, edit } = createManager();
		spyOn(IndexedDBAdapter.prototype, "set").mockImplementationOnce(async () => {
			throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
		});

		edit();
		await waitFor({
			condition: () => reporter.saveFailed.mock.calls.length === 1,
		});
		expect(manager.getIsDirty()).toBe(true);
		expect(await storedName()).toBeUndefined();

		currentName = "edited twice";
		edit();
		await waitFor({ condition: () => !manager.getIsDirty() });

		expect(await storedName()).toBe("edited twice");
		expect(reporter.saveRecovered).toHaveBeenCalledTimes(1);
	});

	test("a write that fails only when the transaction commits is not mistaken for a save", async () => {
		const { manager, reporter, edit } = createManager();
		const originalPut = IDBObjectStore.prototype.put;
		let abortNextCommit = true;
		spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
			this: IDBObjectStore,
			...args: Parameters<IDBObjectStore["put"]>
		) {
			const request = originalPut.apply(this, args);
			if (abortNextCommit) {
				abortNextCommit = false;
				// The request itself succeeds; the commit is what the browser refuses.
				request.addEventListener("success", () => this.transaction.abort());
			}
			return request;
		});

		edit();
		await waitFor({
			condition: () => reporter.saveFailed.mock.calls.length === 1,
		});
		expect(manager.getIsDirty()).toBe(true);
		expect(await storedName()).toBeUndefined();

		await manager.flush();

		expect(manager.getIsDirty()).toBe(false);
		expect(await storedName()).toBe("edited once");
	});
});
