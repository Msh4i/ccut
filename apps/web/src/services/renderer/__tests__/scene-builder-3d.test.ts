import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import {
	cameraElement,
	cameraTrack,
	sceneTracks,
	seconds,
	trackerData,
	videoElement,
} from "@/scene3d/render/__tests__/fixtures";
import type { GraphicElement, GraphicTrack } from "@/timeline";
import { CameraRigNode } from "../nodes/camera-rig-node";
import { GraphicNode } from "../nodes/graphic-node";
import { TrackPointsNode } from "../nodes/solved-points-node";
import { VideoNode } from "../nodes/video-node";
import {
	buildScene,
	isDrawableGraphicDefinition,
	NULL_GRAPHIC_DEFINITION_ID,
} from "../scene-builder";

const MEDIA: MediaAsset[] = [
	{
		id: "clip-media",
		name: "clip.mp4",
		type: "video",
		file: new File([], "clip.mp4"),
		url: "blob:clip",
	},
];

function graphic({ id, definitionId }: { id: string; definitionId: string }): GraphicElement {
	return {
		id,
		name: id,
		type: "graphic",
		definitionId,
		startTime: seconds(0),
		trimStart: seconds(0),
		trimEnd: seconds(0),
		duration: seconds(2),
		params: {},
	};
}

function graphicTrack(elements: GraphicElement[]): GraphicTrack {
	return { id: "graphics", name: "graphics", type: "graphic", elements, hidden: false };
}

function build(tracks: ReturnType<typeof sceneTracks>) {
	return buildScene({
		canvasSize: { width: 1080, height: 1920 },
		tracks,
		mediaAssets: MEDIA,
		duration: seconds(2),
		background: { type: "color", color: "transparent" },
	});
}

describe("buildScene for 3D", () => {
	test("Null layers and unknown graphic definitions draw nothing; known shapes do", () => {
		expect(isDrawableGraphicDefinition(NULL_GRAPHIC_DEFINITION_ID)).toBe(false);
		expect(isDrawableGraphicDefinition("no-such-shape")).toBe(false);
		expect(isDrawableGraphicDefinition("rectangle")).toBe(true);
		const root = build(
			sceneTracks({
				overlay: [
					graphicTrack([
						graphic({ id: "null", definitionId: NULL_GRAPHIC_DEFINITION_ID }),
						graphic({ id: "future", definitionId: "no-such-shape" }),
						graphic({ id: "solid", definitionId: "rectangle" }),
					]),
				],
			}),
		);
		const graphics = root.children.filter((node) => node instanceof GraphicNode);
		expect(graphics).toHaveLength(1);
	});

	test("camera elements draw nothing; one camera rig closes the scene", () => {
		const root = build(
			sceneTracks({ overlay: [cameraTrack({ elements: [cameraElement()] })] }),
		);
		expect(root.children.map((node) => node.constructor.name)).toEqual([
			"VideoNode",
			"CameraRigNode",
		]);
		const rig = root.children[root.children.length - 1];
		expect(rig instanceof CameraRigNode && rig.params.tracks.overlay.length).toBe(1);
	});

	test("Render Track Points adds a layer right above its clip, only when switched on", () => {
		const off = build(sceneTracks());
		expect(off.children.some((node) => node instanceof TrackPointsNode)).toBe(false);
		const on = build(
			sceneTracks({
				main: [
					videoElement({ cameraTracker: trackerData({ settings: { renderTrackPoints: true } }) }),
				],
			}),
		);
		expect(on.children[0] instanceof VideoNode).toBe(true);
		expect(on.children[1] instanceof TrackPointsNode).toBe(true);
	});

	test("picture nodes carry the element's params so resolve can read the 3D switch", () => {
		const root = build(
			sceneTracks({
				main: [videoElement({ params: { "transform3d.enabled": true } })],
			}),
		);
		const [video] = root.children;
		expect(video instanceof VideoNode && video.params.elementParams?.["transform3d.enabled"]).toBe(
			true,
		);
	});
});
