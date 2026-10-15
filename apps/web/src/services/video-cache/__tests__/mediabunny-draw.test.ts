import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { frameDrawPlan, wrapSample, type DrawableSample } from "../mediabunny-source";

// How a decoded frame is drawn into the canvas the cache gives it: a canvas of
// the video's display size exactly as before the preview used smaller ones (the
// contain fit, the 2D context left as it is), a smaller canvas with the fill
// fit and the high-quality smoothing filter.

type DrawCall = { fit: string; rotation: number | undefined; quality: string; smoothing: boolean };

const calls: DrawCall[] = [];
const contextWrites: string[] = [];

class RecordingContext {
	private smoothing = true;
	private smoothingQuality = "low";
	get imageSmoothingEnabled() {
		return this.smoothing;
	}
	set imageSmoothingEnabled(value: boolean) {
		contextWrites.push(`imageSmoothingEnabled=${value}`);
		this.smoothing = value;
	}
	get imageSmoothingQuality() {
		return this.smoothingQuality;
	}
	set imageSmoothingQuality(value: string) {
		contextWrites.push(`imageSmoothingQuality=${value}`);
		this.smoothingQuality = value;
	}
	resetTransform() {}
	clearRect() {}
}

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	readonly context = new RecordingContext();
	// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	getContext() {
		return this.context;
	}
}

const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");

beforeAll(() => {
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: FakeOffscreenCanvas,
	});
});

afterAll(() => {
	if (originalOffscreenCanvas) {
		Object.defineProperty(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	} else {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	}
});

const DISPLAY = { width: 1920, height: 1080 };

function drawOnto({
	width,
	height,
	display = DISPLAY,
	rotation = 0,
}: {
	width: number;
	height: number;
	display?: { width: number; height: number };
	rotation?: 0 | 90 | 180 | 270;
}): DrawCall[] {
	calls.length = 0;
	contextWrites.length = 0;
	const sample: DrawableSample = {
		timestamp: 0,
		duration: 1 / 30,
		close: () => {},
		// mediabunny's signature is (context, options): taken as one tuple here
		drawWithFit: (...args) => {
			const [context, options] = args;
			calls.push({
				fit: options.fit,
				rotation: options.rotation,
				quality: context.imageSmoothingQuality,
				smoothing: context.imageSmoothingEnabled,
			});
		},
	};
	wrapSample({ sample, rotation, display }).drawInto(new OffscreenCanvas(width, height));
	return [...calls];
}

describe("frameDrawPlan", () => {
	test("a canvas of the display size is drawn as always", () => {
		expect(frameDrawPlan({ canvas: DISPLAY, display: DISPLAY })).toEqual({ fit: "contain" });
	});

	test("a smaller canvas gets the whole frame stretched over it, high quality", () => {
		expect(
			frameDrawPlan({ canvas: { width: 480, height: 270 }, display: DISPLAY }),
		).toEqual({ fit: "fill", quality: "high" });
	});

	test("a canvas that differs in one side only is a scaled canvas", () => {
		expect(
			frameDrawPlan({ canvas: { width: 1920, height: 1079 }, display: DISPLAY }),
		).toEqual({ fit: "fill", quality: "high" });
	});
});

describe("drawing a decoded frame", () => {
	test("at the display size: contain fit and a context nobody touched", () => {
		const [call] = drawOnto({ width: 1920, height: 1080 });
		expect(call).toMatchObject({ fit: "contain", quality: "low", smoothing: true });
		expect(contextWrites).toEqual([]);
	});

	test("scaled: fill fit with the high-quality smoothing filter set before the draw", () => {
		const [call] = drawOnto({ width: 480, height: 270 });
		expect(call).toMatchObject({ fit: "fill", quality: "high", smoothing: true });
		expect(contextWrites).toEqual(["imageSmoothingEnabled=true", "imageSmoothingQuality=high"]);
	});

	test("the track's rotation is passed on in both modes", () => {
		const portrait = { width: 1080, height: 1920 };
		expect(drawOnto({ width: 1080, height: 1920, display: portrait, rotation: 90 })[0]).toMatchObject({
			fit: "contain",
			rotation: 90,
		});
		expect(drawOnto({ width: 270, height: 480, display: portrait, rotation: 90 })[0]).toMatchObject({
			fit: "fill",
			rotation: 90,
		});
	});

	test("closing the frame closes the sample once", () => {
		let closed = 0;
		const sample: DrawableSample = {
			timestamp: 0,
			duration: 1,
			close: () => {
				closed += 1;
			},
			drawWithFit: () => {},
		};
		wrapSample({ sample, rotation: 0, display: DISPLAY }).close();
		expect(closed).toBe(1);
	});
});
