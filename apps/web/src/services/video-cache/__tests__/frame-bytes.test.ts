import { describe, expect, test } from "bun:test";
import { DEFAULT_FRAME_BYTES } from "../frame-stream";
import { frameBytesOf } from "../mediabunny-source";

describe("frameBytesOf", () => {
	test("decoded: coded size x 1.5 (4:2:0); drawn: canvas size x 4 (RGBA)", () => {
		// H.264 1080p is coded 1920x1088 (16-pixel macroblocks)
		expect(frameBytesOf({ codedWidth: 1920, codedHeight: 1088, width: 1920, height: 1080 })).toEqual({
			decoded: 1920 * 1088 * 1.5,
			drawn: 1920 * 1080 * 4,
		});
		// a rotated phone video: the canvas is the turned display size
		expect(frameBytesOf({ codedWidth: 3840, codedHeight: 2160, width: 2160, height: 3840 })).toEqual({
			decoded: 3840 * 2160 * 1.5,
			drawn: 2160 * 3840 * 4,
		});
	});

	test("unknown sizes fall back to the 1080p estimate", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(frameBytesOf({ codedWidth: bad, codedHeight: 1080, width: bad, height: 1080 })).toEqual(
				DEFAULT_FRAME_BYTES,
			);
		}
	});
});
