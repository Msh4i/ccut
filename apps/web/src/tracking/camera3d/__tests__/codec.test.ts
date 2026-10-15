import { describe, expect, test } from "bun:test";
import type { FeatureTracks } from "@/tracking/camera/types";
import {
	decodeBase64,
	encodeBase64,
	packSolve,
	packTracks,
	quantizationFor,
	unpackFloat32,
	unpackSolve,
	unpackTracks,
} from "../codec";
import type { CameraSolve, PackedSolve, PackedTracks } from "../types";

/** Three tracks over 5 frames: 0 on 0..2, 1 on 1..4, 2 on 3..4. */
function sampleTracks(): FeatureTracks {
	const trackStart = Int32Array.from([0, 1, 3]);
	const trackLen = Int32Array.from([3, 4, 2]);
	const trackOffset = Int32Array.from([0, 6, 14]);
	const xy = Float32Array.from([
		10.25, 20.5, 11, 21, 12.125, 22.75,
		100, 50, 101.5, 50.5, 103, 51, 104.5, 51.5,
		-0.5, 269.5, 479.5, 0,
	]);
	return {
		w: 480,
		h: 270,
		frameCount: 5,
		fps: 30,
		trackStart,
		trackLen,
		trackOffset,
		xy,
		liveOffsets: Int32Array.from([0, 1, 3, 5, 7, 9]),
		liveIds: Int32Array.from([0, 0, 1, 0, 1, 1, 2, 1, 2]),
		cuts: [3],
		stats: { lostFraction: new Float32Array(5), cutNcc: [] },
	};
}

function sampleSolve(): CameraSolve {
	return {
		frameWidth: 1920,
		frameHeight: 1080,
		cameras: [
			{ rotation: [1, 0, 0, 0], position: [0, 0, 0], focalPx: 1500 },
			{ rotation: [0.9998, 0, 0.02, 0], position: [1.5, -2, 3], focalPx: 1510 },
		],
		solved: Uint8Array.from([1, 0]),
		points: [
			{ trackId: 4, position: [10, 20, 1500], error: 0.25 },
			{ trackId: 9, position: [-30, 5, 2100], error: 0.5 },
		],
		methodUsed: "typical",
		averageError: 0.31,
		notices: [{ kind: "unsolved-frames", count: 1 }],
	};
}

describe("base64", () => {
	test("round trip of every byte value and a long buffer", () => {
		const bytes = new Uint8Array(70_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 255;
		expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
	});

	test("rejects malformed input", () => {
		expect(decodeBase64("abc")).toBeNull();
		expect(decodeBase64("ab$=")).toBeNull();
		expect(decodeBase64("=abc")).toBeNull();
	});
});

describe("tracks", () => {
	test("round trip within the quantisation step, live lists rebuilt", () => {
		const tracks = sampleTracks();
		const packed = packTracks(tracks);
		expect(packed.quantization).toBe(64);
		const back = unpackTracks(JSON.parse(JSON.stringify(packed)));
		expect(back).not.toBeNull();
		if (!back) return;
		expect(back.trackStart).toEqual(tracks.trackStart);
		expect(back.trackLen).toEqual(tracks.trackLen);
		expect(back.trackOffset).toEqual(tracks.trackOffset);
		expect(back.liveOffsets).toEqual(tracks.liveOffsets);
		expect(back.liveIds).toEqual(tracks.liveIds);
		expect(back.cuts).toEqual([3]);
		for (let i = 0; i < tracks.xy.length; i++) {
			expect(Math.abs(back.xy[i] - tracks.xy[i])).toBeLessThanOrEqual(0.5 / 64);
		}
	});

	test("quantisation keeps the coordinates inside Int16", () => {
		expect(quantizationFor(480)).toBe(64);
		expect(quantizationFor(960)).toBe(32);
		expect(quantizationFor(1920)).toBe(16);
		expect((4096 + 1) * quantizationFor(4096)).toBeLessThanOrEqual(32767);
	});

	test("hostile input gives null, never a throw", () => {
		const good = packTracks(sampleTracks());
		const cases: PackedTracks[] = [
			{ ...good, trackCount: 4 },
			{ ...good, frameCount: 3 },
			{ ...good, xy: good.xy.slice(0, -4) },
			{ ...good, xy: "not base64!" },
			{ ...good, width: -1 },
			{ ...good, fps: Number.NaN },
			{ ...good, quantization: 0 },
			{ ...good, cuts: [3, 2] },
			{ ...good, cuts: [99] },
			{ ...good, frameCount: 1e12 },
		];
		for (const packed of cases) expect(unpackTracks(packed)).toBeNull();
	});
});

describe("solve", () => {
	test("round trip through JSON", () => {
		const solve = sampleSolve();
		const back = unpackSolve(JSON.parse(JSON.stringify(packSolve(solve))));
		expect(back).not.toBeNull();
		if (!back) return;
		expect(back.cameras.length).toBe(2);
		expect(back.cameras[1].focalPx).toBeCloseTo(1510, 3);
		expect(back.cameras[1].position[0]).toBeCloseTo(1.5, 5);
		expect(Math.hypot(...back.cameras[1].rotation)).toBeCloseTo(1, 6);
		expect(back.solved).toEqual(Uint8Array.from([1, 0]));
		expect(back.points.map((p) => p.trackId)).toEqual([4, 9]);
		expect(back.points[1].position[2]).toBeCloseTo(2100, 2);
		expect(back.methodUsed).toBe("typical");
		expect(back.notices).toEqual([{ kind: "unsolved-frames", count: 1 }]);
	});

	test("hostile input gives null", () => {
		const good = packSolve(sampleSolve());
		const nanCamera = new Float32Array(16).fill(Number.NaN);
		const cases: PackedSolve[] = [
			{ ...good, frameCount: 3 },
			{ ...good, frameWidth: 0 },
			{ ...good, averageError: -1 },
			{ ...good, points: good.points.slice(0, -8) },
			{ ...good, pointIds: "xyz" },
			{ ...good, cameras: encodeBase64(new Uint8Array(nanCamera.buffer)) },
			{ ...good, cameras: encodeBase64(new Uint8Array(new Float32Array(16).buffer)) },
			{ ...good, notices: [{ kind: "cut", frame: -1 }] },
		];
		for (const packed of cases) expect(unpackSolve(packed)).toBeNull();
		const unknownMethod: PackedSolve = JSON.parse(
			JSON.stringify({ ...good, methodUsed: "magic" }),
		);
		expect(unpackSolve(unknownMethod)).toBeNull();
	});

	test("an infinite or NaN error, of a point or on average, gives null", () => {
		for (const error of [Number.POSITIVE_INFINITY, Number.NaN]) {
			const solve = sampleSolve();
			const points = solve.points.map((point, i) => (i === 1 ? { ...point, error } : point));
			expect(unpackSolve(packSolve({ ...solve, points }))).toBeNull();
			expect(unpackSolve({ ...packSolve(solve), averageError: error })).toBeNull();
		}
		expect(unpackSolve(packSolve(sampleSolve()))).not.toBeNull();
	});

	test("unpackFloat32 checks the length", () => {
		const packed = packSolve(sampleSolve()).cameras;
		expect(unpackFloat32({ packed, length: 16 })).not.toBeNull();
		expect(unpackFloat32({ packed, length: 15 })).toBeNull();
	});
});
