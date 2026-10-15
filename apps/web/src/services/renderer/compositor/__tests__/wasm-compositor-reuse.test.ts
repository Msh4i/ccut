import { afterAll, describe, expect, mock, test } from "bun:test";
import * as opencutWasm from "opencut-wasm";
import type { TextureUploadDescriptor } from "../types";

// Lever b at the compositor: with `reuse` off every upload is the old
// `uploadTexture` (an ImageBitmap goes through the staging canvas as before);
// with it on the uploads go to `uploadTextureReuse` and a bitmap reaches the
// GPU as it is. The GPU side of opencut-wasm is a recording fake here (bun's
// module mocks are process-wide: undone after this file).

type Call = { fn: "uploadTexture" | "uploadTextureReuse"; id: string; source: unknown };

const realWasmExports = { ...opencutWasm };
const calls: Call[] = [];
/** What the fake `uploadTextureReuse` answers: true = copied into the existing texture. */
let reuseAnswers: boolean[] = [];

mock.module("opencut-wasm", () => ({
	...realWasmExports,
	getCompositorCanvas: () => ({}),
	getLastFrameProfile: () => [],
	initCompositor: () => {},
	releaseTexture: () => {},
	renderFrame: () => {},
	resizeCompositor: () => {},
	uploadTexture: ({ id, source }: { id: string; source: unknown }) => {
		calls.push({ fn: "uploadTexture", id, source });
	},
	uploadTextureReuse: ({ id, source }: { id: string; source: unknown }) => {
		calls.push({ fn: "uploadTextureReuse", id, source });
		return reuseAnswers.shift() ?? false;
	},
}));

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	getContext() {
		return { clearRect: () => {}, drawImage: () => {}, fillRect: () => {} };
	}
}

/** A closed bitmap reports 0x0. */
class FakeImageBitmap {
	width: number;
	height: number;
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	close() {
		this.width = 0;
		this.height = 0;
	}
}

/** Not an OffscreenCanvas nor an ImageBitmap (an image element, an HTMLCanvasElement). */
class ForeignImage {
	readonly width = 4;
	readonly height = 4;
}

const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
const originalImageBitmap = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
Object.defineProperty(globalThis, "OffscreenCanvas", {
	configurable: true,
	writable: true,
	value: FakeOffscreenCanvas,
});
Object.defineProperty(globalThis, "ImageBitmap", {
	configurable: true,
	writable: true,
	value: FakeImageBitmap,
});

afterAll(() => {
	mock.module("opencut-wasm", () => realWasmExports);
	for (const [name, original] of [
		["OffscreenCanvas", originalOffscreenCanvas],
		["ImageBitmap", originalImageBitmap],
	] as const) {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	}
});

let instances = 0;
async function createCompositor() {
	const compositorModule: typeof import("../wasm-compositor") = await import(
		`../wasm-compositor?reuse-${instances++}`
	);
	calls.length = 0;
	reuseAnswers = [];
	return compositorModule.wasmCompositor;
}

const SIZE = 4;

/** Reflect.construct hands back `any`: the fakes stand in for the DOM classes. */
function createBitmap(): ImageBitmap {
	return Reflect.construct(ImageBitmap, [SIZE, SIZE]);
}

function createForeignImage(): CanvasImageSource {
	return Object.create(ForeignImage.prototype);
}

function external({
	id,
	source,
	version = 1,
}: {
	id: string;
	source: CanvasImageSource;
	version?: number;
}): TextureUploadDescriptor {
	return { kind: "external", id, source, width: SIZE, height: SIZE, version };
}

function rendered(id: string): TextureUploadDescriptor {
	return { kind: "rendered", id, width: SIZE, height: SIZE, contentHash: "h", draw: () => {} };
}

describe("reuse off: today's uploads", () => {
	test("canvas, bitmap and rendered textures all go through uploadTexture; the bitmap is staged, never passed on", async () => {
		const compositor = await createCompositor();
		const canvas = new OffscreenCanvas(SIZE, SIZE);
		const bitmap = createBitmap();
		compositor.syncTextures({
			textures: [external({ id: "a", source: canvas }), external({ id: "b", source: bitmap }), rendered("c")],
			reuse: false,
		});
		expect(calls.map((call) => `${call.fn}:${call.id}`)).toEqual([
			"uploadTexture:a",
			"uploadTexture:b",
			"uploadTexture:c",
		]);
		expect(calls[0].source).toBe(canvas);
		expect(calls[1].source).not.toBe(bitmap);
		expect(calls[1].source).toBeInstanceOf(FakeOffscreenCanvas);
		const stats = compositor.getUploadStats();
		expect([stats.reused, stats.created, stats.staging]).toEqual([0, 0, 1]);
	});

	test("a closed bitmap is staged like before (no new skip rule without the lever)", async () => {
		const compositor = await createCompositor();
		const bitmap = createBitmap();
		bitmap.close();
		compositor.syncTextures({ textures: [external({ id: "a", source: bitmap })], reuse: false });
		expect(calls.map((call) => call.fn)).toEqual(["uploadTexture"]);
	});
});

describe("reuse on", () => {
	test("uploads go to uploadTextureReuse; a bitmap and a canvas are passed as they are", async () => {
		const compositor = await createCompositor();
		const canvas = new OffscreenCanvas(SIZE, SIZE);
		const bitmap = createBitmap();
		compositor.syncTextures({
			textures: [external({ id: "a", source: canvas }), external({ id: "b", source: bitmap }), rendered("c")],
			reuse: true,
		});
		expect(calls.map((call) => `${call.fn}:${call.id}`)).toEqual([
			"uploadTextureReuse:a",
			"uploadTextureReuse:b",
			"uploadTextureReuse:c",
		]);
		expect(calls[0].source).toBe(canvas);
		expect(calls[1].source).toBe(bitmap);
		expect(compositor.getUploadStats().staging).toBe(0);
	});

	test("another source (an image) is staged into a canvas first", async () => {
		const compositor = await createCompositor();
		compositor.syncTextures({ textures: [external({ id: "a", source: createForeignImage() })], reuse: true });
		expect(calls[0].fn).toBe("uploadTextureReuse");
		expect(calls[0].source).toBeInstanceOf(FakeOffscreenCanvas);
		expect(compositor.getUploadStats().staging).toBe(1);
	});

	test("reused and created follow what the GPU side answers", async () => {
		const compositor = await createCompositor();
		reuseAnswers = [false, true, true];
		for (const version of [1, 2, 3]) {
			compositor.syncTextures({
				textures: [external({ id: "a", source: createBitmap(), version })],
				reuse: true,
			});
		}
		const stats = compositor.getUploadStats();
		expect([stats.reused, stats.created]).toEqual([2, 1]);
	});

	test("a closed bitmap (0x0) never reaches the GPU copy: the layer keeps its texture", async () => {
		const compositor = await createCompositor();
		const bitmap = createBitmap();
		bitmap.close();
		compositor.syncTextures({ textures: [external({ id: "a", source: bitmap })], reuse: true });
		expect(calls).toEqual([]);
		expect(compositor.getUploadStats().skippedResized).toBe(1);
	});
});
