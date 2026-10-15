import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-web";
import { findOrtDist } from "../../../../scripts/ort-dist.mjs";
import { applyMattes } from "../../matte/matte-registry";
import { LONG_CLIP_FRAMES } from "../constants";
import { isSceneCut, letterboxLayout, outputToMatte, smoothMatte } from "../matte-math";
import { chooseStride, SequenceMatteSource } from "../matte-sequence";
import { MemoryMatteStore, matteKey } from "../matte-store";
import { type CutoutDeps, loadCutout, runCutout } from "../run-cutout";

// The real pipeline with a tiny stub model (stub-matte.onnx: output = mean of the normalised
// channels) on the same onnxruntime-web the worker uses.

// `InferenceSession.create` replaces `globalThis.Worker` (measured). bun runs every test file in one
// process, so other files that mock Worker (beat detection) would hang after this one. Whatever a test
// here changes on globalThis is put back after it.
let savedGlobals: Map<string, PropertyDescriptor> | null = null;
beforeEach(() => {
	savedGlobals = new Map();
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
		if (descriptor) savedGlobals.set(name, descriptor);
	}
});
afterEach(() => {
	const saved = savedGlobals;
	savedGlobals = null;
	if (!saved) return;
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		if (!saved.has(name)) Reflect.deleteProperty(globalThis, name);
	}
	for (const [name, descriptor] of saved) {
		const now = Object.getOwnPropertyDescriptor(globalThis, name);
		if (!now || now.value !== descriptor.value || now.get !== descriptor.get || now.set !== descriptor.set) {
			Object.defineProperty(globalThis, name, descriptor);
		}
	}
});

ort.env.wasm.numThreads = 1;
// wherever the package manager put it (apps/web/node_modules or the hoisted root one)
ort.env.wasm.wasmPaths = `${findOrtDist({ from: import.meta.dir })}/`;

async function stubInfer(): Promise<CutoutDeps["infer"]> {
	const session = await ort.InferenceSession.create(readFileSync(join(import.meta.dir, "stub-matte.onnx")), {
		executionProviders: ["wasm"],
	});
	const input = session.inputNames[0] ?? "";
	const output = session.outputNames[0] ?? "";
	return async ({ tensor }) => {
		const result = await session.run({ [input]: new ort.Tensor("float32", tensor, [1, 3, 320, 320]) });
		const data = result[output]?.data;
		if (!(data instanceof Float32Array)) throw new Error("no output");
		return data;
	};
}

/** A 320x320 letterboxed frame: a bright square on dark, the square moves with the second. */
function frame({ sourceSeconds, size, bright = true }: { sourceSeconds: number; size: number; bright?: boolean }) {
	const rgba = new Uint8ClampedArray(size * size * 4);
	const left = 40 + Math.round(sourceSeconds * 10);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const inside = bright && x >= left && x < left + 100 && y >= 60 && y < 160;
			const i = (y * size + x) * 4;
			rgba[i] = rgba[i + 1] = rgba[i + 2] = inside ? 230 : 20;
			rgba[i + 3] = 255;
		}
	}
	return rgba;
}

const RUN = { key: "m|0-1|u2netp|x", mediaWidth: 640, mediaHeight: 360, fps: 10, startSeconds: 2, durationSeconds: 1 };

describe("smart cutout pipeline", () => {
	test("a 16:9 clip is letterboxed into 320 x 180 and the matte separates the bright subject", async () => {
		const infer = await stubInfer();
		const store = new MemoryMatteStore();
		const outcome = await runCutout({ run: RUN, deps: { store, infer, grab: async (a) => frame(a) } });
		if (outcome.status !== "done") throw new Error("not done");
		const first = outcome.source.lookup({ sourceSeconds: 2 });
		expect(first?.width).toBe(320);
		expect(first?.height).toBe(180);
		const data = first?.data ?? new Uint8Array();
		// letterbox bars are cut off: row 0 of the matte is model row 70; the subject is at x 40..140, y 60..160 -> matte y -10..90
		expect(data[40 * 320 + 80]).toBeGreaterThan(200); // inside the subject (model y 110, x 80)
		expect(data[10 * 320 + 250]).toBeLessThan(40); // background
	});

	test("a finished run is read back from the store without grabbing or inferring again", async () => {
		const infer = await stubInfer();
		const store = new MemoryMatteStore();
		await runCutout({ run: RUN, deps: { store, infer, grab: async (a) => frame(a) } });
		let grabs = 0;
		const again = await runCutout({ run: RUN, deps: { store, infer, grab: async (a) => (grabs++, frame(a)) } });
		expect(grabs).toBe(0);
		expect(again.status === "done" && again.fromCache).toBe(true);
		expect(await loadCutout({ key: "other", store })).toBeNull();
	});

	test("cancelling leaves nothing in the store", async () => {
		const infer = await stubInfer();
		const store = new MemoryMatteStore();
		const controller = new AbortController();
		let grabs = 0;
		const outcome = await runCutout({
			run: RUN,
			deps: {
				store,
				infer,
				signal: controller.signal,
				grab: async (a) => {
					grabs++;
					if (grabs === 3) controller.abort();
					return frame(a);
				},
			},
		});
		expect(outcome.status).toBe("cancelled");
		expect(store.entries.size).toBe(0);
	});

	test("the key separates media, range, model and model file", () => {
		const base = { mediaId: "m", trimStartTicks: 0, trimEndTicks: 10 };
		const keys = new Set([
			matteKey(base),
			matteKey({ ...base, mediaId: "n" }),
			matteKey({ ...base, trimEndTicks: 11 }),
			matteKey({ ...base, modelId: "other" }),
			matteKey({ ...base, modelSha256: "00" }),
		]);
		expect(keys.size).toBe(5);
	});
});

describe("matte maths", () => {
	test("a flat model output keeps nothing; min-max stretches the rest to 0..255", () => {
		const box = letterboxLayout({ width: 100, height: 100, size: 4 });
		expect([...outputToMatte({ output: new Float32Array(16).fill(0.3), box })]).toEqual(new Array(16).fill(0));
		const ramp = Float32Array.from({ length: 16 }, (_, i) => -2 + i);
		const matte = outputToMatte({ output: ramp, box });
		expect(matte[0]).toBe(0);
		expect(matte[15]).toBe(255);
	});

	test("smoothing weighs the current frame 0.6; a scene cut is detected from the fingerprint", () => {
		const out = smoothMatte({ previous: Uint8Array.from([0]), current: Uint8Array.from([100]), alpha: 0.6 });
		expect(out[0]).toBe(60);
		expect(isSceneCut({ previous: new Float32Array(4).fill(0.1), current: new Float32Array(4).fill(0.9) })).toBe(true);
		expect(isSceneCut({ previous: new Float32Array(4).fill(0.1), current: new Float32Array(4).fill(0.15) })).toBe(false);
	});

	test("after a scene cut the first matte is not blended with the old picture", async () => {
		const infer = await stubInfer();
		const store = new MemoryMatteStore();
		// seconds 2.0..2.4 a bright subject on dark, from 2.5 on one flat bright picture (a cut)
		const grab = async ({ sourceSeconds, size }: { sourceSeconds: number; size: number }) =>
			sourceSeconds < 2.45 ? frame({ sourceSeconds, size }) : new Uint8ClampedArray(size * size * 4).fill(230);
		const outcome = await runCutout({ run: RUN, deps: { store, infer, grab } });
		if (outcome.status !== "done") throw new Error("not done");
		// the flat picture's own output is flat -> all zero; blending with the previous would leave leftovers
		const after = outcome.source.lookup({ sourceSeconds: 2.5 })?.data ?? new Uint8Array([1]);
		expect(Math.max(...after)).toBe(0);
	});

	test("long clips get every 2nd frame, in-between frames are interpolated; memory bound widens the stride", () => {
		expect(chooseStride({ frameCount: LONG_CLIP_FRAMES, matteBytes: 10 })).toBe(1);
		expect(chooseStride({ frameCount: LONG_CLIP_FRAMES + 1, matteBytes: 10 })).toBe(2);
		expect(chooseStride({ frameCount: 1000, matteBytes: 1000, maxBytes: 100_000 })).toBe(10);
		const source = new SequenceMatteSource({ id: "s", meta: { width: 1, height: 1, fps: 10, startSeconds: 0, stride: 2, frameCount: 5 } });
		source.set({ index: 0, data: Uint8Array.from([0]) });
		source.set({ index: 2, data: Uint8Array.from([100]) });
		expect(source.lookup({ sourceSeconds: 0.1 })?.data[0]).toBe(50);
		expect(source.lookup({ sourceSeconds: -1 })?.data[0]).toBe(0);
		expect(source.lookup({ sourceSeconds: 9 })?.data[0]).toBe(100);
	});

	test("applying a matte multiplies it into the alpha, scaled up to the picture", () => {
		const pixels = new Uint8ClampedArray(4 * 2 * 4).fill(255);
		applyMattes({ pixels, width: 4, height: 2, mattes: [{ width: 2, height: 1, data: Uint8Array.from([0, 255]), hash: "h" }] });
		const alphas = [3, 7, 11, 15].map((i) => pixels[i]);
		expect(alphas[0]).toBe(0);
		expect(alphas[3]).toBe(255);
		expect(alphas[1]).toBeLessThan(alphas[2] ?? 0);
	});
});

describe("a matte in the texture the preview and the export both build", () => {
	test("multiplies into the alpha without a colour key, and the cache key follows the matte", async () => {
		const { keyedSourceTexture } = await import("@/services/renderer/compositor/frame-descriptor");
		const image = { data: new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 255]) };
		const ctx = Object.assign(Object.create(null), {
			drawImage: () => {},
			getImageData: () => image,
			putImageData: () => {},
		});
		const source: CanvasImageSource = Object.create(null);
		const make = (hash: string) =>
			keyedSourceTexture({
				id: "t",
				source,
				width: 2,
				height: 1,
				version: 1,
				settings: null,
				mattes: [{ width: 2, height: 1, data: Uint8Array.from([0, 255]), hash }],
			});
		const texture = make("a");
		if (texture.kind !== "rendered") throw new Error("expected a rendered texture");
		texture.draw(ctx);
		expect([image.data[3], image.data[7]]).toEqual([0, 255]);
		const other = make("b");
		expect(other.kind === "rendered" && other.contentHash).not.toBe(texture.contentHash);
	});
});

describe("hostile or damaged input", () => {
	test("a huge frame count or rate cannot make the stride search slow; the analysed frames stay bounded", () => {
		const started = performance.now();
		for (const frameCount of [1e9, Number.POSITIVE_INFINITY, Number.NaN, 5e6]) {
			const stride = chooseStride({ frameCount, matteBytes: 57_600 });
			expect(Number.isInteger(stride) && stride >= 1).toBe(true);
		}
		expect(performance.now() - started).toBeLessThan(50);
		expect(Math.ceil(10_000_000 / chooseStride({ frameCount: 10_000_000, matteBytes: 57_600 }))).toBeLessThanOrEqual(20_000 + 1);
	});

	test("a stored meta with stride 0, NaN, a fraction or an absurd size is not trusted; a good one is", async () => {
		const { isStoredMeta } = await import("../matte-store");
		const good = { width: 320, height: 180, fps: 30, startSeconds: 0, stride: 2, frameCount: 100, complete: true };
		expect(isStoredMeta(good)).toBe(true);
		for (const bad of [{ stride: 0 }, { stride: Number.NaN }, { stride: 1.5 }, { frameCount: -1 }, { width: 1e9 }, { fps: Number.POSITIVE_INFINITY }, { fps: 5000 }, { startSeconds: -1 }]) {
			expect(isStoredMeta({ ...good, ...bad })).toBe(false);
		}
	});

	test("a stored frame of the wrong size makes the run 'not stored' (it is computed again)", async () => {
		const store = new MemoryMatteStore();
		await store.putMeta({ key: "k", meta: { width: 4, height: 2, fps: 10, startSeconds: 0, stride: 1, frameCount: 2, complete: true } });
		await store.putFrame({ key: "k", index: 0, data: new Uint8Array(8) });
		await store.putFrame({ key: "k", index: 1, data: new Uint8Array(3) });
		expect(await loadCutout({ key: "k", store })).toBeNull();
	});

	test("old runs are pruned (least recently used first, the new one is kept); the memory ledger drops the oldest clips beyond the cap", async () => {
		const { runsToEvict } = await import("../matte-store");
		const { MatteLedger } = await import("../matte-ledger");
		const meta = (usedAt: number) => ({ width: 1, height: 1, fps: 30, startSeconds: 0, stride: 1, frameCount: 1, complete: true, usedAt });
		const metas = [{ key: "a", meta: meta(5) }, { key: "b", meta: meta(1) }, { key: "c", meta: meta(9) }, { key: "new", meta: meta(0) }];
		expect(runsToEvict({ metas, keep: 2, protect: "new" })).toEqual(["b", "a"]);
		const ledger = new MatteLedger(100);
		expect(ledger.admit({ clipId: "a", bytes: 60 })).toEqual([]);
		expect(ledger.admit({ clipId: "b", bytes: 60 })).toEqual(["a"]);
		expect(ledger.totalBytes).toBe(60);
	});
});
