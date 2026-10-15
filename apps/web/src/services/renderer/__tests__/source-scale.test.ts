import { describe, expect, test } from "bun:test";
import {
	backdropSourceScale,
	densityBucket,
	layerSourceScale,
	previewSourceDensity,
} from "../source-scale";

// While the preview plays or scrubs, a video frame only needs about as many
// pixels as it covers on the screen: its quad's size in scene pixels, times the
// scene's device pixels per scene pixel (the "density"), rounded up to the
// next power of sqrt(2) so a small change of size does not change the frame
// size. Paused, exporting, snapshots: full size (density null).

describe("previewSourceDensity", () => {
	test("playing or scrubbing: device pixels per scene pixel", () => {
		// the scene is 1080 px wide and shown 450 CSS px wide at DPR 1
		const shown = { sceneCssWidth: 450, canvasWidth: 1080, devicePixelRatio: 1 };
		expect(previewSourceDensity({ isPlaying: true, isScrubbing: false, ...shown })).toBeCloseTo(
			450 / 1080,
			10,
		);
		expect(previewSourceDensity({ isPlaying: false, isScrubbing: true, ...shown })).toBeCloseTo(
			450 / 1080,
			10,
		);
		expect(
			previewSourceDensity({ isPlaying: true, isScrubbing: false, ...shown, devicePixelRatio: 2 }),
		).toBeCloseTo(900 / 1080, 10);
	});

	test("paused: null, a paused frame is full size", () => {
		expect(
			previewSourceDensity({
				isPlaying: false,
				isScrubbing: false,
				sceneCssWidth: 450,
				canvasWidth: 1080,
				devicePixelRatio: 1,
			}),
		).toBeNull();
	});

	test("anything unusable is null (full size)", () => {
		const base = { isPlaying: true, isScrubbing: false, sceneCssWidth: 450, canvasWidth: 1080, devicePixelRatio: 1 };
		expect(previewSourceDensity({ ...base, sceneCssWidth: 0 })).toBeNull();
		expect(previewSourceDensity({ ...base, sceneCssWidth: Number.NaN })).toBeNull();
		expect(previewSourceDensity({ ...base, canvasWidth: 0 })).toBeNull();
		expect(previewSourceDensity({ ...base, devicePixelRatio: 0 })).toBeNull();
		expect(previewSourceDensity({ ...base, devicePixelRatio: Number.NaN })).toBeNull();
		expect(previewSourceDensity({ ...base, sceneCssWidth: Number.POSITIVE_INFINITY })).toBeNull();
	});
});

describe("layerSourceScale", () => {
	// 1920x1080 video, contain-fitted on a 1080x1920 canvas: the quad is 1080x608
	const owner = {
		quadWidth: 1080,
		quadHeight: 607.5,
		sourceWidth: 1920,
		sourceHeight: 1080,
	};

	test("the owner's case: 450 CSS px wide at DPR 1 is scale 0.25, a 480x270 frame", () => {
		const scale = layerSourceScale({ ...owner, density: 450 / 1080 });
		// 0.5625 x 0.4167 = 0.234, up to the next power of sqrt 2
		expect(scale).toBe(0.25);
		expect(Math.round(1920 * scale)).toBe(480);
		expect(Math.round(1080 * scale)).toBe(270);
	});

	test("null density (paused, export, snapshot, thumbnail): full size", () => {
		expect(layerSourceScale({ ...owner, density: null })).toBe(1);
	});

	test("NaN, 0, negative or infinite density: full size", () => {
		for (const density of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
			expect(layerSourceScale({ ...owner, density })).toBe(1);
		}
	});

	test("a frame is never drawn larger than it is: zoom is capped at 1", () => {
		expect(layerSourceScale({ ...owner, density: 450 / 1080 * 16 })).toBe(1);
		expect(layerSourceScale({ ...owner, density: 4 })).toBe(1);
		// a layer enlarged by the user, on a high-density screen
		expect(layerSourceScale({ ...owner, quadWidth: 4000, quadHeight: 2250, density: 1 })).toBe(1);
	});

	test("the frame has at least the pixels it shows, and less than sqrt 2 times as many per side", () => {
		for (const density of [0.1, 0.17, 0.234, 0.31, 0.42, 0.5, 0.6, 0.77, 0.9]) {
			const scale = layerSourceScale({ ...owner, density });
			const needed = 0.5625 * density;
			expect(scale).toBeGreaterThanOrEqual(needed - 1e-9);
			expect(scale).toBeLessThan(needed * Math.SQRT2 + 1e-9);
		}
	});

	test("a size change within a bucket keeps the scale, so frames are not redrawn at a new size every frame", () => {
		const a = layerSourceScale({ ...owner, density: 0.4 });
		const b = layerSourceScale({ ...owner, density: 0.43 });
		expect(a).toBe(b);
	});

	test("the layer's own transform counts: a layer scaled down needs fewer pixels", () => {
		const full = layerSourceScale({ ...owner, density: 0.8 });
		const half = layerSourceScale({
			...owner,
			quadWidth: owner.quadWidth / 2,
			quadHeight: owner.quadHeight / 2,
			density: 0.8,
		});
		expect(half).toBeLessThan(full);
	});

	test("the larger side decides (a stretched layer)", () => {
		// squeezed horizontally to a tenth, not vertically
		const scale = layerSourceScale({
			quadWidth: 108,
			quadHeight: 607.5,
			sourceWidth: 1920,
			sourceHeight: 1080,
			density: 0.8,
		});
		expect(scale).toBe(layerSourceScale({ ...owner, quadWidth: 108, density: 0.8 }));
		expect(scale).toBeGreaterThanOrEqual(0.5625 * 0.8 - 1e-9);
	});

	test("a portrait (rotated) video is described by its display size and scales the same way", () => {
		// 1080x1920 display size on a 1080x1920 canvas: quad = canvas
		expect(
			layerSourceScale({ quadWidth: 1080, quadHeight: 1920, sourceWidth: 1080, sourceHeight: 1920, density: 0.5 }),
		).toBe(0.5);
	});

	test("a zero-size quad (a scale keyframe at 0) needs the smallest frame, not a full one", () => {
		expect(layerSourceScale({ ...owner, quadWidth: 0, quadHeight: 0, density: 0.5 })).toBe(1 / 16);
		// squeezed flat on one side only: the other side decides
		expect(layerSourceScale({ ...owner, quadWidth: 0, density: 0.5 })).toBe(
			layerSourceScale({ ...owner, density: 0.5 }),
		);
	});

	test("an unusable quad or source (NaN, an infinite ratio) is full size", () => {
		expect(layerSourceScale({ ...owner, sourceWidth: 0, density: 0.5 })).toBe(1);
		expect(layerSourceScale({ ...owner, quadWidth: 0, quadHeight: 0, sourceWidth: 0, sourceHeight: 0, density: 0.5 })).toBe(1);
		expect(layerSourceScale({ ...owner, quadWidth: Number.NaN, density: 0.5 })).toBe(1);
		expect(layerSourceScale({ ...owner, quadWidth: Number.POSITIVE_INFINITY, density: 0.5 })).toBe(1);
	});

	test("never below the smallest scale of a raster bucket", () => {
		expect(
			layerSourceScale({ ...owner, quadWidth: 10, quadHeight: 6, density: 0.01 }),
		).toBe(1 / 16);
	});
});

describe("backdropSourceScale", () => {
	const owner = {
		canvasWidth: 1080,
		canvasHeight: 1920,
		sourceWidth: 1920,
		sourceHeight: 1080,
	};

	test("the owner's case with a strong blur (backdrop drawn 8 times smaller): 0.25 as the video", () => {
		// cover scale 1.78, texture 8 times smaller than the frame: 0.22 -> 0.25
		expect(backdropSourceScale({ ...owner, downscale: 8, density: 450 / 1080 })).toBe(0.25);
	});

	test("null density (paused, export): full size", () => {
		expect(backdropSourceScale({ ...owner, downscale: 8, density: null })).toBe(1);
	});

	test("unusable density: full size", () => {
		for (const density of [Number.NaN, 0, -3]) {
			expect(backdropSourceScale({ ...owner, downscale: 8, density })).toBe(1);
		}
	});

	test("a weak blur (no downscale) needs the cover-scaled frame: full size", () => {
		expect(backdropSourceScale({ ...owner, downscale: 1, density: 0.4 })).toBe(1);
	});

	test("a landscape frame on a landscape canvas, blur drawn 4 times smaller", () => {
		expect(
			backdropSourceScale({
				canvasWidth: 1920,
				canvasHeight: 1080,
				sourceWidth: 1920,
				sourceHeight: 1080,
				downscale: 4,
				density: 0.5,
			}),
		).toBe(0.25);
	});

	test("an unusable downscale counts as none", () => {
		expect(backdropSourceScale({ ...owner, downscale: Number.NaN, density: 0.4 })).toBe(1);
		expect(backdropSourceScale({ ...owner, downscale: 0, density: 0.4 })).toBe(1);
	});

	test("an empty source is full size", () => {
		expect(backdropSourceScale({ ...owner, sourceWidth: 0, downscale: 8, density: 0.4 })).toBe(1);
	});
});

describe("densityBucket", () => {
	test("null (full size) is the largest bucket", () => {
		expect(densityBucket(null)).toBe(Number.POSITIVE_INFINITY);
		expect(densityBucket(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
		expect(densityBucket(0)).toBe(Number.POSITIVE_INFINITY);
		expect(densityBucket(0.5)).toBeLessThan(densityBucket(null));
	});

	test("densities in the same power-of-sqrt-2 bucket are one bucket", () => {
		expect(densityBucket(0.43)).toBe(densityBucket(0.45));
		expect(densityBucket(0.43)).not.toBe(densityBucket(0.6));
	});
});
