import { describe, expect, test } from "bun:test";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import type { Effect, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";
import type { Transform } from "@/rendering";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { EffectLayerNode } from "@/services/renderer/nodes/effect-layer-node";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import {
	resolveEffectPassGroups,
	resolveRenderTree,
} from "@/services/renderer/resolve";
import { mediaTime } from "@/wasm";

// A blur with nothing to do (intensity 0, a missing or broken intensity, a clip
// scaled to 0) builds no passes. The compositor used to receive that as an
// empty pass group and failed the WHOLE frame with "At least one effect pass is
// required"; the preview then kept showing its last picture: the clip "froze".
// No effect may reach the compositor as an empty group, from a clip or from an
// effect-track layer.

registerDefaultEffects();

const CLIP = 4000;
const IDENTITY: Transform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};

function renderer({
	width = 1920,
	height = 1080,
}: { width?: number; height?: number } = {}): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), {
		width,
		height,
	});
}

function blur(params: ParamValues): Effect {
	return { id: "fx", type: "blur", params, enabled: true };
}

const UNUSABLE_NUMBERS = [
	0,
	-1,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
];

/** Fails when a group is empty or a uniform is not a finite number. */
function expectUsableGroups(groups: EffectPass[][]) {
	for (const group of groups) {
		expect(group.length).toBeGreaterThan(0);
		for (const pass of group) {
			for (const value of Object.values(pass.uniforms)) {
				for (const number of Array.isArray(value) ? value : [value]) {
					expect(Number.isFinite(number)).toBe(true);
				}
			}
		}
	}
}

describe("resolveEffectPassGroups", () => {
	test("every registered effect: no empty group and no broken uniform for any degenerate param or box", () => {
		const definitions = effectsRegistry.getAll();
		expect(definitions.length).toBeGreaterThan(0);
		const boxes = [
			[0, 0],
			[0, 1080],
			[1920, 0],
			[Number.NaN, 1080],
			[1920, 1080],
		];
		let combinations = 0;
		for (const definition of definitions) {
			const numberParams = definition.params.filter((param) => param.type === "number");
			const variants: ParamValues[] = [{}];
			for (const param of numberParams) {
				for (const value of UNUSABLE_NUMBERS) {
					variants.push({ [param.key]: value });
				}
			}
			for (const params of variants) {
				for (const [width, height] of boxes) {
					const groups = resolveEffectPassGroups({
						effects: [{ id: "fx", type: definition.type, params, enabled: true }],
						animations: undefined,
						localTime: 0,
						duration: 1,
						width,
						height,
					});
					expectUsableGroups(groups);
					combinations += 1;
				}
			}
		}
		expect(combinations).toBeGreaterThan(20);
	});

	test("a blur with intensity 0, missing, NaN, negative or infinite gives no group at all", () => {
		const cases: ParamValues[] = [{}, ...UNUSABLE_NUMBERS.map((intensity) => ({ intensity }))];
		for (const params of cases) {
			expect(
				resolveEffectPassGroups({
					effects: [blur(params)],
					animations: undefined,
					localTime: 0,
					duration: 1,
					width: 1920,
					height: 1080,
				}),
			).toEqual([]);
		}
	});

	test("a blur on a 0 x 0 box gives no group, a usable blur next to it still does", () => {
		const groups = resolveEffectPassGroups({
			effects: [blur({ intensity: 0 }), blur({ intensity: 40 })],
			animations: undefined,
			localTime: 0,
			duration: 1,
			width: 1920,
			height: 1080,
		});
		expect(groups).toHaveLength(1);
		expectUsableGroups(groups);

		expect(
			resolveEffectPassGroups({
				effects: [blur({ intensity: 40 })],
				animations: undefined,
				localTime: 0,
				duration: 1,
				width: 0,
				height: 0,
			}),
		).toEqual([]);
	});
});

function scalarKey({ id, ticks, value }: { id: string; ticks: number; value: number }): ScalarAnimationKey {
	return {
		id,
		time: mediaTime({ ticks }),
		value,
		segmentToNext: "linear",
		tangentMode: "auto",
	};
}

/** Linear keyframes from `from` at the start of the clip to `to` at its end. */
function ramp({ path, from, to }: { path: string; from: number; to: number }): ElementAnimations {
	return {
		[path]: {
			keys: [
				scalarKey({ id: `${path}-a`, ticks: 0, value: from }),
				scalarKey({ id: `${path}-b`, ticks: CLIP, value: to }),
			],
		},
	};
}

async function resolveGraphic({
	time = 0,
	transform = IDENTITY,
	effects,
	animations,
}: {
	time?: number;
	transform?: Transform;
	effects: Effect[];
	animations?: ElementAnimations;
}) {
	const node = new GraphicNode({
		definitionId: "rectangle",
		params: {},
		duration: CLIP + 1,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform,
		animations,
		opacity: 1,
		effects,
	});
	await resolveRenderTree({ node, renderer: renderer(), time });
	if (!node.resolved) throw new Error("graphic did not resolve");
	return node.resolved;
}

describe("a clip with a blur, through resolveRenderTree", () => {
	test("scaled to 0: no effect group", async () => {
		const resolved = await resolveGraphic({
			transform: { ...IDENTITY, scaleX: 0, scaleY: 0 },
			effects: [blur({ intensity: 50 })],
		});
		expect(resolved.effectPasses).toEqual([]);
	});

	test("scaled to 0 on one axis: one group that blurs only the other axis", async () => {
		const resolved = await resolveGraphic({
			transform: { ...IDENTITY, scaleX: 0 },
			effects: [blur({ intensity: 50 })],
		});
		expect(resolved.effectPasses).toHaveLength(1);
		expectUsableGroups(resolved.effectPasses);
		for (const pass of resolved.effectPasses[0]) {
			expect(pass.uniforms.u_direction).toEqual([0, 1]);
		}
	});

	test("scale keyframed down to 0: a group while it is visible, none at the end", async () => {
		const animations = {
			...ramp({ path: "transform.scaleX", from: 1, to: 0 }),
			...ramp({ path: "transform.scaleY", from: 1, to: 0 }),
		};
		const start = await resolveGraphic({ time: 0, effects: [blur({ intensity: 50 })], animations });
		expect(start.effectPasses).toHaveLength(1);
		const end = await resolveGraphic({ time: CLIP, effects: [blur({ intensity: 50 })], animations });
		expect(end.transform.scaleX).toBe(0);
		expect(end.effectPasses).toEqual([]);
	});

	test("intensity keyframed down to 0: no group at the keyframe", async () => {
		const animations = ramp({ path: "effects.fx.params.intensity", from: 50, to: 0 });
		const start = await resolveGraphic({ time: 0, effects: [blur({ intensity: 50 })], animations });
		expect(start.effectPasses).toHaveLength(1);
		const end = await resolveGraphic({ time: CLIP, effects: [blur({ intensity: 50 })], animations });
		expect(end.effectPasses).toEqual([]);
	});
});

describe("an effect-track layer (EffectLayerNode)", () => {
	function effectLayer(effectParams: ParamValues) {
		return new EffectLayerNode({
			effectType: "blur",
			effectParams,
			timeOffset: 0,
			duration: CLIP,
		});
	}

	test("with a usable blur it resolves to its passes", async () => {
		const node = effectLayer({ intensity: 30 });
		await resolveRenderTree({ node, renderer: renderer(), time: 0 });
		expect(node.resolved?.passes.length).toBeGreaterThan(0);
	});

	test("a blur that does nothing resolves to nothing (no empty sceneEffect group)", async () => {
		const cases: ParamValues[] = [{}, ...UNUSABLE_NUMBERS.map((intensity) => ({ intensity }))];
		for (const params of cases) {
			const node = effectLayer(params);
			await resolveRenderTree({ node, renderer: renderer(), time: 0 });
			expect(node.resolved).toBeNull();
		}
	});

	test("on a 0 x 0 canvas it resolves to nothing", async () => {
		const node = effectLayer({ intensity: 30 });
		await resolveRenderTree({ node, renderer: renderer({ width: 0, height: 0 }), time: 0 });
		expect(node.resolved).toBeNull();
	});
});
