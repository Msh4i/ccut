import { afterAll, describe, expect, mock, test } from "bun:test";
import * as opencutWasm from "opencut-wasm";
import type { FrameDescriptor } from "../types";

// WasmCompositor sits between the scene and the GPU: it decides which layer
// textures are uploaded again and keeps the draw serial the preview uses to
// learn whether the shared canvas still shows its picture. The GPU side of
// opencut-wasm is replaced here by recorders; everything else is the real
// module. Both the replacement and the OffscreenCanvas stand-in are undone
// after this file (bun's module mocks are process-wide).

type Upload = { id: string; frame: number | undefined };

const realWasmExports = { ...opencutWasm };

const uploads: Upload[] = [];
const uploadedSources: unknown[] = [];
const released: string[] = [];
let renderedFrames = 0;
let failNextRender = false;
// Which video frame (timestamp) a canvas holds right now.
const framesOnCanvas = new WeakMap<object, number>();

// The output canvas: like the Rust side, init and resize set its size, and a
// draw resizes it to the frame's size first (compositor.rs render_frame).
const outputCanvas = { width: 0, height: 0 };
const resizes: Array<[number, number]> = [];
function setOutputSize(...[width, height]: [number, number]) {
	outputCanvas.width = width;
	outputCanvas.height = height;
}

mock.module("opencut-wasm", () => ({
	...realWasmExports,
	getCompositorCanvas: () => outputCanvas,
	getLastFrameProfile: () => [],
	initCompositor: setOutputSize,
	releaseTexture: (id: string) => {
		released.push(id);
	},
	renderFrame: (frame: FrameDescriptor) => {
		if (failNextRender) {
			failNextRender = false;
			throw new Error("the GPU lost the frame");
		}
		setOutputSize(frame.width, frame.height);
		renderedFrames += 1;
	},
	resizeCompositor: (...[width, height]: [number, number]) => {
		resizes.push([width, height]);
		setOutputSize(width, height);
	},
	uploadTexture: ({ id, source }: { id: string; source: unknown }) => {
		const frame =
			typeof source === "object" && source !== null
				? framesOnCanvas.get(source)
				: undefined;
		uploads.push({ id, frame });
		uploadedSources.push(source);
	},
}));

let canvasesCreated = 0;

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
		canvasesCreated += 1;
	}

	// A 2D context that copies the frame mark of what is drawn into it.
	getContext() {
		return {
			clearRect: () => {
				framesOnCanvas.delete(this);
			},
			drawImage: (source: object) => {
				const frame = framesOnCanvas.get(source);
				if (frame !== undefined) framesOnCanvas.set(this, frame);
			},
		};
	}
}

/**
 * A canvas the compositor cannot hand to the GPU as is (an HTMLCanvasElement,
 * an image): not an instance of the OffscreenCanvas class in use.
 */
class ForeignCanvas {
	readonly width: number;
	readonly height: number;
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
}

function createForeignCanvas({
	width,
	height,
	frame,
}: {
	width: number;
	height: number;
	frame: number;
}): OffscreenCanvas {
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: ForeignCanvas,
	});
	try {
		const canvas = new OffscreenCanvas(width, height);
		framesOnCanvas.set(canvas, frame);
		return canvas;
	} finally {
		Object.defineProperty(globalThis, "OffscreenCanvas", {
			configurable: true,
			writable: true,
			value: FakeOffscreenCanvas,
		});
	}
}

const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(
	globalThis,
	"OffscreenCanvas",
);
Object.defineProperty(globalThis, "OffscreenCanvas", {
	configurable: true,
	writable: true,
	value: FakeOffscreenCanvas,
});

afterAll(() => {
	mock.module("opencut-wasm", () => realWasmExports);
	if (originalOffscreenCanvas) {
		Object.defineProperty(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	} else {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	}
});

// Every test gets its own compositor (fresh module instance, empty texture
// cache, serial 0), and nothing is shared with the app's singleton.
let instances = 0;
async function createCompositor() {
	const compositorModule: typeof import("../wasm-compositor") = await import(
		`../wasm-compositor?wiring-${instances++}`
	);
	uploads.length = 0;
	uploadedSources.length = 0;
	released.length = 0;
	renderedFrames = 0;
	failNextRender = false;
	canvasesCreated = 0;
	resizes.length = 0;
	setOutputSize(0, 0);
	return compositorModule.wasmCompositor;
}

const SIZE = 4;
const LAYER = "root:0:source";

function emptyFrame(): FrameDescriptor {
	return {
		width: SIZE,
		height: SIZE,
		clear: { color: [0, 0, 0, 1] },
		items: [],
	};
}

// The video frame cache hands decoded frames out in three canvases
// (CANVAS_POOL_SIZE), round robin, and draws later frames over them.
function createDecoderPool() {
	const canvases = [
		new OffscreenCanvas(SIZE, SIZE),
		new OffscreenCanvas(SIZE, SIZE),
		new OffscreenCanvas(SIZE, SIZE),
	];
	let next = 0;
	return {
		canvases,
		decode(timestamp: number) {
			const canvas = canvases[next];
			next = (next + 1) % canvases.length;
			framesOnCanvas.set(canvas, timestamp);
			return { canvas, timestamp };
		},
	};
}

function videoLayer({
	canvas,
	timestamp,
}: {
	canvas: OffscreenCanvas;
	timestamp: number;
}) {
	return {
		kind: "external" as const,
		id: LAYER,
		source: canvas,
		width: SIZE,
		height: SIZE,
		version: timestamp,
	};
}

describe("video frames from a pool of three canvases", () => {
	test("every new frame while playing is uploaded", async () => {
		const compositor = await createCompositor();
		const pool = createDecoderPool();
		for (let frame = 0; frame < 4; frame++) {
			compositor.syncTextures({ textures: [videoLayer(pool.decode(frame))], reuse: false });
		}
		expect(uploads.map((upload) => upload.frame)).toEqual([0, 1, 2, 3]);
	});

	test("a seek that lands on the cached canvas with another frame reloads it", async () => {
		const compositor = await createCompositor();
		const pool = createDecoderPool();
		// playing: frames 0..3 went through the three canvases, the last shown
		// frame (3) sits in canvas 0 and is what the compositor has cached
		for (let frame = 0; frame < 4; frame++) {
			compositor.syncTextures({ textures: [videoLayer(pool.decode(frame))], reuse: false });
		}
		// the iterator reads two frames ahead, then a seek restarts it: the next
		// frame lands in canvas 0 again, but now holds frame 7
		pool.decode(4);
		pool.decode(5);
		const sought = pool.decode(7);
		expect(sought.canvas).toBe(pool.canvases[0]);

		uploads.length = 0;
		compositor.syncTextures({ textures: [videoLayer(sought)], reuse: false });
		expect(uploads).toEqual([{ id: LAYER, frame: 7 }]);
	});

	test("the same frame landing on the same canvas again is not uploaded again", async () => {
		const compositor = await createCompositor();
		const pool = createDecoderPool();
		for (let frame = 0; frame < 4; frame++) {
			compositor.syncTextures({ textures: [videoLayer(pool.decode(frame))], reuse: false });
		}
		// two frames read ahead, then back to frame 3: canvas 0 still holds it
		pool.decode(4);
		pool.decode(5);
		const again = pool.decode(3);
		expect(again.canvas).toBe(pool.canvases[0]);

		uploads.length = 0;
		compositor.syncTextures({ textures: [videoLayer(again)], reuse: false });
		expect(uploads).toEqual([]);
	});

	test("a seek that lands on another canvas is uploaded", async () => {
		const compositor = await createCompositor();
		const pool = createDecoderPool();
		for (let frame = 0; frame < 4; frame++) {
			compositor.syncTextures({ textures: [videoLayer(pool.decode(frame))], reuse: false });
		}
		pool.decode(4);
		pool.decode(5);
		pool.decode(6);
		const sought = pool.decode(0);
		expect(sought.canvas).toBe(pool.canvases[1]);

		uploads.length = 0;
		compositor.syncTextures({ textures: [videoLayer(sought)], reuse: false });
		expect(uploads).toEqual([{ id: LAYER, frame: 0 }]);
	});

	test("a layer that leaves the frame is released and uploaded again when it returns", async () => {
		const compositor = await createCompositor();
		const pool = createDecoderPool();
		const frame = pool.decode(0);
		compositor.syncTextures({ textures: [videoLayer(frame)], reuse: false });
		compositor.syncTextures({ textures: [], reuse: false });
		expect(released).toEqual([LAYER]);
		compositor.syncTextures({ textures: [videoLayer(frame)], reuse: false });
		expect(uploads.map((upload) => upload.frame)).toEqual([0, 0]);
	});
});

describe("textures that never change", () => {
	test("a still image is uploaded once, however many frames are drawn", async () => {
		const compositor = await createCompositor();
		const image = new OffscreenCanvas(8, 8);
		const still = {
			kind: "external" as const,
			id: "root:1:source",
			source: image,
			width: 8,
			height: 8,
			version: undefined,
		};
		for (let draw = 0; draw < 100; draw++) {
			compositor.syncTextures({ textures: [still], reuse: false });
			compositor.render(emptyFrame());
		}
		expect(uploads).toHaveLength(1);
		expect(renderedFrames).toBe(100);
	});
});

describe("draw serial", () => {
	test("render() counts one draw and returns the serial right after it", async () => {
		const compositor = await createCompositor();
		compositor.ensureInitialized({ width: SIZE, height: SIZE });
		const before = compositor.getDrawSerial();

		const first = compositor.render(emptyFrame());
		expect(first).toBe(before + 1);
		expect(compositor.getDrawSerial()).toBe(before + 1);

		const second = compositor.render(emptyFrame());
		expect(second).toBe(before + 2);
		expect(compositor.getDrawSerial()).toBe(before + 2);
		expect(renderedFrames).toBe(2);
	});

	test("the first initialization counts: the canvas did not exist before", async () => {
		const compositor = await createCompositor();
		expect(compositor.getDrawSerial()).toBe(0);
		compositor.ensureInitialized({ width: SIZE, height: SIZE });
		expect(compositor.getDrawSerial()).toBe(1);
	});

	test("initializing again with the same size leaves the canvas, and the serial, alone", async () => {
		const compositor = await createCompositor();
		compositor.ensureInitialized({ width: SIZE, height: SIZE });
		const serial = compositor.getDrawSerial();
		compositor.ensureInitialized({ width: SIZE, height: SIZE });
		compositor.ensureInitialized({ width: SIZE, height: SIZE });
		expect(compositor.getDrawSerial()).toBe(serial);
	});

	test("a size change clears the canvas, so it counts", async () => {
		const compositor = await createCompositor();
		compositor.ensureInitialized({ width: SIZE, height: SIZE });
		const serial = compositor.getDrawSerial();
		compositor.ensureInitialized({ width: SIZE * 2, height: SIZE });
		expect(compositor.getDrawSerial()).toBe(serial + 1);
		compositor.ensureInitialized({ width: SIZE * 2, height: SIZE });
		expect(compositor.getDrawSerial()).toBe(serial + 1);
	});

	test("after a smaller draw (the display-size preview) a full-size caller gets a full-size canvas back", async () => {
		const compositor = await createCompositor();
		compositor.ensureInitialized({ width: SIZE * 2, height: SIZE * 2 });
		compositor.render({ ...emptyFrame(), width: SIZE, height: SIZE });
		expect([outputCanvas.width, outputCanvas.height]).toEqual([SIZE, SIZE]);
		const serial = compositor.getDrawSerial();
		compositor.ensureInitialized({ width: SIZE * 2, height: SIZE * 2 });
		expect(resizes).toEqual([[SIZE * 2, SIZE * 2]]);
		expect([outputCanvas.width, outputCanvas.height]).toEqual([SIZE * 2, SIZE * 2]);
		expect(compositor.getDrawSerial()).toBe(serial + 1);
	});

	test("syncing textures does not change the canvas, so it does not count", async () => {
		const compositor = await createCompositor();
		compositor.ensureInitialized({ width: SIZE, height: SIZE });
		const serial = compositor.getDrawSerial();
		const pool = createDecoderPool();
		compositor.syncTextures({ textures: [videoLayer(pool.decode(0))], reuse: false });
		expect(compositor.getDrawSerial()).toBe(serial);
	});
});

describe("sources that are not OffscreenCanvases", () => {
	function foreignLayer({
		frame,
		size = SIZE,
	}: {
		frame: number;
		size?: number;
	}) {
		return {
			kind: "external" as const,
			id: LAYER,
			source: createForeignCanvas({ width: size, height: size, frame }),
			width: size,
			height: size,
			version: frame,
		};
	}

	test("are copied into one staging canvas per layer, reused for every new frame", async () => {
		const compositor = await createCompositor();
		for (let frame = 0; frame < 5; frame++) {
			compositor.syncTextures({ textures: [foreignLayer({ frame })], reuse: false });
		}
		expect(uploads.map((upload) => upload.frame)).toEqual([0, 1, 2, 3, 4]);
		expect(canvasesCreated).toBe(1);
		expect(new Set(uploadedSources).size).toBe(1);
	});

	test("a new size gets a new staging canvas", async () => {
		const compositor = await createCompositor();
		compositor.syncTextures({ textures: [foreignLayer({ frame: 0 })], reuse: false });
		compositor.syncTextures({ textures: [foreignLayer({ frame: 1, size: SIZE * 2 })], reuse: false });
		expect(canvasesCreated).toBe(2);
		expect(uploads.map((upload) => upload.frame)).toEqual([0, 1]);
		expect(uploadedSources[0]).not.toBe(uploadedSources[1]);
	});

	test("a layer that leaves the frame drops its staging canvas", async () => {
		const compositor = await createCompositor();
		compositor.syncTextures({ textures: [foreignLayer({ frame: 0 })], reuse: false });
		compositor.syncTextures({ textures: [], reuse: false });
		compositor.syncTextures({ textures: [foreignLayer({ frame: 1 })], reuse: false });
		expect(canvasesCreated).toBe(2);
	});

	test("an OffscreenCanvas source is uploaded as is, without a copy", async () => {
		const compositor = await createCompositor();
		const pool = createDecoderPool();
		canvasesCreated = 0;
		const frame = pool.decode(0);
		compositor.syncTextures({ textures: [videoLayer(frame)], reuse: false });
		expect(uploadedSources).toEqual([frame.canvas]);
		expect(canvasesCreated).toBe(0);
	});
});

describe("upload counters", () => {
	test("count uploads and uploaded pixels, not cache hits", async () => {
		const compositor = await createCompositor();
		const pool = createDecoderPool();
		const first = compositor.getUploadStats();
		const frame = pool.decode(0);
		compositor.syncTextures({ textures: [videoLayer(frame)], reuse: false });
		compositor.syncTextures({ textures: [videoLayer(frame)], reuse: false });
		compositor.syncTextures({ textures: [videoLayer(pool.decode(1))], reuse: false });
		const after = compositor.getUploadStats();
		expect(after.uploads - first.uploads).toBe(2);
		expect(after.uploadedPixels - first.uploadedPixels).toBe(2 * SIZE * SIZE);
	});
});

describe("a video canvas resized since its layer was described", () => {
	test("is not uploaded (a 0x0 canvas would fail the GPU copy), and is counted", async () => {
		const compositor = await createCompositor();
		const canvas = new OffscreenCanvas(SIZE, SIZE);
		framesOnCanvas.set(canvas, 1);
		compositor.syncTextures({ textures: [videoLayer({ canvas, timestamp: 1 })], reuse: false });
		expect(uploads).toEqual([{ id: LAYER, frame: 1 }]);
		// The frame cache destroyed it (width and height 0) before this upload.
		const destroyed = new OffscreenCanvas(0, 0);
		compositor.syncTextures({ textures: [{ ...videoLayer({ canvas: destroyed, timestamp: 2 }) }], reuse: false });
		expect(uploads).toEqual([{ id: LAYER, frame: 1 }]);
		expect(compositor.getUploadStats().skippedResized).toBe(1);
	});
});
