import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { TProject } from "@/project/types";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { StorageService } from "@/services/storage/service";
import type { SerializedProject } from "@/services/storage/types";
import { paramsFromTransform3D } from "@/scene3d/layer-params";
import type { GraphicElement, OverlayTrack, SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import {
	cameraLayer,
	cameraTrack,
	graphicTrack,
	sceneOf,
	sec,
	textLayer,
	textTrack,
	videoClip,
} from "@/tracking/camera3d/engine/__tests__/editor-harness";
import { trackerData } from "@/tracking/camera3d/engine/__tests__/fixtures";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

const PLACED = paramsFromTransform3D({
	position: [12.5, -3.25, 840.125],
	orientationDeg: [-90, 12.5, 0.25],
	rotationDeg: [0, 0, 15],
	scale: [0.4321, 0.4321, 0.4321],
});

function nullLayer(): GraphicElement {
	return {
		id: "null-1",
		type: "graphic",
		name: "Track Null 1",
		definitionId: "null",
		startTime: sec(0),
		duration: sec(4),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { ...PLACED },
	};
}

function buildProject({ main, overlay = [] }: { main: VideoElement[]; overlay?: OverlayTrack[] }): TProject {
	const createdAt = new Date("2025-12-31T09:00:00.000Z");
	const updatedAt = new Date("2026-01-01T10:00:00.000Z");
	return {
		metadata: {
			id: "p1",
			name: "Project",
			thumbnail: "",
			duration: mediaTime({ ticks: 360000 }),
			createdAt,
			updatedAt,
		},
		scenes: [
			{
				id: "scene",
				name: "Main scene",
				isMain: true,
				tracks: sceneOf({ main, overlay }),
				bookmarks: [],
				createdAt,
				updatedAt,
			},
		],
		currentSceneId: "scene",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		version: CURRENT_PROJECT_VERSION,
		timelineViewState: { zoomLevel: 2, scrollLeft: 0, playheadTime: ZERO_MEDIA_TIME },
	};
}

function silenceWarnings() {
	return spyOn(console, "warn").mockImplementation(() => {});
}

let service: StorageService;
let warn: ReturnType<typeof silenceWarnings> | null = null;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	service = new StorageService();
	warn = silenceWarnings();
});

afterEach(() => {
	warn?.mockRestore();
	warn = null;
});

afterAll(() => {
	globalThis.indexedDB = new IDBFactory();
});

async function roundTrip(project: TProject): Promise<SceneTracks> {
	await service.saveProject({ project });
	const loaded = await service.loadProject({ id: "p1" });
	if (!loaded) throw new Error("project did not load");
	return loaded.project.scenes[0].tracks;
}

/** The project record as IndexedDB holds it, read past the service. */
async function storedRecord(): Promise<SerializedProject | null> {
	const adapter = new IndexedDBAdapter<SerializedProject>({
		dbName: "video-editor-projects",
		storeName: "projects",
		version: 1,
	});
	return adapter.get("p1");
}

describe("Track Camera data in a saved project", () => {
	test("tracker data, the camera layer, 3D params and a null survive save and load", async () => {
		const data = trackerData({ overrides: { deletedTrackIds: [2], stale: "solve", groundPlaneSet: true } });
		const overlay: OverlayTrack[] = [
			cameraTrack({ elements: [cameraLayer({ sourceElementId: "clip" })] }),
			textTrack({ elements: [textLayer({ params: { ...PLACED } })] }),
			graphicTrack({ elements: [nullLayer()] }),
		];
		const tracks = await roundTrip(buildProject({ main: [videoClip({ extra: { cameraTracker: data } })], overlay }));
		const clip = tracks.main.elements[0];
		expect(clip.type === "video" && clip.cameraTracker).toEqual(data);
		expect(tracks.overlay[0]).toEqual(overlay[0]);
		expect(tracks.overlay[1].elements[0].params).toEqual({ content: "Hello", ...PLACED });
		expect(tracks.overlay[2].elements[0]).toEqual(nullLayer());
	});

	test("a clip that was never tracked loads without the field", async () => {
		const tracks = await roundTrip(buildProject({ main: [videoClip()] }));
		expect("cameraTracker" in tracks.main.elements[0]).toBe(false);
	});

	test("hostile tracker data does not reach the clip on load, the clip stays, and the stored project is not rewritten", async () => {
		const hostile = videoClip({ id: "bad" });
		Reflect.set(hostile, "cameraTracker", {
			...trackerData(),
			sourceStart: Number.NaN,
		});
		const overflowing = videoClip({ id: "huge", start: 4 });
		Reflect.set(overflowing, "cameraTracker", {
			...trackerData(),
			tracks: { ...trackerData().tracks, frameCount: 1e9 },
		});
		const garbage = videoClip({ id: "garbage", start: 8 });
		Reflect.set(garbage, "cameraTracker", "<script>");
		const project = buildProject({
			main: [hostile, overflowing, garbage],
			overlay: [cameraTrack({ elements: [cameraLayer({ sourceElementId: "missing-clip" })] })],
		});
		await service.saveProject({ project });
		const before = JSON.stringify(await storedRecord());

		const loaded = await service.loadProject({ id: "p1" });
		const tracks = loaded?.project.scenes[0].tracks;
		expect(tracks?.main.elements.map((element) => element.id)).toEqual(["bad", "huge", "garbage"]);
		for (const element of tracks?.main.elements ?? []) {
			// consumers read `cameraTracker`: it is absent, so they see an untracked clip
			expect("cameraTracker" in element).toBe(false);
			expect("unusableCameraTracker" in element).toBe(true);
		}
		// the camera whose source is missing stays (it renders with the default camera)
		expect(tracks?.overlay[0].elements[0]).toMatchObject({ type: "camera", sourceElementId: "missing-clip" });
		// load never writes
		expect(JSON.stringify(await storedRecord())).toBe(before);
	});
});

describe("one hostile project does not break loading", () => {
	test("a clip id that cannot be turned into text: loadProject and loadAllProjects still return the project, the record set aside", async () => {
		// String() of this id throws a TypeError
		const hostileId: unknown = JSON.parse('{"toString":1,"valueOf":1}');
		const clip = videoClip();
		Reflect.set(clip, "id", hostileId);
		Reflect.set(clip, "cameraTracker", "<script>");
		await service.saveProject({ project: buildProject({ main: [clip] }) });

		const loaded = await service.loadProject({ id: "p1" });
		const element = loaded?.project.scenes[0].tracks.main.elements[0];
		expect(element && "cameraTracker" in element).toBe(false);
		expect(element && Reflect.get(element, "unusableCameraTracker")).toBe("<script>");
		const all = await service.loadAllProjects();
		expect(all.map((project) => project.metadata.id)).toEqual(["p1"]);
	});
});

describe("a record this version cannot read survives open, edit, save", () => {
	/** A project whose only clip carries `raw` as stored, written past the editor's types. */
	async function storeWith({ raw }: { raw: unknown }): Promise<void> {
		const clip = videoClip({ id: "tracked" });
		Reflect.set(clip, "cameraTracker", raw);
		await service.saveProject({ project: buildProject({ main: [clip] }) });
	}

	/** Opens the project, renames the clip (any edit), saves it the way the autosave does. */
	async function openEditSave(): Promise<void> {
		const loaded = await service.loadProject({ id: "p1" });
		if (!loaded) throw new Error("project did not load");
		const [scene] = loaded.project.scenes;
		const [clip] = scene.tracks.main.elements;
		const edited = { ...clip, name: "edited" };
		const tracks = { ...scene.tracks, main: { ...scene.tracks.main, elements: [edited] } };
		await service.saveProject({
			project: { ...loaded.project, scenes: [{ ...scene, tracks }, ...loaded.project.scenes.slice(1)] },
		});
	}

	async function storedClip(): Promise<Record<string, unknown>> {
		const record = await storedRecord();
		const clip: unknown = record?.scenes[0].tracks.main.elements[0];
		if (!clip || typeof clip !== "object") throw new Error("no stored clip");
		return Object.fromEntries(Object.entries(clip));
	}

	const unreadable: Array<[string, () => unknown]> = [
		["a record of a newer version", () => ({ ...trackerData(), version: 2, futureOnly: { lens: [1, 2, 3], nested: { a: "b" } } })],
		["a damaged record", () => ({ ...trackerData(), tracks: { ...trackerData().tracks, xy: "%%%%" } })],
		["a record over the size limit", () => ({ ...trackerData(), tracks: { ...trackerData().tracks, frameCount: 1e9 } })],
		["a string", () => "<script>"],
		["null", () => null],
	];

	for (const [name, make] of unreadable) {
		test(`${name} is written back unchanged`, async () => {
			const raw = make();
			await storeWith({ raw });
			await openEditSave();
			const clip = await storedClip();
			expect(clip.name).toBe("edited");
			expect(clip.cameraTracker).toEqual(raw);
			expect(JSON.stringify(clip.cameraTracker)).toBe(JSON.stringify(raw));
			expect("unusableCameraTracker" in clip).toBe(false);
		});
	}

	test("it stays through any number of open-edit-save rounds", async () => {
		const raw = { ...trackerData(), version: 2 };
		await storeWith({ raw });
		for (let round = 0; round < 3; round++) await openEditSave();
		expect((await storedClip()).cameraTracker).toEqual(raw);
	});

	test("the editor sees an untracked clip meanwhile", async () => {
		await storeWith({ raw: { ...trackerData(), version: 2 } });
		const loaded = await service.loadProject({ id: "p1" });
		const clip = loaded?.project.scenes[0].tracks.main.elements[0];
		expect(clip && "cameraTracker" in clip).toBe(false);
	});

	test("tracking the clip again replaces the kept record: the new data is saved, nothing is left over", async () => {
		await storeWith({ raw: { ...trackerData(), version: 2 } });
		const loaded = await service.loadProject({ id: "p1" });
		if (!loaded) throw new Error("project did not load");
		const [scene] = loaded.project.scenes;
		const fresh = trackerData({ overrides: { stale: "solve" } });
		const retracked = { ...videoOnly(scene.tracks.main.elements[0]), cameraTracker: fresh };
		const tracks = { ...scene.tracks, main: { ...scene.tracks.main, elements: [retracked] } };
		await service.saveProject({ project: { ...loaded.project, scenes: [{ ...scene, tracks }] } });
		const clip = await storedClip();
		expect(clip.cameraTracker).toEqual(fresh);
		expect("unusableCameraTracker" in clip).toBe(false);
	});

	test("a readable record still goes through load and save as before", async () => {
		const data = trackerData({ overrides: { deletedTrackIds: [2], stale: "solve" } });
		await storeWith({ raw: data });
		await openEditSave();
		expect((await storedClip()).cameraTracker).toEqual(data);
	});

	test("a project of untracked clips is stored with exactly the keys it had", async () => {
		await service.saveProject({ project: buildProject({ main: [videoClip({ id: "plain" })] }) });
		const before = JSON.stringify((await storedClip()));
		await openEditSave();
		const after = await storedClip();
		expect(Object.keys(after).sort()).toEqual(Object.keys(JSON.parse(before)).sort());
	});
});

function videoOnly(element: TimelineElement): VideoElement {
	if (element.type !== "video") throw new Error("expected a video clip");
	return element;
}
