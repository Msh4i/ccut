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
import { IDBFactory } from "fake-indexeddb";
import type { TProject } from "@/project/types";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { v5Project } from "@/services/storage/migrations/__tests__/fixtures";
import { StorageService } from "@/services/storage/service";
import type { SoundEffect } from "@/sounds/types";
import type { AudioElement } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildProject({
	id,
	name = `Project ${id}`,
	updatedAt = new Date("2026-01-01T10:00:00.000Z"),
	audio = [],
}: {
	id: string;
	name?: string;
	updatedAt?: Date;
	audio?: AudioElement[];
}): TProject {
	const createdAt = new Date("2025-12-31T09:00:00.000Z");
	return {
		metadata: {
			id,
			name,
			thumbnail: "data:image/png;base64,abc",
			duration: mediaTime({ ticks: 360000 }),
			createdAt,
			updatedAt,
		},
		scenes: [
			{
				id: `${id}-scene`,
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [],
					main: {
						id: `${id}-main`,
						name: "Main",
						type: "video",
						elements: [],
						muted: false,
						hidden: false,
					},
					audio: [
						{
							id: `${id}-audio`,
							name: "Audio",
							type: "audio",
							elements: audio,
							muted: false,
						},
					],
				},
				bookmarks: [{ time: mediaTime({ ticks: 120000 }), note: "intro" }],
				createdAt,
				updatedAt,
			},
		],
		currentSceneId: `${id}-scene`,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: CURRENT_PROJECT_VERSION,
		timelineViewState: {
			zoomLevel: 2,
			scrollLeft: 40,
			playheadTime: mediaTime({ ticks: 60000 }),
		},
	};
}

function buildAudioElement(): AudioElement {
	return {
		id: "song",
		name: "Song",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-song",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 240000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

function createRawProjectsAdapter() {
	return new IndexedDBAdapter<Record<string, unknown>>({
		dbName: "video-editor-projects",
		storeName: "projects",
		version: 1,
	});
}

let service: StorageService;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	service = new StorageService();
});

// Restore every spy even when an assertion throws. Bun hands out the SAME mock
// when a method is spied twice, so a console spy left behind here would also
// count the calls of later tests (and files) that spy on console again.
afterEach(() => {
	mock.restore();
});

// Do not leave this file's data behind for the next test file.
afterAll(() => {
	globalThis.indexedDB = new IDBFactory();
});

describe("StorageService projects", () => {
	test("saveProject then loadProject returns the same project", async () => {
		const project = buildProject({ id: "p1", name: "Çalışma 🎬" });

		await service.saveProject({ project });
		const loaded = await service.loadProject({ id: "p1" });

		expect(loaded?.project).toEqual(project);
	});

	test("loadProject returns null for an unknown id", async () => {
		expect(await service.loadProject({ id: "missing" })).toBeNull();
	});

	test("saveProject overwrites the previous version of the same project", async () => {
		await service.saveProject({
			project: buildProject({ id: "p1", name: "old" }),
		});
		await service.saveProject({
			project: buildProject({ id: "p1", name: "new" }),
		});

		const all = await service.loadAllProjectsMetadata();

		expect(all.map((entry) => entry.name)).toEqual(["new"]);
	});

	test("saveProject drops decoded audio buffers, which IndexedDB cannot clone", async () => {
		// A function stands in for an AudioBuffer: putting it into IndexedDB would
		// throw a DataCloneError unless saveProject removes it first.
		const withBuffer = Object.assign(buildAudioElement(), { buffer: () => 1 });

		await service.saveProject({
			project: buildProject({ id: "p1", audio: [withBuffer] }),
		});
		const loaded = await service.loadProject({ id: "p1" });

		const [element] =
			loaded?.project.scenes[0]?.tracks.audio[0]?.elements ?? [];
		expect(element?.id).toBe("song");
		expect(element).not.toHaveProperty("buffer");
	});

	test("deleteProject removes only that project", async () => {
		await service.saveProject({ project: buildProject({ id: "keep" }) });
		await service.saveProject({ project: buildProject({ id: "drop" }) });

		await service.deleteProject({ id: "drop" });

		expect(await service.loadProject({ id: "drop" })).toBeNull();
		expect(
			(await service.loadProject({ id: "keep" }))?.project.metadata.id,
		).toBe("keep");
	});

	test("loadAllProjectsMetadata lists newest first", async () => {
		await service.saveProject({
			project: buildProject({
				id: "old",
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			}),
		});
		await service.saveProject({
			project: buildProject({
				id: "newest",
				updatedAt: new Date("2026-03-01T00:00:00.000Z"),
			}),
		});
		await service.saveProject({
			project: buildProject({
				id: "middle",
				updatedAt: new Date("2026-02-01T00:00:00.000Z"),
			}),
		});

		const metadata = await service.loadAllProjectsMetadata();

		expect(metadata.map((entry) => entry.id)).toEqual([
			"newest",
			"middle",
			"old",
		]);
		expect(metadata[0]).toEqual({
			id: "newest",
			name: "Project newest",
			thumbnail: "data:image/png;base64,abc",
			duration: mediaTime({ ticks: 360000 }),
			createdAt: new Date("2025-12-31T09:00:00.000Z"),
			updatedAt: new Date("2026-03-01T00:00:00.000Z"),
		});
	});

	test("loadAllProjects returns full projects newest first", async () => {
		await service.saveProject({
			project: buildProject({
				id: "a",
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			}),
		});
		await service.saveProject({
			project: buildProject({
				id: "b",
				updatedAt: new Date("2026-02-01T00:00:00.000Z"),
			}),
		});

		const projects = await service.loadAllProjects();

		expect(projects.map((project) => project.metadata.id)).toEqual(["b", "a"]);
		expect(projects[0]?.scenes).toHaveLength(1);
	});

	test("empty storage lists nothing", async () => {
		expect(await service.loadAllProjectsMetadata()).toEqual([]);
		expect(await service.loadAllProjects()).toEqual([]);
	});
});

describe("StorageService with damaged or old data", () => {
	test("skips entries without metadata instead of failing the whole list", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		await service.saveProject({ project: buildProject({ id: "good" }) });
		await createRawProjectsAdapter().set({
			key: "damaged",
			value: { version: CURRENT_PROJECT_VERSION },
		});

		const metadata = await service.loadAllProjectsMetadata();
		const damaged = await service.loadProject({ id: "damaged" });

		expect(metadata.map((entry) => entry.id)).toEqual(["good"]);
		expect(damaged).toBeNull();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	test("normalizes legacy and broken bookmarks on load", async () => {
		const stored = buildProject({ id: "p1" });
		await createRawProjectsAdapter().set({
			key: "p1",
			value: {
				metadata: {
					...stored.metadata,
					createdAt: stored.metadata.createdAt.toISOString(),
					updatedAt: stored.metadata.updatedAt.toISOString(),
				},
				scenes: [
					{
						id: "s",
						name: "Main scene",
						isMain: true,
						tracks: stored.scenes[0]?.tracks,
						bookmarks: [
							12.4,
							{ time: 7.6, note: "kept" },
							"junk",
							null,
							{ note: "no time" },
						],
						createdAt: stored.metadata.createdAt.toISOString(),
						updatedAt: stored.metadata.updatedAt.toISOString(),
					},
				],
				currentSceneId: "s",
				settings: stored.settings,
				version: CURRENT_PROJECT_VERSION,
			},
		});

		const loaded = await service.loadProject({ id: "p1" });

		expect(loaded?.project.scenes[0]?.bookmarks).toEqual([
			{ time: mediaTime({ ticks: 12 }) },
			{ time: mediaTime({ ticks: 8 }), note: "kept" },
		]);
	});

	test("migrates a project saved by an older version when it is loaded", async () => {
		await createRawProjectsAdapter().set({
			key: v5Project.id,
			value: v5Project,
		});

		const loaded = await service.loadProject({ id: v5Project.id });
		const stored = await createRawProjectsAdapter().get(v5Project.id);

		expect(loaded?.project.version).toBe(CURRENT_PROJECT_VERSION);
		expect(loaded?.project.metadata.name).toBe("My V5 Project");
		expect(loaded?.project.scenes.map((scene) => scene.name)).toEqual([
			"Main scene",
			"Intro",
		]);
		expect(stored?.version).toBe(CURRENT_PROJECT_VERSION);
	});

	test("a failed migration pass is retried on the next call", async () => {
		class BrokenFactory extends IDBFactory {
			override open(): never {
				throw new Error("storage unavailable");
			}
		}
		globalThis.indexedDB = new BrokenFactory();
		await expect(service.loadProject({ id: "p1" })).rejects.toThrow(
			"storage unavailable",
		);

		globalThis.indexedDB = new IDBFactory();
		await service.saveProject({ project: buildProject({ id: "p1" }) });

		expect((await service.loadProject({ id: "p1" }))?.project.metadata.id).toBe(
			"p1",
		);
	});
});

function buildSound({ id }: { id: number }): SoundEffect {
	return {
		id,
		name: `Sound ${id}`,
		description: "",
		url: "https://example.test/s.mp3",
		duration: 1,
		filesize: 1,
		type: "mp3",
		channels: 2,
		bitrate: 128,
		bitdepth: 16,
		samplerate: 44100,
		username: "someone",
		tags: ["tag"],
		license: "CC0",
		created: "2026-01-01",
		downloads: 0,
		rating: 0,
		ratingCount: 0,
	};
}

describe("StorageService saved sounds", () => {
	test("saves, lists and removes sounds", async () => {
		await service.saveSoundEffect({ soundEffect: buildSound({ id: 1 }) });
		await service.saveSoundEffect({ soundEffect: buildSound({ id: 2 }) });
		await service.removeSavedSound({ soundId: 1 });

		const saved = await service.loadSavedSounds();

		expect(saved.sounds.map((sound) => sound.id)).toEqual([2]);
	});

	test("a failed read does not wipe the saved list when saving another sound", async () => {
		await service.saveSoundEffect({ soundEffect: buildSound({ id: 1 }) });
		const get = spyOn(IndexedDBAdapter.prototype, "get").mockImplementationOnce(
			async () => {
				throw new Error("read failed");
			},
		);
		const set = spyOn(IndexedDBAdapter.prototype, "set");

		await expect(
			service.saveSoundEffect({ soundEffect: buildSound({ id: 2 }) }),
		).rejects.toThrow("read failed");

		expect(set).not.toHaveBeenCalled();
		get.mockRestore();
		set.mockRestore();
		expect((await service.loadSavedSounds()).sounds.map((s) => s.id)).toEqual([1]);
	});

	test("a failed read does not wipe the saved list when removing a sound", async () => {
		await service.saveSoundEffect({ soundEffect: buildSound({ id: 1 }) });
		await service.saveSoundEffect({ soundEffect: buildSound({ id: 2 }) });
		const get = spyOn(IndexedDBAdapter.prototype, "get").mockImplementationOnce(
			async () => {
				throw new Error("read failed");
			},
		);
		const set = spyOn(IndexedDBAdapter.prototype, "set");

		await expect(service.removeSavedSound({ soundId: 1 })).rejects.toThrow(
			"read failed",
		);

		expect(set).not.toHaveBeenCalled();
		get.mockRestore();
		set.mockRestore();
		expect((await service.loadSavedSounds()).sounds).toHaveLength(2);
	});

	test("loadSavedSounds still shows an empty list when the read fails", async () => {
		const get = spyOn(IndexedDBAdapter.prototype, "get").mockImplementationOnce(
			async () => {
				throw new Error("read failed");
			},
		);
		spyOn(console, "error").mockImplementation(() => {});

		const saved = await service.loadSavedSounds();
		get.mockRestore();

		expect(saved.sounds).toEqual([]);
	});
});
