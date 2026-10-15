import { describe, expect, test } from "bun:test";
import { InputDisposedError } from "mediabunny";
import { decodeGrayFrames, lumaFromRgba, workSize } from "@/tracking/frame-source";

function rgba(...pixels: Array<[number, number, number, number?]>) {
	return Uint8ClampedArray.from(
		pixels.flatMap(([r, g, b, a = 255]) => [r, g, b, a]),
	);
}

describe("lumaFromRgba", () => {
	test("keeps pure grays unchanged, black and white included", () => {
		const out = new Uint8Array(4);
		lumaFromRgba({
			rgba: rgba([0, 0, 0], [255, 255, 255], [128, 128, 128], [37, 37, 37]),
			out,
		});
		expect(Array.from(out)).toEqual([0, 255, 128, 37]);
	});

	test("weighs green over red over blue like Rec. 601", () => {
		const out = new Uint8Array(3);
		lumaFromRgba({ rgba: rgba([255, 0, 0], [0, 255, 0], [0, 0, 255]), out });
		const [red, green, blue] = out;
		expect(green).toBeGreaterThan(red);
		expect(red).toBeGreaterThan(blue);
		expect(Math.abs(red - 0.299 * 255)).toBeLessThan(1.5);
		expect(Math.abs(green - 0.587 * 255)).toBeLessThan(1.5);
		expect(Math.abs(blue - 0.114 * 255)).toBeLessThan(1.5);
	});

	test("ignores alpha", () => {
		const out = new Uint8Array(2);
		lumaFromRgba({ rgba: rgba([200, 100, 50, 0], [200, 100, 50, 255]), out });
		expect(out[0]).toBe(out[1]);
	});

	test("uses the first pixels when the output holds fewer than the input", () => {
		const out = new Uint8Array(2);
		lumaFromRgba({
			rgba: rgba([10, 10, 10], [20, 20, 20], [30, 30, 30]),
			out,
		});
		expect(Array.from(out)).toEqual([10, 20]);
	});
});

describe("workSize", () => {
	test("scales a wide frame down to the working width", () => {
		expect(workSize({ width: 1920, height: 1080 })).toEqual({
			width: 480,
			height: 270,
		});
	});

	test("never upscales a small frame", () => {
		expect(workSize({ width: 320, height: 240 })).toEqual({
			width: 320,
			height: 240,
		});
	});

	test("keeps the aspect ratio of portrait phone clips", () => {
		expect(workSize({ width: 1080, height: 1920 })).toEqual({
			width: 480,
			height: 853,
		});
	});

	test("never returns an empty frame", () => {
		expect(workSize({ width: 5000, height: 1 })).toEqual({
			width: 480,
			height: 1,
		});
	});
});

describe("decodeGrayFrames: abort signal", () => {
	// not a video: what the decoder does with it is not the point, only who ends it
	const NOT_A_VIDEO = new File([new Uint8Array(256)], "clip.mp4");

	test("without a signal the file is opened and refused for what it is", async () => {
		const frames = decodeGrayFrames({ file: NOT_A_VIDEO, sourceTimes: [0] });
		await expect(frames.next()).rejects.not.toBeInstanceOf(InputDisposedError);
	});

	test("an abort while the file is being read disposes the input, so the read rejects instead of waiting", async () => {
		const controller = new AbortController();
		const frames = decodeGrayFrames({ file: NOT_A_VIDEO, sourceTimes: [0], signal: controller.signal });
		const pending = frames.next();
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(InputDisposedError);
	});

	test("a signal that is already aborted decodes nothing and opens nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		const frames = decodeGrayFrames({ file: NOT_A_VIDEO, sourceTimes: [0], signal: controller.signal });
		expect(await frames.next()).toEqual({ done: true, value: undefined });
	});
});
