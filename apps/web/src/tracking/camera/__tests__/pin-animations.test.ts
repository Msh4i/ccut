/**
 * How pin keys are written into, and taken out of, an element's animations
 * (slice T3, plan decision 5 and the "Unstick" rule). Pure data in, data out:
 * the commands in `commands/timeline/element/keyframes` wrap these.
 */
import { describe, expect, test } from "bun:test";
import { resolveAnimationPathValueAtTime } from "@/animation";
import type {
	ElementAnimations,
	ScalarAnimationKey,
	ScalarChannel,
} from "@/animation/types";
import { mediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import type { SimplifiedPinChannels } from "../simplify-channels";
import {
	applyCameraPinChannels,
	buildCameraPinKeys,
	CAMERA_PIN_PATHS,
	getScalarChannel,
	removeCameraPinChannels,
	type CameraPinKeys,
	type CameraPinRange,
} from "../pin-animations";

const NAMES = ["x", "y", "scaleX", "scaleY", "rotate"] as const;
let nextId = 0;

function key({ ticks, value }: { ticks: number; value: number }): ScalarAnimationKey {
	return {
		id: `k${nextId++}`,
		time: mediaTime({ ticks }),
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

function keys({ at }: { at: [number, number][] }): ScalarAnimationKey[] {
	return at.map(([ticks, value]) => key({ ticks, value }));
}

function pinKeys({ at }: { at: [number, number][] }): CameraPinKeys {
	return { x: keys({ at }), y: keys({ at }), scaleX: keys({ at }), scaleY: keys({ at }), rotate: keys({ at }) };
}

function range({ start, end }: { start: number; end: number }): CameraPinRange {
	return { start: mediaTime({ ticks: start }), end: mediaTime({ ticks: end }) };
}

function channelOf({
	animations,
	path,
}: {
	animations: ElementAnimations | undefined;
	path: string;
}): ScalarChannel | undefined {
	return getScalarChannel({ animations, path });
}

function valueAt({
	animations,
	path,
	ticks,
	fallback = -999,
}: {
	animations: ElementAnimations | undefined;
	path: string;
	ticks: number;
	fallback?: number;
}): number {
	return resolveAnimationPathValueAtTime({
		animations,
		propertyPath: path,
		localTime: ticks,
		fallbackValue: fallback,
	});
}

describe("buildCameraPinKeys", () => {
	const simplified: SimplifiedPinChannels = {
		x: [
			{ time: 12, value: 1.25 },
			{ time: 12.5, value: 2.5 },
			{ time: 13, value: 4.125 },
		],
		y: [
			{ time: 12, value: -1 },
			{ time: 13, value: -2 },
		],
		scaleX: [
			{ time: 12, value: 1 },
			{ time: 13, value: 1.5 },
		],
		scaleY: [
			{ time: 12, value: 1 },
			{ time: 13, value: 1.5 },
		],
		rotate: [
			{ time: 12, value: 400 },
			{ time: 13, value: 430.5 },
		],
	};
	const duration = mediaTimeFromSeconds({ seconds: 5 });

	test("times become integer ticks relative to the element start, linear and flat like the follow keys", () => {
		const built = buildCameraPinKeys({ simplified, elementStartSec: 11, durationTicks: duration });
		const one = mediaTimeFromSeconds({ seconds: 1 });
		const two = mediaTimeFromSeconds({ seconds: 2 });
		expect(built.keys.x.map((k) => k.time)).toEqual([one, mediaTimeFromSeconds({ seconds: 1.5 }), two]);
		for (const name of NAMES) {
			for (const k of built.keys[name]) {
				expect(Number.isInteger(k.time)).toBe(true);
				expect(k.segmentToNext).toBe("linear");
				expect(k.tangentMode).toBe("flat");
			}
		}
		expect(built.range).toEqual({ start: one, end: two });
	});

	test("values are not rounded", () => {
		const built = buildCameraPinKeys({ simplified, elementStartSec: 11, durationTicks: duration });
		expect(built.keys.x.map((k) => k.value)).toEqual([1.25, 2.5, 4.125]);
		expect(built.keys.rotate[1].value).toBe(430.5);
	});

	test("ids are unique across every channel", () => {
		const built = buildCameraPinKeys({ simplified, elementStartSec: 11, durationTicks: duration });
		const ids = NAMES.flatMap((name) => built.keys[name].map((k) => k.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("times are held inside the element: a sample before its start or after its end", () => {
		const edge: SimplifiedPinChannels = {
			x: [
				{ time: 10.99, value: 1 },
				{ time: 16.01, value: 2 },
			],
			y: [
				{ time: 10.99, value: 1 },
				{ time: 16.01, value: 2 },
			],
			scaleX: [
				{ time: 10.99, value: 1 },
				{ time: 16.01, value: 2 },
			],
			scaleY: [
				{ time: 10.99, value: 1 },
				{ time: 16.01, value: 2 },
			],
			rotate: [
				{ time: 10.99, value: 1 },
				{ time: 16.01, value: 2 },
			],
		};
		const built = buildCameraPinKeys({ simplified: edge, elementStartSec: 11, durationTicks: duration });
		expect<number>(built.keys.x[0].time).toBe(0);
		expect(built.keys.x[1].time).toBe(duration);
		expect(built.range).toEqual({ start: mediaTime({ ticks: 0 }), end: duration });
	});

	test("two samples that round to one tick keep one key", () => {
		const close: SimplifiedPinChannels = {
			x: [
				{ time: 11, value: 1 },
				{ time: 11 + 0.2 / TICKS_PER_SECOND, value: 2 },
				{ time: 12, value: 3 },
			],
			y: [
				{ time: 11, value: 1 },
				{ time: 12, value: 3 },
			],
			scaleX: [
				{ time: 11, value: 1 },
				{ time: 12, value: 3 },
			],
			scaleY: [
				{ time: 11, value: 1 },
				{ time: 12, value: 3 },
			],
			rotate: [
				{ time: 11, value: 1 },
				{ time: 12, value: 3 },
			],
		};
		const built = buildCameraPinKeys({ simplified: close, elementStartSec: 11, durationTicks: duration });
		expect(built.keys.x).toHaveLength(2);
		expect<number>(built.keys.x[0].time).toBe(0);
	});

	test("an empty channel is refused", () => {
		expect(() =>
			buildCameraPinKeys({ simplified: { ...simplified, y: [] }, elementStartSec: 11, durationTicks: duration }),
		).toThrow();
	});
});

describe("applyCameraPinChannels", () => {
	const inside = range({ start: 100, end: 200 });
	const channels = pinKeys({ at: [[100, 10], [150, 20.5], [200, 30]] });

	test("writes all five channels", () => {
		const animations = applyCameraPinChannels({ animations: undefined, channels, range: inside });
		for (const name of NAMES) {
			const channel = channelOf({ animations, path: CAMERA_PIN_PATHS[name] });
			expect<number[] | undefined>(channel?.keys.map((k) => k.time)).toEqual([100, 150, 200]);
		}
		expect(valueAt({ animations, path: "transform.positionX", ticks: 150 })).toBe(20.5);
		expect(valueAt({ animations, path: "transform.rotate", ticks: 125 })).toBeCloseTo(15.25, 9);
	});

	test("outside the range the channel holds its end values", () => {
		const animations = applyCameraPinChannels({ animations: undefined, channels, range: inside });
		expect(valueAt({ animations, path: "transform.positionX", ticks: 0 })).toBe(10);
		expect(valueAt({ animations, path: "transform.positionX", ticks: 5000 })).toBe(30);
	});

	test("keys inside the range are replaced, keys outside are kept as they were", () => {
		const before: ElementAnimations = {};
		for (const name of NAMES) {
			before[CAMERA_PIN_PATHS[name]] = {
				keys: keys({ at: [[0, -1], [50, -2], [100, -3], [140, -4], [200, -5], [250, -6], [400, -7]] }),
			};
		}
		const animations = applyCameraPinChannels({ animations: before, channels, range: inside });
		for (const name of NAMES) {
			const path = CAMERA_PIN_PATHS[name];
			const result = channelOf({ animations, path });
			const old = channelOf({ animations: before, path });
			expect<number[] | undefined>(result?.keys.map((k) => k.time)).toEqual([0, 50, 100, 150, 200, 250, 400]);
			// the ones outside are the very same keys
			for (const ticks of [0, 50, 250, 400]) {
				const was = old?.keys.find((k) => k.time === ticks);
				const now = result?.keys.find((k) => k.time === ticks);
				expect(now).toEqual(was);
			}
			// both ends of the range belong to the pin
			expect(result?.keys.find((k) => k.time === 100)?.value).toBe(10);
			expect(result?.keys.find((k) => k.time === 200)?.value).toBe(30);
			expect(result?.keys.find((k) => k.time === 140)).toBeUndefined();
		}
	});

	test("a second pin on another segment leaves the first as it was", () => {
		const first = applyCameraPinChannels({ animations: undefined, channels, range: inside });
		const second = applyCameraPinChannels({
			animations: first,
			channels: pinKeys({ at: [[300, 50], [350, 60], [400, 70]] }),
			range: range({ start: 300, end: 400 }),
		});
		for (const name of NAMES) {
			const path = CAMERA_PIN_PATHS[name];
			const a = channelOf({ animations: first, path });
			const b = channelOf({ animations: second, path });
			expect(b?.keys.slice(0, 3)).toEqual(a?.keys);
			expect<number[] | undefined>(b?.keys.map((k) => k.time)).toEqual([100, 150, 200, 300, 350, 400]);
		}
	});

	test("an overlapping second pin replaces only the overlap", () => {
		const first = applyCameraPinChannels({ animations: undefined, channels, range: inside });
		const second = applyCameraPinChannels({
			animations: first,
			channels: pinKeys({ at: [[180, 99], [260, 98]] }),
			range: range({ start: 180, end: 260 }),
		});
		const x = channelOf({ animations: second, path: "transform.positionX" });
		expect(x?.keys.map((k) => [k.time, k.value])).toEqual([
			[100, 10],
			[150, 20.5],
			[180, 99],
			[260, 98],
		]);
	});

	test("opacity, colour and every other animation are untouched, as the same objects", () => {
		const opacity: ScalarChannel = { keys: keys({ at: [[0, 1], [300, 0.2]] }) };
		const before: ElementAnimations = {
			opacity,
			"background.paddingX": { keys: keys({ at: [[0, 4], [500, 9]] }) },
		};
		const animations = applyCameraPinChannels({ animations: before, channels, range: inside });
		expect(animations?.opacity).toBe(opacity);
		expect(animations?.["background.paddingX"]).toBe(before["background.paddingX"]);
	});

	test("the extrapolation of an existing channel is kept", () => {
		const before: ElementAnimations = {
			"transform.positionX": {
				keys: keys({ at: [[0, 1], [50, 2]] }),
				extrapolation: { before: "hold", after: "linear" },
			},
		};
		const animations = applyCameraPinChannels({ animations: before, channels, range: inside });
		expect(channelOf({ animations, path: "transform.positionX" })?.extrapolation).toEqual({
			before: "hold",
			after: "linear",
		});
	});

	test("does not modify its input", () => {
		const before: ElementAnimations = { "transform.positionX": { keys: keys({ at: [[0, 1], [150, 2]] }) } };
		const frozen = JSON.stringify(before);
		applyCameraPinChannels({ animations: before, channels, range: inside });
		expect(JSON.stringify(before)).toBe(frozen);
	});

	test("values keep their decimals (no whole-pixel snapping)", () => {
		const fractional = pinKeys({ at: [[100, 123.456789], [200, -0.000123]] });
		const animations = applyCameraPinChannels({ animations: undefined, channels: fractional, range: inside });
		expect(channelOf({ animations, path: "transform.positionY" })?.keys.map((k) => k.value)).toEqual([
			123.456789, -0.000123,
		]);
	});

	test("a key outside the range, or an empty channel, is refused", () => {
		expect(() =>
			applyCameraPinChannels({
				animations: undefined,
				channels: pinKeys({ at: [[90, 1], [200, 2]] }),
				range: inside,
			}),
		).toThrow();
		expect(() =>
			applyCameraPinChannels({
				animations: undefined,
				channels: { ...channels, scaleX: [] },
				range: inside,
			}),
		).toThrow();
		expect(() =>
			applyCameraPinChannels({ animations: undefined, channels, range: range({ start: 200, end: 100 }) }),
		).toThrow();
	});
});

describe("removeCameraPinChannels (Unstick)", () => {
	const inside = range({ start: 100, end: 300 });

	function pinned() {
		const pin: CameraPinKeys = {
			x: keys({ at: [[100, 10.25], [200, 20.5], [300, 30]] }),
			y: keys({ at: [[100, -5], [200, -15.75], [300, -25]] }),
			scaleX: keys({ at: [[100, 1], [200, 1.5], [300, 2]] }),
			scaleY: keys({ at: [[100, 0.8], [200, 1.2], [300, 1.6]] }),
			rotate: keys({ at: [[100, 0], [200, 450], [300, 900]] }),
		};
		const opacity: ScalarChannel = { keys: keys({ at: [[0, 1], [400, 0.5]] }) };
		return {
			element: {
				animations: applyCameraPinChannels({
					animations: { opacity },
					channels: pin,
					range: inside,
				}),
				params: {
					"transform.positionX": 0,
					"transform.positionY": 0,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
					"transform.rotate": 0,
					opacity: 1,
					content: "hello",
				},
			},
			opacity,
		};
	}

	test("the pin keys go, the look at the playhead moves into the base params, nothing jumps", () => {
		const { element } = pinned();
		const result = removeCameraPinChannels({ element, range: inside, localTime: 150 });
		for (const name of NAMES) {
			expect(channelOf({ animations: result.animations, path: CAMERA_PIN_PATHS[name] })).toBeUndefined();
		}
		expect(result.params["transform.positionX"]).toBe(15.375);
		expect(result.params["transform.positionY"]).toBe(-10.375);
		expect(result.params["transform.scaleX"]).toBe(1.25);
		expect(result.params["transform.scaleY"]).toBe(1);
		// 225 degrees is the same look as -135, kept inside the rotate field's range
		expect(result.params["transform.rotate"]).toBe(-135);
	});

	test("opacity, its animation and the other params stay as they were", () => {
		const { element, opacity } = pinned();
		const result = removeCameraPinChannels({ element, range: inside, localTime: 150 });
		expect(result.animations?.opacity).toBe(opacity);
		expect(result.params.opacity).toBe(1);
		expect(result.params.content).toBe("hello");
	});

	test("without a pin it does nothing", () => {
		const element = { animations: undefined, params: { "transform.positionX": 4 } };
		expect(removeCameraPinChannels({ element, range: inside, localTime: 150 })).toEqual(element);
	});

	test("a playhead outside the range takes the look at the nearest end", () => {
		const { element } = pinned();
		const before = removeCameraPinChannels({ element, range: inside, localTime: 10 });
		expect(before.params["transform.positionX"]).toBe(10.25);
		const after = removeCameraPinChannels({ element, range: inside, localTime: 9999 });
		expect(after.params["transform.positionX"]).toBe(30);
		expect(after.params["transform.scaleX"]).toBe(2);
	});

	test("values are not rounded", () => {
		const { element } = pinned();
		const result = removeCameraPinChannels({ element, range: inside, localTime: 100 });
		expect(result.params["transform.positionX"]).toBe(10.25);
	});

	test("a second pin's keys survive; the removed range holds the look at the playhead", () => {
		const { element } = pinned();
		const both = {
			...element,
			animations: applyCameraPinChannels({
				animations: element.animations,
				channels: pinKeys({ at: [[500, 70], [600, 90]] }),
				range: range({ start: 500, end: 600 }),
			}),
		};
		const result = removeCameraPinChannels({ element: both, range: inside, localTime: 200 });
		const x = channelOf({ animations: result.animations, path: "transform.positionX" });
		// the second pin is as it was
		expect(x?.keys.filter((k) => k.time >= 500).map((k) => [k.time, k.value])).toEqual([
			[500, 70],
			[600, 90],
		]);
		// the first segment is the look at the playhead, flat from end to end
		for (const ticks of [100, 150, 200, 250, 300]) {
			expect(valueAt({ animations: result.animations, path: "transform.positionX", ticks })).toBe(20.5);
			expect(valueAt({ animations: result.animations, path: "transform.scaleX", ticks })).toBe(1.5);
			expect(valueAt({ animations: result.animations, path: "transform.rotate", ticks })).toBe(450);
		}
		// and the base params are not touched while a channel still exists
		expect(result.params["transform.positionX"]).toBe(0);
	});

	test("keys of the same channel outside the range on one side only", () => {
		const { element } = pinned();
		const withEarlier = {
			...element,
			animations: applyCameraPinChannels({
				animations: element.animations,
				channels: pinKeys({ at: [[0, 3], [50, 4]] }),
				range: range({ start: 0, end: 50 }),
			}),
		};
		const result = removeCameraPinChannels({ element: withEarlier, range: inside, localTime: 250 });
		expect(valueAt({ animations: result.animations, path: "transform.positionY", ticks: 250 })).toBe(-20.375);
		expect(valueAt({ animations: result.animations, path: "transform.positionY", ticks: 100 })).toBe(-20.375);
		expect(valueAt({ animations: result.animations, path: "transform.positionY", ticks: 25 })).toBeCloseTo(3.5, 9);
	});
});
