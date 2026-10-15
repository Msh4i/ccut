import { describe, expect, test } from "bun:test";
import type { CameraElement, CameraTrack, SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import type { Target } from "@/scene3d/types";
import { CAMERA_TRACKER_NOT_READY_MESSAGE } from "../../session";
import {
	buildTargetMenu,
	hasCameraForClipAt,
	menuCommand,
	targetMenuSections,
	type TargetMenuItem,
} from "../menu-model";

const sec = (seconds: number) => mediaTimeFromSeconds({ seconds });

const ready = {
	apiReady: true,
	hasSolve: true,
	busy: false,
	selectedCount: 3,
	hasCameraAtPlayhead: false,
	imageCount: 2,
};

function byId(items: TargetMenuItem[]): Record<string, TargetMenuItem> {
	return Object.fromEntries(items.map((item) => [item.id, item]));
}

describe("the target's context menu", () => {
	test("every AE item, in order, grouped; 'and Camera' while no camera of this clip covers the playhead", () => {
		const items = buildTargetMenu(ready);
		expect(items.map((item) => item.label)).toEqual([
			"Create Text and Camera",
			"Create Solid and Camera",
			"Create Null and Camera",
			"Create Image and Camera...",
			"Create Multiple Text Layers",
			"Create Multiple Solids",
			"Create Multiple Nulls",
			"Set Ground Plane and Origin",
			"Delete Selected Points",
		]);
		expect(items.map((item) => item.group)).toEqual([
			"create", "create", "create", "create", "multiple", "multiple", "multiple", "scene", "delete",
		]);
		expect(items.every((item) => item.enabled && item.reason === null)).toBe(true);
		expect(byId(items)["delete-points"].hint).toBe("across time");
		expect(byId(items)["delete-points"].destructive).toBe(true);
		expect(byId(items)["create-multiple-text"].hint).toBe("3");
	});

	test("with a camera covering the playhead: no suffix", () => {
		const labels = buildTargetMenu({ ...ready, hasCameraAtPlayhead: true }).map((item) => item.label);
		expect(labels.slice(0, 4)).toEqual(["Create Text", "Create Solid", "Create Null", "Create Image..."]);
	});

	test("Create Multiple needs two or more selected points", () => {
		const items = byId(buildTargetMenu({ ...ready, selectedCount: 1 }));
		for (const id of ["create-multiple-text", "create-multiple-solid", "create-multiple-null"]) {
			expect(items[id].enabled).toBe(false);
			expect(items[id].reason).toBe("Select two or more track points to create one layer per point.");
		}
		expect(items["create-text"].enabled).toBe(true);
		expect(items["delete-points"].enabled).toBe(true);
	});

	test("Create Image... needs an image in the project", () => {
		const item = byId(buildTargetMenu({ ...ready, imageCount: 0 }))["create-image"];
		expect(item.enabled).toBe(false);
		expect(item.reason).toBe("Add an image to the project to create an image layer.");
	});

	test("no engine, no solve, a running job or no selection disable everything with the reason", () => {
		const cases: Array<[Partial<typeof ready>, string]> = [
			[{ apiReady: false }, CAMERA_TRACKER_NOT_READY_MESSAGE],
			[{ hasSolve: false }, "Solve the camera first."],
			[{ busy: true }, "Wait until Track Camera finishes."],
			[{ selectedCount: 0 }, "Select track points first."],
		];
		for (const [patch, reason] of cases) {
			const items = buildTargetMenu({ ...ready, ...patch });
			expect(items).toHaveLength(9);
			for (const item of items) {
				expect(item.enabled).toBe(false);
				expect(item.reason).toBe(reason);
			}
		}
	});
});

describe("targetMenuSections", () => {
	test("groups become sections with their reasons under them, each once", () => {
		const { commonReason, sections } = targetMenuSections(buildTargetMenu({ ...ready, selectedCount: 1, imageCount: 0 }));
		expect(commonReason).toBeNull();
		expect(sections.map((section) => section.items.length)).toEqual([4, 3, 1, 1]);
		expect(sections[0].reasons).toEqual(["Add an image to the project to create an image layer."]);
		expect(sections[1].reasons).toEqual(["Select two or more track points to create one layer per point."]);
		expect(sections[2].reasons).toEqual([]);
	});

	test("a reason that disables everything is said once, at the top", () => {
		const { commonReason, sections } = targetMenuSections(buildTargetMenu({ ...ready, busy: true }));
		expect(commonReason).toBe("Wait until Track Camera finishes.");
		expect(sections.every((section) => section.reasons.length === 0)).toBe(true);
		expect(targetMenuSections([])).toEqual({ commonReason: null, sections: [] });
	});
});

describe("menu commands", () => {
	const target: Target = { center: [1, 2, 3], normal: [0, -1, 0], radius: 5 };
	const base = { elementId: "video-1", target, selection: [4, 9], frame: 12 };

	test("create items carry the target, the selection and the frame", () => {
		expect(menuCommand({ ...base, itemId: "create-text" })).toEqual({
			kind: "create",
			args: { elementId: "video-1", kind: "text", multiple: false, target, trackIds: [4, 9], frame: 12 },
		});
		expect(menuCommand({ ...base, itemId: "create-multiple-null" })).toEqual({
			kind: "create",
			args: { elementId: "video-1", kind: "null", multiple: true, target, trackIds: [4, 9], frame: 12 },
		});
	});

	test("Create Image... asks for a picture first, then creates with it", () => {
		expect(menuCommand({ ...base, itemId: "create-image" })).toEqual({ kind: "pick-image" });
		expect(menuCommand({ ...base, itemId: "create-image", mediaId: "img-1" })).toEqual({
			kind: "create",
			args: { elementId: "video-1", kind: "image", multiple: false, target, trackIds: [4, 9], frame: 12, mediaId: "img-1" },
		});
	});

	test("ground plane and delete", () => {
		expect(menuCommand({ ...base, itemId: "set-ground-plane" })).toEqual({ kind: "ground-plane", target });
		expect(menuCommand({ ...base, itemId: "delete-points" })).toEqual({ kind: "delete", trackIds: [4, 9] });
	});
});

describe("hasCameraForClipAt", () => {
	function camera({ id, source, start, duration, hidden }: { id: string; source: string; start: number; duration: number; hidden?: boolean }): CameraElement {
		return {
			id,
			type: "camera",
			name: id,
			sourceElementId: source,
			startTime: sec(start),
			duration: sec(duration),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			params: {},
			hidden,
		};
	}
	function scene(cameras: CameraElement[]): SceneTracks {
		const cameraTrack: CameraTrack = { id: "cam-track", name: "Camera", type: "camera", elements: cameras, hidden: false };
		const video: VideoElement = {
			id: "video-1", type: "video", name: "v", mediaId: "m", startTime: ZERO_MEDIA_TIME, duration: sec(10),
			trimStart: ZERO_MEDIA_TIME, trimEnd: ZERO_MEDIA_TIME, params: {},
		};
		const main: VideoTrack = { id: "main", name: "Main", type: "video", elements: [video], muted: false, hidden: false };
		return { main, overlay: [cameraTrack], audio: [] };
	}

	test("a visible camera of this clip whose span covers the time", () => {
		const tracks = scene([camera({ id: "c1", source: "video-1", start: 2, duration: 4 })]);
		expect(hasCameraForClipAt({ tracks, sourceElementId: "video-1", time: sec(3) })).toBe(true);
		expect(hasCameraForClipAt({ tracks, sourceElementId: "video-1", time: sec(2) })).toBe(true);
		expect(hasCameraForClipAt({ tracks, sourceElementId: "video-1", time: sec(6) })).toBe(false);
		expect(hasCameraForClipAt({ tracks, sourceElementId: "video-1", time: sec(1) })).toBe(false);
		expect(hasCameraForClipAt({ tracks, sourceElementId: "video-2", time: sec(3) })).toBe(false);
	});

	test("a hidden camera, or one on a hidden track, does not count", () => {
		const hiddenCamera = scene([camera({ id: "c1", source: "video-1", start: 0, duration: 10, hidden: true })]);
		expect(hasCameraForClipAt({ tracks: hiddenCamera, sourceElementId: "video-1", time: sec(3) })).toBe(false);
		const visible = scene([camera({ id: "c1", source: "video-1", start: 0, duration: 10 })]);
		const hiddenTrack: SceneTracks = { ...visible, overlay: visible.overlay.map((track) => ({ ...track, hidden: true })) };
		expect(hasCameraForClipAt({ tracks: hiddenTrack, sourceElementId: "video-1", time: sec(3) })).toBe(false);
	});
});
