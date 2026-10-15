import { describe, expect, spyOn, test } from "bun:test";
import { registerDefaultEffects } from "@/effects";
import type { EffectPass } from "@/effects/types";
import { shouldRenderPreview } from "@/preview/render-gate";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { applyThumbnailEffect } from "@/services/renderer/effect-preview";
import { gpuRenderer } from "@/services/renderer/gpu-renderer";

// On the WebGL fallback wgpu can only present through the one canvas its GL
// context was made on, and that canvas is also the compositor's output canvas,
// mounted in the preview (rust/wasm/src/compositor.rs, initCompositor). An
// Effects panel thumbnail resizes that canvas to 160 x 160 and draws into it
// (rust/crates/gpu/src/context.rs, render_texture_to_gl_canvas_surface). The
// paused preview never noticed: it kept showing the thumbnail, or a corner of
// its frame. A thumbnail that ran on the GPU now tells the compositor, whose
// draw serial then makes the preview draw its frame again.

const PASS: EffectPass = {
	shader: "gaussian-blur",
	uniforms: { u_sigma: 2, u_step: 1, u_direction: [1, 0] },
};

// Only passed through: the fake GPU hands it back.
const source: OffscreenCanvas = Object.create(null);

function fakes({ fail = false }: { fail?: boolean } = {}) {
	const calls: string[] = [];
	return {
		calls,
		gpu: {
			applyEffect: ({ source: input }: { source: OffscreenCanvas }) => {
				calls.push("gpu");
				if (fail) throw new Error("GPU context not initialized");
				return input;
			},
		},
		compositor: {
			noteCanvasDisturbed: () => {
				calls.push("disturbed");
			},
		},
	};
}

describe("applyThumbnailEffect", () => {
	test("passes that ran on the GPU tell the compositor its canvas was disturbed, after the draw", () => {
		const { calls, gpu, compositor } = fakes();
		applyThumbnailEffect({ source, width: 160, height: 160, passes: [PASS, PASS], gpu, compositor });
		expect(calls).toEqual(["gpu", "disturbed"]);
	});

	test("also when the GPU call throws half way", () => {
		const { calls, gpu, compositor } = fakes({ fail: true });
		expect(() =>
			applyThumbnailEffect({ source, width: 160, height: 160, passes: [PASS], gpu, compositor }),
		).toThrow("GPU context not initialized");
		expect(calls).toEqual(["gpu", "disturbed"]);
	});

	test("a thumbnail without passes touches no GPU canvas and disturbs nothing", () => {
		const { calls, gpu, compositor } = fakes();
		applyThumbnailEffect({ source, width: 160, height: 160, passes: [], gpu, compositor });
		expect(calls).toEqual(["gpu"]);
	});
});

describe("the Effects panel thumbnail service", () => {
	test("renders a blur thumbnail through applyThumbnailEffect, so the compositor hears of it", async () => {
		registerDefaultEffects();
		const drawContext = { drawImage() {}, clearRect() {} };
		class FakeCanvas {
			readonly width: number;
			readonly height: number;
			// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
			constructor(...[width, height]: [number, number]) {
				this.width = width;
				this.height = height;
			}
			getContext() {
				return drawContext;
			}
		}
		// The thumbnail's test picture: loaded as soon as it is created.
		class FakeImage {
			complete = true;
			naturalWidth = 160;
			onload: (() => void) | null = null;
			src = "";
		}
		const saved = {
			window: Reflect.get(globalThis, "window"),
			Image: Reflect.get(globalThis, "Image"),
			OffscreenCanvas: Reflect.get(globalThis, "OffscreenCanvas"),
		};
		let gpuCalls = 0;
		const applyEffect = spyOn(gpuRenderer, "applyEffect").mockImplementation(
			({ source: input }) => {
				gpuCalls += 1;
				return input;
			},
		);
		const before = wasmCompositor.getDrawSerial();
		try {
			Reflect.set(globalThis, "window", globalThis);
			Reflect.set(globalThis, "Image", FakeImage);
			Reflect.set(globalThis, "OffscreenCanvas", FakeCanvas);
			// A fresh service instance, made while the fakes are in place.
			const instance = "thumbnail-service";
			const service: typeof import("../effect-preview") = await import(
				`../effect-preview?${instance}`
			);
			const targetCanvas = Object.assign(Object.create(null), {
				width: 0,
				height: 0,
				getContext: () => drawContext,
			});
			service.effectPreviewService.renderPreview({
				effectType: "blur",
				params: {},
				targetCanvas,
			});
		} finally {
			applyEffect.mockRestore();
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) Reflect.deleteProperty(globalThis, name);
				else Reflect.set(globalThis, name, value);
			}
		}
		expect(gpuCalls).toBe(1);
		expect(wasmCompositor.getDrawSerial()).toBe(before + 1);
	});
});

describe("a disturbed compositor canvas and the paused preview", () => {
	test("the draw serial moves, so the render gate draws the same frame again", () => {
		const scene = {};
		const ownSerial = wasmCompositor.getDrawSerial();
		const paused = {
			isExporting: false,
			frame: 3,
			lastFrame: 3,
			scene,
			lastScene: scene,
			compositorSerial: ownSerial,
			lastOwnSerial: ownSerial,
			maxStaleSeconds: 0,
			lastMaxStaleSeconds: 0,
		};
		expect(shouldRenderPreview(paused)).toBe(false);

		wasmCompositor.noteCanvasDisturbed();
		expect(
			shouldRenderPreview({ ...paused, compositorSerial: wasmCompositor.getDrawSerial() }),
		).toBe(true);
	});
});
