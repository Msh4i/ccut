import { describe, expect, test } from "bun:test";
import type { ElementBounds as Bounds } from "@/preview/element-bounds";
import { canvasToUv, uvToCanvas } from "@/tracking/projection";

const plain: Bounds = {
	cx: 960,
	cy: 540,
	width: 1920,
	height: 1080,
	rotation: 0,
};

const hosts: Array<{ name: string; bounds: Bounds }> = [
	{ name: "plain", bounds: plain },
	{
		name: "scaled and moved",
		bounds: { cx: 700, cy: 300, width: 800, height: 450, rotation: 0 },
	},
	{
		name: "rotated",
		bounds: { cx: 960, cy: 540, width: 1920, height: 1080, rotation: 37 },
	},
	{
		name: "flipped horizontally",
		bounds: { cx: 960, cy: 540, width: -1920, height: 1080, rotation: 0 },
	},
	{
		name: "flipped vertically and rotated",
		bounds: { cx: 400, cy: 800, width: 640, height: -360, rotation: -123 },
	},
	{
		name: "flipped both and rotated",
		bounds: { cx: -50, cy: 1200, width: -500, height: -900, rotation: 215 },
	},
];

describe("uvToCanvas", () => {
	test("maps the frame corners and center of an untouched host", () => {
		const topLeft = uvToCanvas({ u: 0, v: 0, bounds: plain });
		expect(topLeft.x).toBeCloseTo(0, 9);
		expect(topLeft.y).toBeCloseTo(0, 9);
		const bottomRight = uvToCanvas({ u: 1, v: 1, bounds: plain });
		expect(bottomRight.x).toBeCloseTo(1920, 9);
		expect(bottomRight.y).toBeCloseTo(1080, 9);
		const center = uvToCanvas({ u: 0.5, v: 0.5, bounds: plain });
		expect(center.x).toBeCloseTo(960, 9);
		expect(center.y).toBeCloseTo(540, 9);
	});

	test("follows the host position and scale", () => {
		const bounds: Bounds = {
			cx: 700,
			cy: 300,
			width: 800,
			height: 450,
			rotation: 0,
		};
		const point = uvToCanvas({ u: 0.75, v: 0.25, bounds });
		expect(point.x).toBeCloseTo(700 + 0.25 * 800, 9);
		expect(point.y).toBeCloseTo(300 - 0.25 * 450, 9);
	});

	test("rotates clockwise around the host center like the transform handles", () => {
		const bounds: Bounds = { ...plain, rotation: 90 };
		// The right edge middle swings down to the bottom of the center.
		const point = uvToCanvas({ u: 1, v: 0.5, bounds });
		expect(point.x).toBeCloseTo(960, 9);
		expect(point.y).toBeCloseTo(540 + 960, 9);
	});

	test("a negative width mirrors the picture", () => {
		const bounds: Bounds = { ...plain, width: -1920 };
		const point = uvToCanvas({ u: 0, v: 0.5, bounds });
		expect(point.x).toBeCloseTo(1920, 9);
		expect(point.y).toBeCloseTo(540, 9);
	});

	test("a negative height flips the picture upside down", () => {
		const bounds: Bounds = { ...plain, height: -1080 };
		const point = uvToCanvas({ u: 0.5, v: 0, bounds });
		expect(point.x).toBeCloseTo(960, 9);
		expect(point.y).toBeCloseTo(1080, 9);
	});
});

describe("canvasToUv", () => {
	for (const { name, bounds } of hosts) {
		test(`round trips through a ${name} host`, () => {
			for (const [u, v] of [
				[0, 0],
				[1, 1],
				[0.5, 0.5],
				[0.13, 0.82],
				[0.97, 0.04],
				[-0.2, 1.3],
			]) {
				const canvas = uvToCanvas({ u, v, bounds });
				const back = canvasToUv({ x: canvas.x, y: canvas.y, bounds });
				expect(back.u).toBeCloseTo(u, 9);
				expect(back.v).toBeCloseTo(v, 9);
			}
		});
	}

	test("inverts a canvas click back to a normalized position", () => {
		const bounds: Bounds = {
			cx: 960,
			cy: 540,
			width: 1920,
			height: 1080,
			rotation: 90,
		};
		const back = canvasToUv({ x: 960, y: 540 + 960, bounds });
		expect(back.u).toBeCloseTo(1, 9);
		expect(back.v).toBeCloseTo(0.5, 9);
	});
});
