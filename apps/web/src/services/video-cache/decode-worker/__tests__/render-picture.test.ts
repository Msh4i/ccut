import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCanvasCache, renderPicture } from "../render-picture";

// The picture a worker makes of a decoded sample: below full size the SAME
// drawing code as the main thread's preview frames (fill fit, high smoothing,
// the track's rotation) into a canvas of the scaled size, handed over as an
// ImageBitmap; at full size a VideoFrame for the main thread to draw.

type DrawCall = { fit: string; rotation: number | undefined; quality: string; canvasWidth: number };

const draws: DrawCall[] = [];
const writes: string[] = [];

class RecordingContext {
	private quality = "low";
	constructor(private readonly canvas: { width: number }) {}
	get imageSmoothingEnabled() {
		return true;
	}
	set imageSmoothingEnabled(value: boolean) {
		writes.push(`imageSmoothingEnabled=${value}`);
	}
	get imageSmoothingQuality() {
		return this.quality;
	}
	set imageSmoothingQuality(value: string) {
		writes.push(`imageSmoothingQuality=${value}`);
		this.quality = value;
	}
	resetTransform() {}
	clearRect() {}
	recordDraw({ fit, rotation }: { fit: string; rotation: number | undefined }) {
		draws.push({ fit, rotation, quality: this.quality, canvasWidth: this.canvas.width });
	}
}

class FakeOffscreenCanvas {
	width: number;
	height: number;
	bitmaps = 0;
	private readonly context: RecordingContext;
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
		this.context = new RecordingContext(this);
	}
	getContext() {
		return this.context;
	}
	transferToImageBitmap() {
		this.bitmaps += 1;
		return { width: this.width, height: this.height, close: () => {} };
	}
}

const original = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");

beforeAll(() => {
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: FakeOffscreenCanvas,
	});
});

afterAll(() => {
	if (original) Object.defineProperty(globalThis, "OffscreenCanvas", original);
	else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});

const DISPLAY = { width: 1920, height: 1080 };

function makeSample() {
	const state = { frames: 0, closed: 0 };
	const sample = {
		timestamp: 1,
		duration: 1 / 30,
		close: () => {
			state.closed += 1;
		},
		drawWithFit: (...args: [{ imageSmoothingQuality?: string } & object, { fit: string; rotation?: number }]) => {
			const [context, options] = args;
			if (context instanceof RecordingContext) context.recordDraw({ fit: options.fit, rotation: options.rotation });
		},
		toVideoFrame: () => {
			state.frames += 1;
			return new FakeVideoFrame();
		},
	};
	return { sample, state };
}

class FakeVideoFrame {
	close() {}
}

describe("renderPicture", () => {
	test("below full size: drawn with fill and high smoothing into a canvas of the scaled size, handed over as a bitmap", () => {
		draws.length = 0;
		writes.length = 0;
		const { sample, state } = makeSample();
		const sizes: Array<{ width: number; height: number }> = [];
		const result = renderPicture({
			sample,
			scale: 0.25,
			display: DISPLAY,
			rotation: 0,
			canvasFor: (size) => {
				sizes.push(size);
				return new OffscreenCanvas(size.width, size.height);
			},
		});
		expect(sizes).toEqual([{ width: 480, height: 270 }]);
		expect(draws).toEqual([{ fit: "fill", rotation: 0, quality: "high", canvasWidth: 480 }]);
		expect(writes).toEqual(["imageSmoothingEnabled=true", "imageSmoothingQuality=high"]);
		expect(result.image.kind).toBe("bitmap");
		expect(result.image.kind === "bitmap" && [result.image.bitmap.width, result.image.bitmap.height]).toEqual([480, 270]);
		// the bitmap is the one transferred; the sample is not closed (the main thread decides)
		expect(result.transfer).toHaveLength(1);
		expect(result.image.kind === "bitmap" && result.transfer[0] === result.image.bitmap).toBe(true);
		expect(state.closed).toBe(0);
	});

	test("the track's rotation goes to the drawing, and a quarter turn keeps the display size", () => {
		draws.length = 0;
		const { sample } = makeSample();
		renderPicture({
			sample,
			scale: 0.5,
			display: { width: 1080, height: 1920 },
			rotation: 90,
			canvasFor: (size) => new OffscreenCanvas(size.width, size.height),
		});
		expect(draws).toEqual([{ fit: "fill", rotation: 90, quality: "high", canvasWidth: 540 }]);
	});

	test("at full size: a VideoFrame of the sample, transferred; no canvas is made or drawn", () => {
		draws.length = 0;
		const { sample, state } = makeSample();
		let canvases = 0;
		const frame = new FakeVideoFrame();
		const result = renderPicture({
			sample: { ...sample, toVideoFrame: () => frame },
			scale: 1,
			display: DISPLAY,
			rotation: 0,
			canvasFor: (size) => {
				canvases += 1;
				return new OffscreenCanvas(size.width, size.height);
			},
		});
		void state;
		expect(canvases).toBe(0);
		expect(draws).toEqual([]);
		expect(result.image.kind).toBe("frame");
		expect(result.transfer).toEqual([frame]);
	});
});

describe("createCanvasCache", () => {
	test("a size is made once and reused", () => {
		const cache = createCanvasCache({ create: ({ width, height }) => new OffscreenCanvas(width, height) });
		const first = cache.canvasFor({ width: 480, height: 270 });
		expect(cache.canvasFor({ width: 480, height: 270 })).toBe(first);
		expect(cache.size()).toBe(1);
	});

	test("only the two most recent sizes are kept; a canvas that leaves is freed (0 x 0)", () => {
		const cache = createCanvasCache({ create: ({ width, height }) => new OffscreenCanvas(width, height) });
		const a = cache.canvasFor({ width: 100, height: 50 });
		const b = cache.canvasFor({ width: 200, height: 100 });
		cache.canvasFor({ width: 100, height: 50 });
		const c = cache.canvasFor({ width: 300, height: 150 });
		expect(cache.size()).toBe(2);
		// b was the least recently used
		expect(b.width).toBe(0);
		expect(b.height).toBe(0);
		expect(a.width).toBe(100);
		expect(c.width).toBe(300);
	});

	test("clear frees every canvas", () => {
		const cache = createCanvasCache({ create: ({ width, height }) => new OffscreenCanvas(width, height) });
		const a = cache.canvasFor({ width: 100, height: 50 });
		cache.clear();
		expect(a.width).toBe(0);
		expect(cache.size()).toBe(0);
	});
});
