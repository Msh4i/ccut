import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import {
	mainTrack,
	sceneTracks,
	seconds,
	videoElement,
} from "@/scene3d/render/__tests__/fixtures";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { resolveRenderTree } from "@/services/renderer/resolve";
import { buildScene } from "@/services/renderer/scene-builder";
import { videoCache } from "../service";

// The renderer tells the frame cache which clip every video frame is for, so
// two clips of one file at different times each keep their own decoder, and
// the blur backdrop of a clip shares its clip's frame.

const MEDIA: MediaAsset[] = [
	{
		id: "clip-media",
		name: "clip.mp4",
		type: "video",
		file: new File([], "clip.mp4"),
		url: "blob:clip",
	},
];

const getFrameAt = spyOn(videoCache, "getFrameAt");

afterEach(() => {
	getFrameAt.mockReset();
});

afterAll(() => {
	getFrameAt.mockRestore();
});

function renderer(): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), {
		width: 1080,
		height: 1920,
	});
}

describe("stream keys from the renderer", () => {
	test("the blur backdrop and the video of a clip ask with the clip's id; a second clip of the same file with its own", async () => {
		getFrameAt.mockResolvedValue(null);
		const overlay = { ...mainTrack([videoElement({ id: "clip-b", trimStart: 6, cameraTracker: null })]), id: "overlay" };
		const root = buildScene({
			canvasSize: { width: 1080, height: 1920 },
			tracks: sceneTracks({
				main: [videoElement({ id: "clip-a", trimStart: 1, cameraTracker: null })],
				overlay: [overlay],
			}),
			mediaAssets: MEDIA,
			duration: seconds(2),
			background: { type: "blur", blurIntensity: 100 },
		});
		const frameLease = { id: 7 };
		await resolveRenderTree({ node: root, renderer: renderer(), time: seconds(0.5), frameLease });
		const asked = getFrameAt.mock.calls.map(([request]) => ({
			key: request.streamKey,
			time: request.time,
			lease: request.lease,
		}));
		// backdrop of clip-a, clip-a, clip-b (scene order), all under the render's lease
		expect(asked).toEqual([
			{ key: "clip-a", time: 1.5, lease: frameLease },
			{ key: "clip-a", time: 1.5, lease: frameLease },
			{ key: "clip-b", time: 6.5, lease: frameLease },
		]);
	});
});
