import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { TProject } from "@/project/types";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { StorageService } from "@/services/storage/service";
import type { UploadAudioElement, VideoElement } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";

function ticks(values: number[]): MediaTime[] {
	return values.map((ticks) => mediaTime({ ticks }));
}

function audioElement(beats: unknown): UploadAudioElement {
	const element: UploadAudioElement = {
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
	if (beats !== undefined) Reflect.set(element, "beats", beats);
	return element;
}

function videoElement(beats: unknown): VideoElement {
	const element: VideoElement = {
		id: "clip",
		name: "Clip",
		type: "video",
		mediaId: "media-clip",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 240000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
	if (beats !== undefined) Reflect.set(element, "beats", beats);
	return element;
}

function buildProject({
	main,
	audio,
}: {
	main: VideoElement[];
	audio: UploadAudioElement[];
}): TProject {
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
				tracks: {
					overlay: [],
					main: {
						id: "main",
						name: "Main",
						type: "video",
						elements: main,
						muted: false,
						hidden: false,
					},
					audio: [
						{ id: "audio", name: "Audio", type: "audio", elements: audio, muted: false },
					],
				},
				bookmarks: [],
				createdAt,
				updatedAt,
			},
		],
		currentSceneId: "scene",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: CURRENT_PROJECT_VERSION,
		timelineViewState: {
			zoomLevel: 2,
			scrollLeft: 0,
			playheadTime: ZERO_MEDIA_TIME,
		},
	};
}

let service: StorageService;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	service = new StorageService();
});

afterAll(() => {
	globalThis.indexedDB = new IDBFactory();
});

async function roundTrip(project: TProject) {
	await service.saveProject({ project });
	const loaded = await service.loadProject({ id: "p1" });
	if (!loaded) throw new Error("project did not load");
	return loaded.project.scenes[0].tracks;
}

describe("beats in a saved project", () => {
	test("valid beats survive a save and load unchanged", async () => {
		const beats = ticks([120, 60000, 120000, 239999]);
		const tracks = await roundTrip(
			buildProject({ main: [videoElement(beats)], audio: [audioElement(beats)] }),
		);
		expect(tracks.main.elements[0]).toMatchObject({ beats });
		expect(tracks.audio[0].elements[0]).toMatchObject({ beats });
	});

	test("a clip that was never analysed still has no beats", async () => {
		const tracks = await roundTrip(
			buildProject({ main: [videoElement(undefined)], audio: [audioElement(undefined)] }),
		);
		expect(tracks.audio[0].elements[0].beats).toBeUndefined();
	});

	test("corrupt beats in storage are repaired on load instead of crashing the editor", async () => {
		const tracks = await roundTrip(
			buildProject({
				main: [videoElement([900, Number.NaN, "x", 300, 300, -4, 1.5])],
				audio: [audioElement("not a list")],
			}),
		);
		expect(tracks.main.elements[0]).toMatchObject({ beats: ticks([300, 900]) });
		expect(tracks.audio[0].elements[0].beats).toBeUndefined();
	});

	test("an absurdly long beat list is cut down on load", async () => {
		const raw = Array.from({ length: 50_000 }, (_, i) => i * 10);
		const tracks = await roundTrip(
			buildProject({ main: [], audio: [audioElement(raw)] }),
		);
		expect(tracks.audio[0].elements[0].beats?.length).toBe(20_000);
	});
});
