import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GAUSSIAN_BLUR_SHADER } from "@/effects/definitions/blur";
import type { EffectPass } from "@/effects/types";
import {
	type PreviewScale,
	descriptorForDraw,
	previewRenderScale,
	scaleFrameDescriptor,
} from "../scale-frame";
import type {
	ExternalTextureDescriptor,
	FrameDescriptor,
	FrameItemDescriptor,
	QuadTransformDescriptor,
	RenderedTextureDescriptor,
	TextureUploadDescriptor,
} from "../types";

// Lever (c), docs/ccut/playback-p5-design.md section 2: the playing preview
// composites at display size. Everything is resolved in project pixels and
// scaled once, at the end, by scaleFrameDescriptor. Export, snapshot and
// thumbnails (no `preview`) and the paused preview (scale 1) never change.

// An odd project size so that the two axes scale differently (a swap shows).
const W = 1001;
const H = 1777;
const S = 0.5;
const FW = Math.round(W * S); // 501
const FH = Math.round(H * S); // 889
const SX = FW / W;
const SY = FH / H;

const log: string[] = [];

/** A 2D context that only records the calls the scaled draw makes. */
class RecordingCanvas {
	readonly width: number;
	readonly height: number;
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	getContext() {
		return {
			save: () => log.push("save"),
			restore: () => log.push("restore"),
			// Mirrors the DOM signature: scale(x, y).
			scale: (...[x, y]: [number, number]) => log.push(`scale ${x} ${y}`),
		};
	}
}

const originalOffscreenCanvas = Reflect.get(globalThis, "OffscreenCanvas");
beforeAll(() => {
	Reflect.set(globalThis, "OffscreenCanvas", RecordingCanvas);
});
afterAll(() => {
	if (originalOffscreenCanvas === undefined) {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	} else {
		Reflect.set(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	}
});

function recordingContext() {
	const ctx = new OffscreenCanvas(1, 1).getContext("2d");
	if (!ctx) throw new Error("no context");
	log.length = 0;
	return ctx;
}

function blurPass({ sigma, step, direction }: { sigma: number; step: number; direction: number[] }): EffectPass {
	return { shader: GAUSSIAN_BLUR_SHADER, uniforms: { u_sigma: sigma, u_step: step, u_direction: direction } };
}

function quad(overrides: Partial<QuadTransformDescriptor> = {}): QuadTransformDescriptor {
	return {
		centerX: 300,
		centerY: 700,
		width: 400,
		height: 250,
		rotationDegrees: 30,
		flipX: true,
		flipY: false,
		...overrides,
	};
}

const fullCanvas = quad({ centerX: W / 2, centerY: H / 2, width: W, height: H, rotationDegrees: 0, flipX: false });

// A seeded generator (mulberry32): the same "random" homographies every run.
function seeded(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function homographyOf(random: () => number): number[] {
	return [
		200 + 600 * random(), -50 + 100 * random(), 100 + 300 * random(),
		-50 + 100 * random(), 300 + 600 * random(), 200 + 600 * random(),
		-0.2 + 0.4 * random(), -0.2 + 0.4 * random(), 1 + 0.5 * random(),
	];
}

function project({ h, u, v }: { h: number[]; u: number; v: number }): [number, number] {
	const w = h[6] * u + h[7] * v + h[8];
	return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
}

function rendered({ id, width, height, draw }: { id: string; width: number; height: number; draw?: () => void }): RenderedTextureDescriptor {
	return {
		kind: "rendered",
		id,
		contentHash: `${id}:hash`,
		width,
		height,
		draw: () => {
			log.push(`draw ${id}`);
			draw?.();
		},
	};
}

function externalTexture(): ExternalTextureDescriptor {
	return {
		kind: "external",
		id: "root:0:source",
		source: new OffscreenCanvas(480, 270),
		width: 480,
		height: 270,
		version: 3,
	};
}

function layer(overrides: Partial<Extract<FrameItemDescriptor, { type: "layer" }>> = {}): FrameItemDescriptor {
	return {
		type: "layer",
		textureId: "root:0:source",
		transform: quad(),
		opacity: 1,
		blendMode: "normal",
		effectPassGroups: [],
		mask: null,
		...overrides,
	};
}

function frameOf(items: FrameItemDescriptor[]): FrameDescriptor {
	return { width: W, height: H, clear: { color: [0, 0, 0, 1] }, items };
}

function scaled({ items, textures = [] }: { items: FrameItemDescriptor[]; textures?: TextureUploadDescriptor[] }) {
	const result = scaleFrameDescriptor({ frame: frameOf(items), textures, scale: S });
	if (!result) throw new Error("expected a scaled frame");
	return result;
}

function layerAt({ frame, index }: { frame: FrameDescriptor; index: number }) {
	const item = frame.items[index];
	if (item.type !== "layer") throw new Error("not a layer");
	return item;
}

describe("identity: export, snapshot, thumbnail and the paused preview draw what they drew before", () => {
	const frame = frameOf([layer(), { type: "sceneEffect", effectPassGroups: [[blurPass({ sigma: 30, step: 3, direction: [1, 0] })]] }]);
	const textures = (): TextureUploadDescriptor[] => [externalTexture(), rendered({ id: "root:1:text", width: W, height: H })];

	test("scale 1 (or anything not below 1) returns the very same descriptor and textures", () => {
		const list = textures();
		for (const scale of [1, 1.5, Number.NaN, 0, -1]) {
			const result = scaleFrameDescriptor({ frame, textures: list, scale });
			expect(result?.frame).toBe(frame);
			expect(result?.textures).toBe(list);
		}
	});

	test("without `preview` nothing is scaled, whatever the lever says", () => {
		const list = textures();
		const out = descriptorForDraw({ frame, textures: list, preview: undefined, displayResolution: true });
		expect(out.frame).toBe(frame);
		expect(out.textures).toBe(list);
	});

	test("lever off, or a preview at scale 1 (paused): the same descriptor", () => {
		const cases: Array<{ preview: PreviewScale; displayResolution: boolean }> = [
			{ preview: { renderScale: 0.5 }, displayResolution: false },
			{ preview: { renderScale: 1 }, displayResolution: true },
			{ preview: {}, displayResolution: true },
		];
		const list = textures();
		for (const { preview, displayResolution } of cases) {
			const out = descriptorForDraw({ frame, textures: list, preview, displayResolution });
			expect(out.frame).toBe(frame);
			expect(out.textures).toBe(list);
		}
	});

	test("lever on and a playing preview below 1: the frame is display-sized", () => {
		const out = descriptorForDraw({ frame, textures: textures(), preview: { renderScale: S }, displayResolution: true });
		expect([out.frame.width, out.frame.height]).toEqual([FW, FH]);
	});

	test("a frame the scaler cannot handle (unknown shader) is drawn at full size", () => {
		const odd = frameOf([layer({ effectPassGroups: [[{ shader: "chromatic", uniforms: { u_px: 4 } }]] })]);
		const list = textures();
		const out = descriptorForDraw({ frame: odd, textures: list, preview: { renderScale: S }, displayResolution: true });
		expect(out.frame).toBe(odd);
		expect(out.textures).toBe(list);
	});
});

describe("geometry", () => {
	test("frame size rounds per axis and is at least 1 px", () => {
		const { frame } = scaled({ items: [] });
		expect([frame.width, frame.height]).toEqual([FW, FH]);
		const tiny = scaleFrameDescriptor({ frame: frameOf([]), textures: [], scale: 1e-6 });
		expect([tiny?.frame.width, tiny?.frame.height]).toEqual([1, 1]);
	});

	test("quads scale per axis; rotation and flips stay", () => {
		const { frame } = scaled({ items: [layer()] });
		const transform = layerAt({ frame, index: 0 }).transform;
		expect(transform.centerX).toBeCloseTo(300 * SX, 9);
		expect(transform.width).toBeCloseTo(400 * SX, 9);
		expect(transform.centerY).toBeCloseTo(700 * SY, 9);
		expect(transform.height).toBeCloseTo(250 * SY, 9);
		expect([transform.rotationDegrees, transform.flipX, transform.flipY]).toEqual([30, true, false]);
	});

	test("a full-canvas layer covers the scaled frame exactly", () => {
		const { frame } = scaled({ items: [layer({ transform: fullCanvas })] });
		const transform = layerAt({ frame, index: 0 }).transform;
		expect(transform.centerX - transform.width / 2).toBeCloseTo(0, 9);
		expect(transform.centerX + transform.width / 2).toBeCloseTo(FW, 9);
		expect(transform.centerY - transform.height / 2).toBeCloseTo(0, 9);
		expect(transform.centerY + transform.height / 2).toBeCloseTo(FH, 9);
	});

	test("3D layers: H'(uv) = S H(uv) for seeded homographies and UV points", () => {
		const random = seeded(7);
		for (let sample = 0; sample < 20; sample++) {
			const h = homographyOf(random);
			const { frame } = scaled({ items: [layer({ transform: quad({ homography: h }) })] });
			const scaledH = layerAt({ frame, index: 0 }).transform.homography;
			if (!scaledH) throw new Error("homography dropped");
			for (let point = 0; point < 5; point++) {
				const u = random();
				const v = random();
				const [x, y] = project({ h, u, v });
				const [x2, y2] = project({ h: scaledH, u, v });
				expect(x2).toBeCloseTo(x * SX, 6);
				expect(y2).toBeCloseTo(y * SY, 6);
			}
		}
	});

	test("a 2D layer gets no homography; a null one stays null", () => {
		const { frame } = scaled({ items: [layer(), layer({ transform: quad({ homography: null }) })] });
		expect(layerAt({ frame, index: 0 }).transform.homography).toBeUndefined();
		expect(layerAt({ frame, index: 1 }).transform.homography).toBeNull();
	});
});

describe("pixel-unit uniforms", () => {
	test("blur sigma scales by its axis; the step follows the blur rule max(1, sigma / 10)", () => {
		const groups = [[
			blurPass({ sigma: 30, step: 3, direction: [1, 0] }),
			blurPass({ sigma: 40, step: 4, direction: [0, 1] }),
			blurPass({ sigma: 5, step: 1, direction: [1, 0] }),
		]];
		const { frame } = scaled({ items: [layer({ effectPassGroups: groups }), { type: "sceneEffect", effectPassGroups: groups }] });
		const sceneItem = frame.items[1];
		if (sceneItem.type !== "sceneEffect") throw new Error("not a scene effect");
		for (const passes of [layerAt({ frame, index: 0 }).effectPassGroups[0], sceneItem.effectPassGroups[0]]) {
			expect(passes.map((pass) => pass.uniforms.u_sigma)).toEqual([30 * SX, 40 * SY, 5 * SX]);
			expect(passes.map((pass) => pass.uniforms.u_step)).toEqual([(30 * SX) / 10, (40 * SY) / 10, 1]);
			expect(passes.map((pass) => pass.uniforms.u_direction)).toEqual([[1, 0], [0, 1], [1, 0]]);
		}
	});

	test("the descriptor it was given is not changed", () => {
		const groups = [[blurPass({ sigma: 30, step: 3, direction: [1, 0] })]];
		const original = frameOf([layer({ effectPassGroups: groups })]);
		const before = JSON.stringify(original);
		scaleFrameDescriptor({ frame: original, textures: [], scale: S });
		expect(JSON.stringify(original)).toBe(before);
	});

	test("an unknown shader, or a blur that is not along one axis, gives null (full size)", () => {
		const cases: EffectPass[] = [
			{ shader: "vignette", uniforms: { u_radius: 10 } },
			blurPass({ sigma: 10, step: 1, direction: [1, 1] }),
			{ shader: GAUSSIAN_BLUR_SHADER, uniforms: { u_sigma: 10, u_step: 1 } },
			{ shader: GAUSSIAN_BLUR_SHADER, uniforms: { u_sigma: [10], u_step: 1, u_direction: [1, 0] } },
		];
		for (const pass of cases) {
			expect(scaleFrameDescriptor({ frame: frameOf([layer({ effectPassGroups: [[pass]] })]), textures: [], scale: S })).toBeNull();
			expect(scaleFrameDescriptor({ frame: frameOf([{ type: "sceneEffect", effectPassGroups: [[pass]] }]), textures: [], scale: S })).toBeNull();
		}
	});

	test("mask feather scales by sqrt(sx sy)", () => {
		const { frame } = scaled({ items: [layer({ mask: { textureId: "root:0:mask", feather: 20, inverted: true } })] });
		expect(layerAt({ frame, index: 0 }).mask).toEqual({ textureId: "root:0:mask", feather: 20 * Math.sqrt(SX * SY), inverted: true });
	});
});

describe("textures", () => {
	test("a frame-sized rendered texture becomes display-sized, drawn under scale(sx, sy) and restored", () => {
		const original = rendered({ id: "root:1:text", width: W, height: H });
		const { textures } = scaled({ items: [], textures: [original] });
		const texture = textures[0];
		if (texture.kind !== "rendered") throw new Error("not rendered");
		expect([texture.id, texture.width, texture.height]).toEqual(["root:1:text", FW, FH]);
		expect(texture.contentHash).toBe(`root:1:text:hash@${FW}x${FH}`);
		texture.draw(recordingContext());
		expect(log).toEqual(["save", `scale ${SX} ${SY}`, "draw root:1:text", "restore"]);
	});

	test("the context is restored even when the draw throws", () => {
		const original = rendered({
			id: "root:2:mask",
			width: W,
			height: H,
			draw: () => {
				throw new Error("broken mask");
			},
		});
		const texture = scaled({ items: [], textures: [original] }).textures[0];
		if (texture.kind !== "rendered") throw new Error("not rendered");
		expect(() => texture.draw(recordingContext())).toThrow("broken mask");
		expect(log).toEqual(["save", `scale ${SX} ${SY}`, "draw root:2:mask", "restore"]);
	});

	test("local textures (3D text, a downscaled backdrop) and external textures are untouched", () => {
		const local = rendered({ id: "root:3:text3d", width: 256, height: 128 });
		const backdrop = rendered({ id: "root:blur-background", width: Math.round(W / 4), height: Math.round(H / 4) });
		const external = externalTexture();
		const { textures } = scaled({ items: [], textures: [external, local, backdrop] });
		expect(textures[0]).toBe(external);
		expect(textures[1]).toBe(local);
		expect(textures[2]).toBe(backdrop);
	});
});

describe("previewRenderScale", () => {
	test("paused (density null) or lever off: 1", () => {
		expect(previewRenderScale({ displayResolution: true, sourceDensity: null })).toBe(1);
		expect(previewRenderScale({ displayResolution: false, sourceDensity: 450 / 1080 })).toBe(1);
	});

	test("playing: the density's bucket, never above 1", () => {
		// The owner's case: 1080x1920 shown 450 CSS px wide at DPR 1 -> 0.417 -> 0.5 (540x960).
		expect(previewRenderScale({ displayResolution: true, sourceDensity: 450 / 1080 })).toBe(0.5);
		expect(previewRenderScale({ displayResolution: true, sourceDensity: 0.6 })).toBeCloseTo(Math.SQRT1_2, 12);
		expect(previewRenderScale({ displayResolution: true, sourceDensity: 0.9 })).toBe(1);
		expect(previewRenderScale({ displayResolution: true, sourceDensity: 3 })).toBe(1);
	});

	test("unusable densities are full size", () => {
		for (const density of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(previewRenderScale({ displayResolution: true, sourceDensity: density })).toBe(1);
		}
	});
});
