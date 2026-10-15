import { describe, expect, test } from "bun:test";
import { applyMattes } from "../../matte/matte-registry";
import { BrushMatteSource } from "../brush-source";
import { canvasToSourceUv, sourceUvToCanvas } from "../coords";
import { activeKeyframe, addKeyframeAt, addStroke, removeKeyframe, undoStroke } from "../keyframes";
import { rasterizeStrokes } from "../rasterize";
import { type BrushStroke, type ElementCutout, normalizeCutout } from "../types";

const stroke = (patch: Partial<BrushStroke> & Pick<BrushStroke, "points">): BrushStroke => ({
	mode: "remove",
	radius: 0.1,
	hardness: 1,
	feather: 0,
	...patch,
});

describe("rasterising strokes", () => {
	test("a hard remove stroke clears a disc, keeps the rest; a keep stroke brings part back", () => {
		const remove = stroke({ points: [{ x: 0.5, y: 0.5 }] });
		const matte = rasterizeStrokes({ strokes: [remove], width: 100, height: 100 });
		expect(matte[50 * 100 + 50]).toBe(0);
		expect(matte[50 * 100 + 5]).toBe(255);
		const restored = rasterizeStrokes({ strokes: [remove, stroke({ mode: "keep", radius: 0.03, points: [{ x: 0.5, y: 0.5 }] })], width: 100, height: 100 });
		expect(restored[50 * 100 + 50]).toBe(255);
		expect(restored[50 * 100 + 58]).toBe(0);
	});

	test("feather makes a soft edge; a stroke along a line is continuous (no gaps between points)", () => {
		const soft = rasterizeStrokes({ strokes: [stroke({ radius: 0.1, feather: 1, hardness: 0.5, points: [{ x: 0.5, y: 0.5 }] })], width: 100, height: 100 });
		const edge = soft[50 * 100 + 62] ?? 0;
		expect(edge).toBeGreaterThan(0);
		expect(edge).toBeLessThan(255);
		const line = rasterizeStrokes({ strokes: [stroke({ radius: 0.03, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] })], width: 100, height: 100 });
		for (let x = 10; x <= 90; x++) expect(line[50 * 100 + x]).toBe(0);
	});
});

describe("matte keyframes", () => {
	const s1 = stroke({ points: [{ x: 0.2, y: 0.2 }] });
	const s2 = stroke({ points: [{ x: 0.8, y: 0.8 }] });

	test("a painted frame holds until the next keyframe; a new keyframe continues the earlier strokes", () => {
		const first = addStroke({ cutout: undefined, time: 1000, stroke: s1, tolerance: 10, isVideo: true });
		if (!first.ok) throw new Error("add failed");
		const second = addStroke({ cutout: first.cutout, time: 5000, stroke: s2, tolerance: 10, isVideo: true });
		if (!second.ok) throw new Error("add failed");
		expect(second.cutout.keyframes.map((k) => [k.time, k.strokes.length])).toEqual([[1000, 1], [5000, 2]]);
		expect(activeKeyframe({ cutout: second.cutout, time: 3000 })?.time).toBe(1000);
		expect(activeKeyframe({ cutout: second.cutout, time: 9000 })?.time).toBe(5000);
		// before the first keyframe the first one applies
		expect(activeKeyframe({ cutout: second.cutout, time: 0 })?.time).toBe(1000);
		// a stroke on the same frame edits it
		const same = addStroke({ cutout: second.cutout, time: 5004, stroke: s1, tolerance: 10, isVideo: true });
		expect(same.ok && same.cutout.keyframes.map((k) => k.strokes.length)).toEqual([1, 3]);
	});

	test("an image has one keyframe at 0; undo removes the last stroke, an emptied keyframe, then the cutout", () => {
		const a = addStroke({ cutout: undefined, time: 777, stroke: s1, tolerance: 10, isVideo: false });
		if (!a.ok) throw new Error("add failed");
		expect(a.cutout.keyframes[0]?.time).toBe(0);
		const b = addStroke({ cutout: a.cutout, time: 0, stroke: s2, tolerance: 10, isVideo: false });
		if (!b.ok) throw new Error("add failed");
		const undone = undoStroke({ cutout: b.cutout, time: 0, tolerance: 10 });
		expect(undone?.keyframes[0]?.strokes).toEqual([s1]);
		if (!undone) throw new Error("undo removed everything too early");
		expect(undoStroke({ cutout: undone, time: 0, tolerance: 10 })).toBeNull();
	});

	test("adding a matte keyframe copies what is in force; removing one drops it", () => {
		const base: ElementCutout = { keyframes: [{ time: 0, strokes: [s1] }] };
		const added = addKeyframeAt({ cutout: base, time: 4000, tolerance: 10 });
		if (!added.ok) throw new Error("add failed");
		expect(added.cutout.keyframes.map((k) => [k.time, k.strokes.length])).toEqual([[0, 1], [4000, 1]]);
		expect(removeKeyframe({ cutout: added.cutout, time: 4000, tolerance: 10 })?.keyframes.length).toBe(1);
	});
});

describe("stored data", () => {
	test("a project without the field has no matte; hostile data is cleaned or dropped", () => {
		expect(normalizeCutout({ value: undefined })).toBeNull();
		expect(normalizeCutout({ value: { keyframes: "x" } })).toBeNull();
		const cleaned = normalizeCutout({
			value: {
				keyframes: [
					{ time: -5, strokes: [{ mode: "remove", radius: 99, hardness: 3, feather: -1, points: [{ x: 0.5, y: 0.5 }] }, { mode: "bad", radius: 1, hardness: 1, feather: 1, points: [] }] },
					{ time: "x", strokes: [] },
				],
			},
		});
		expect(cleaned?.keyframes).toHaveLength(1);
		expect(cleaned?.keyframes[0]).toMatchObject({ time: 0 });
		expect(cleaned?.keyframes[0]?.strokes[0]).toMatchObject({ radius: 0.5, hardness: 1, feather: 0 });
		expect(cleaned?.keyframes[0]?.strokes).toHaveLength(1);
	});
});

describe("the picture follows the layer", () => {
	test("canvas <-> source mapping round-trips through position, scale and rotation", () => {
		const bounds = { cx: 300, cy: 200, width: 400, height: 200, rotation: 30 };
		const uv = canvasToSourceUv({ point: sourceUvToCanvas({ uv: { x: 0.2, y: 0.9 }, bounds }), bounds });
		expect(uv.x).toBeCloseTo(0.2, 6);
		expect(uv.y).toBeCloseTo(0.9, 6);
		expect(canvasToSourceUv({ point: { x: 300, y: 200 }, bounds })).toEqual({ x: 0.5, y: 0.5 });
	});

	test("preview and export build the same cutout: a small preview texture and a full one remove the same part of the picture", () => {
		const cutout: ElementCutout = { keyframes: [{ time: 0, strokes: [stroke({ radius: 0.15, points: [{ x: 0.25, y: 0.5 }] })] }] };
		const source = new BrushMatteSource({ cutout, sourceWidth: 1920, sourceHeight: 1080, elementId: "e" });
		const matte = source.lookup({ sourceSeconds: 0, clipTime: 123 });
		if (!matte) throw new Error("no matte");
		const alphaAt = ({ width, height, u, v }: { width: number; height: number; u: number; v: number }) => {
			const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
			applyMattes({ pixels, width, height, mattes: [matte] });
			return pixels[(Math.floor(v * height) * width + Math.floor(u * width)) * 4 + 3];
		};
		for (const size of [{ width: 96, height: 54 }, { width: 1920, height: 1080 }]) {
			expect(alphaAt({ ...size, u: 0.25, v: 0.5 })).toBe(0);
			expect(alphaAt({ ...size, u: 0.75, v: 0.5 })).toBe(255);
		}
		// the same keyframe returns the same matte object (rasterised once)
		expect(source.lookup({ sourceSeconds: 0, clipTime: 999 })).toBe(matte);
	});
});

describe("rasterising cost is bounded", () => {
	test("a stroke of 4000 points with the biggest radius and feather stops at the budget, fast, and says so", async () => {
		const { rasterizeStrokesLimited } = await import("../rasterize");
		const points = Array.from({ length: 4000 }, (_, i) => ({ x: (i % 100) / 100, y: Math.floor(i / 40) / 100 }));
		const started = performance.now();
		const result = rasterizeStrokesLimited({ strokes: [stroke({ radius: 0.5, feather: 1, hardness: 0, points })], width: 512, height: 288 });
		expect(performance.now() - started).toBeLessThan(2000);
		expect(result.truncated).toBe(true);
		expect(result.data).toHaveLength(512 * 288);
		// an ordinary stroke is untouched by the limits
		expect(rasterizeStrokesLimited({ strokes: [stroke({ points: [{ x: 0.5, y: 0.5 }] })], width: 100, height: 100 }).truncated).toBe(false);
	});
});
