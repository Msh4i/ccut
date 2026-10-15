import { describe, expect, test } from "bun:test";
import { decodedSolve, decodedTracks } from "@/tracking/camera3d/engine/decoded-cache";
import { affineApply } from "../../math";
import type { ViewCamera } from "../../types";
import {
	activeCameraAt,
	analysisFrameAt,
	trackedViewCamera,
} from "../active-camera";
import {
	cameraElement,
	cameraTrack,
	sceneTracks,
	seconds,
	solvedCameras,
	trackerData,
	videoElement,
} from "./fixtures";

const CANVAS = { canvasWidth: 1080, canvasHeight: 1920 };

function expectDefault(view: ViewCamera) {
	expect(view.kind).toBe("default");
	expect(view.frameWidth).toBe(CANVAS.canvasWidth);
	expect(view.frameHeight).toBe(CANVAS.canvasHeight);
}

describe("activeCameraAt", () => {
	test("no camera element: the default camera of the canvas", () => {
		expectDefault(activeCameraAt({ tracks: sceneTracks(), time: seconds(1), ...CANVAS }));
	});

	test("a camera element reproduces its clip's solve at the clip's source time", () => {
		// Clip at 0 s, trimmed 1 s in; analysis frame 0 is source second 1.5, 30 fps.
		// Timeline 1 s -> source 2 s -> analysis frame 15.
		const tracks = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement()] })],
		});
		const view = activeCameraAt({ tracks, time: seconds(1), ...CANVAS });
		const expected = solvedCameras()[15];
		expect(view.kind).toBe("tracked");
		expect(view.frameWidth).toBe(1920);
		expect(view.frameHeight).toBe(1080);
		for (let i = 0; i < 3; i++) expect(view.position[i]).toBeCloseTo(expected.position[i], 4);
		for (let i = 0; i < 4; i++) expect(view.rotation[i]).toBeCloseTo(expected.rotation[i], 6);
		expect(view.focalPx).toBeCloseTo(expected.focalPx, 3);
	});

	test("between analysis frames the camera is interpolated", () => {
		const tracks = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement()] })],
		});
		// Timeline 1.25 s -> source 2.25 s -> frame 22.5.
		const view = activeCameraAt({ tracks, time: seconds(1.25), ...CANVAS });
		expect(view.position[0]).toBeCloseTo(22.5 * 8, 3);
		expect(view.focalPx).toBeCloseTo(1522.5, 3);
	});

	test("a retimed clip maps timeline time to source time with its rate", () => {
		const tracks = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement()] })],
			main: [videoElement({ rate: 2 })],
		});
		// Timeline 0.5 s -> clip 0.5 s -> source 1 + 0.5 * 2 = 2 s -> frame 15.
		const view = activeCameraAt({ tracks, time: seconds(0.5), ...CANVAS });
		expect(view.position[0]).toBeCloseTo(15 * 8, 3);
	});

	test("frameToCanvas is where the clip's picture is drawn (moved, scaled, flipped)", () => {
		const tracks = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement()] })],
			main: [
				videoElement({
					params: {
						"transform.positionX": 100,
						"transform.positionY": -50,
						"transform.scaleX": -0.5,
						"transform.scaleY": 0.5,
						"transform.rotate": 0,
					},
				}),
			],
		});
		const view = activeCameraAt({ tracks, time: seconds(1), ...CANVAS });
		// Contain-fit of 1920x1080 into 1080x1920: 1080 x 607.5, half size, flipped in x.
		const centre = affineApply({ m: view.frameToCanvas, x: 960, y: 540 });
		expect(centre.x).toBeCloseTo(640, 9);
		expect(centre.y).toBeCloseTo(910, 9);
		const topLeft = affineApply({ m: view.frameToCanvas, x: 0, y: 0 });
		expect(topLeft.x).toBeCloseTo(640 + 270, 9);
		expect(topLeft.y).toBeCloseTo(910 - 151.875, 9);
	});

	test("hidden camera elements, hidden camera tracks and inactive cameras are ignored", () => {
		const hiddenElement = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement({ hidden: true })] })],
		});
		expectDefault(activeCameraAt({ tracks: hiddenElement, time: seconds(1), ...CANVAS }));
		const hiddenTrack = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement()], hidden: true })],
		});
		expectDefault(activeCameraAt({ tracks: hiddenTrack, time: seconds(1), ...CANVAS }));
		const later = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement({ startTime: 1.5, duration: 0.5 })] })],
		});
		expectDefault(activeCameraAt({ tracks: later, time: seconds(1), ...CANVAS }));
		expect(activeCameraAt({ tracks: later, time: seconds(1.5), ...CANVAS }).kind).toBe(
			"tracked",
		);
		expectDefault(activeCameraAt({ tracks: later, time: seconds(2), ...CANVAS }));
	});

	test("the topmost active camera wins", () => {
		const tracks = sceneTracks({
			overlay: [
				cameraTrack({
					id: "top",
					elements: [cameraElement({ id: "top-camera", sourceElementId: "clip-b" })],
				}),
				cameraTrack({ id: "below", elements: [cameraElement()] }),
			],
			main: [
				videoElement(),
				videoElement({
					id: "clip-b",
					startTime: 0,
					trimStart: 1,
					cameraTracker: trackerData({ sourceStart: 1 }),
				}),
			],
		});
		// Clip b: source 2 s at timeline 1 s -> frame (2 - 1) * 30 = 30.
		const view = activeCameraAt({ tracks, time: seconds(1), ...CANVAS });
		expect(view.position[0]).toBeCloseTo(30 * 8, 3);
	});

	test("a missing source, an untracked source or an unreadable solve falls back to the default camera", () => {
		const missing = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement({ sourceElementId: "nope" })] })],
		});
		expectDefault(activeCameraAt({ tracks: missing, time: seconds(1), ...CANVAS }));
		const untracked = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement()] })],
			main: [videoElement({ cameraTracker: null })],
		});
		expectDefault(activeCameraAt({ tracks: untracked, time: seconds(1), ...CANVAS }));
		const unsolved = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement()] })],
			main: [videoElement({ cameraTracker: { ...trackerData(), solve: null } })],
		});
		expectDefault(activeCameraAt({ tracks: unsolved, time: seconds(1), ...CANVAS }));
		const data = trackerData();
		const corrupt = sceneTracks({
			overlay: [cameraTrack({ elements: [cameraElement()] })],
			main: [
				videoElement({
					cameraTracker: {
						...data,
						solve: data.solve && { ...data.solve, cameras: "not base64!" },
					},
				}),
			],
		});
		expectDefault(activeCameraAt({ tracks: corrupt, time: seconds(1), ...CANVAS }));
	});
});

describe("decoding is cached per stored object", () => {
	test("the same packed solve and tracks decode once", () => {
		const data = trackerData();
		if (!data.solve) throw new Error("fixture has a solve");
		const first = decodedSolve(data.solve);
		expect(first).not.toBeNull();
		expect(decodedSolve(data.solve)).toBe(first);
		expect(decodedSolve({ ...data.solve })).not.toBe(first);
		const tracks = decodedTracks(data.tracks);
		expect(tracks).not.toBeNull();
		expect(decodedTracks(data.tracks)).toBe(tracks);
	});
});

describe("trackedViewCamera and analysisFrameAt", () => {
	test("the fractional analysis frame of a timeline time", () => {
		const video = videoElement();
		expect(analysisFrameAt({ video, time: seconds(1) })).toBeCloseTo(15, 9);
		expect(analysisFrameAt({ video, time: seconds(0) })).toBeCloseTo(-15, 9);
		expect(analysisFrameAt({ video: videoElement({ cameraTracker: null }), time: seconds(1) })).toBeNull();
	});

	test("outside the analysed range the camera holds its end", () => {
		const view = trackedViewCamera({ video: videoElement(), time: seconds(0), ...CANVAS });
		expect(view?.position[0]).toBeCloseTo(0, 6);
	});
});
