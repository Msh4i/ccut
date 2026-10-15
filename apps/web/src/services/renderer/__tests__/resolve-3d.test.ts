import { describe, expect, test } from "bun:test";
import type { Transform } from "@/rendering";
import {
	cameraElement,
	cameraTrack,
	sceneTracks,
	seconds,
	trackerData,
	videoElement,
} from "@/scene3d/render/__tests__/fixtures";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { CameraRigNode } from "@/services/renderer/nodes/camera-rig-node";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { TrackPointsNode } from "@/services/renderer/nodes/solved-points-node";
import { resolveRenderTree } from "@/services/renderer/resolve";

const CANVAS = { width: 1080, height: 1920 };

function renderer(): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), CANVAS);
}

const IDENTITY: Transform = { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 };

function graphicNode(params: Record<string, number | boolean>) {
	return new GraphicNode({
		definitionId: "rectangle",
		params,
		elementParams: params,
		duration: seconds(2),
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: IDENTITY,
		opacity: 1,
	});
}

describe("resolve: 3D layers, camera, track points", () => {
	test("a picture element with the 3D switch resolves its 3D transform; a 2D one has none", async () => {
		const flat = graphicNode({});
		const layer = graphicNode({ "transform3d.enabled": true, "transform3d.positionZ": 75 });
		const root = new RootNode({ duration: 2 });
		root.add(flat).add(layer);
		await resolveRenderTree({ node: root, renderer: renderer(), time: seconds(1) });
		expect(flat.resolved && "transform3d" in flat.resolved).toBe(false);
		expect(layer.resolved?.transform3d?.position).toEqual([0, 0, 75]);
	});

	test("the camera rig resolves the active camera of the time", async () => {
		const tracks = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement({ startTime: 1, duration: 1 })] })],
		});
		const rig = new CameraRigNode({ tracks });
		await resolveRenderTree({ node: rig, renderer: renderer(), time: seconds(0.5) });
		expect(rig.resolved?.kind).toBe("default");
		expect(rig.resolved?.frameWidth).toBe(CANVAS.width);
		await resolveRenderTree({ node: rig, renderer: renderer(), time: seconds(1.5) });
		expect(rig.resolved?.kind).toBe("tracked");
	});

	test("track points only while their clip is on screen", async () => {
		const video = videoElement({
			startTime: 0.5,
			cameraTracker: trackerData({ settings: { renderTrackPoints: true } }),
		});
		const node = new TrackPointsNode({ video });
		await resolveRenderTree({ node, renderer: renderer(), time: seconds(0.25) });
		expect(node.resolved).toBeNull();
		await resolveRenderTree({ node, renderer: renderer(), time: seconds(1.5) });
		expect(node.resolved?.points.length).toBeGreaterThan(0);
		await resolveRenderTree({ node, renderer: renderer(), time: seconds(2.5) });
		expect(node.resolved).toBeNull();
	});
});
