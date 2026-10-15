import { describe, expect, test } from "bun:test";
import type { ElementBounds } from "@/preview/element-bounds";
import { frameCentre, frameToUnit, unitToFrame } from "../frame-coordinates";
import { framePointToCanvas } from "../to-channels";

describe("pixel centres", () => {
	test("pixel i is centred at x = i, so the picture runs from -0.5 to w - 0.5", () => {
		expect(frameToUnit({ x: 0, size: 480 })).toBeCloseTo(0.5 / 480, 12);
		expect(frameToUnit({ x: 479, size: 480 })).toBeCloseTo(479.5 / 480, 12);
		expect(frameToUnit({ x: -0.5, size: 480 })).toBe(0);
		expect(frameToUnit({ x: 479.5, size: 480 })).toBe(1);
	});

	test("the two directions undo each other", () => {
		for (const x of [-3, 0, 0.25, 100.5, 479, 600]) {
			expect(unitToFrame({ u: frameToUnit({ x, size: 480 }), size: 480 })).toBeCloseTo(x, 10);
		}
	});

	test("the centre of the picture is half a pixel before w / 2", () => {
		expect(frameCentre({ w: 480, h: 270 })).toEqual({ x: 239.5, y: 134.5 });
		expect(frameToUnit({ x: frameCentre({ w: 480, h: 270 }).x, size: 480 })).toBe(0.5);
	});

	test("the renderer side uses the same rule: a frame that fills a 1920 x 1080 canvas", () => {
		const fill: ElementBounds = { cx: 960, cy: 540, width: 1920, height: 1080, rotation: 0 };
		const size = { w: 480, h: 270 };
		// pixel 0 is the strip from 0 to 4 canvas px: its centre is at 2, not 0 and not 4
		const corner = framePointToCanvas({ point: { x: 0, y: 0 }, host: fill, frameSize: size });
		expect(corner.x).toBeCloseTo(2, 9);
		expect(corner.y).toBeCloseTo(2, 9);
		const centre = framePointToCanvas({ point: frameCentre(size), host: fill, frameSize: size });
		expect(centre.x).toBeCloseTo(960, 9);
		expect(centre.y).toBeCloseTo(540, 9);
		const last = framePointToCanvas({ point: { x: 479, y: 269 }, host: fill, frameSize: size });
		expect(last.x).toBeCloseTo(1918, 9);
		expect(last.y).toBeCloseTo(1078, 9);
	});
});
