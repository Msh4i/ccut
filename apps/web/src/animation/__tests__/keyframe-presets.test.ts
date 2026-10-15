import { describe, expect, test } from "bun:test";
import { resolveAnimationPathValueAtTime } from "@/animation";
import {
	KEYFRAME_PRESET_DEFINITIONS,
	MIN_KEYFRAME_PRESET_SECONDS,
	applyKeyframePresetToAnimations,
	buildPresetKeys,
	getKeyframePresetDefinition,
	resolveKeyframePresetRange,
	resolveKeyframePresetRequest,
	type KeyframePresetDefinition,
	type KeyframePresetId,
	type KeyframePresetRange,
} from "@/animation/keyframe-presets";
import { isScalarChannel } from "@/animation/interpolation";
import { getChannel } from "@/animation/keyframes";
import {
	SEGMENT_EASING_IDS,
	detectSegmentEasing,
	getSegmentEasingPatch,
} from "@/animation/segment-easing";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import {
	buildElementFromMedia,
	buildGraphicElement,
	buildStickerElement,
	buildTextElement,
} from "@/timeline/element-utils";
import {
	applyKeyframePresetToElement,
	elementSupportsKeyframePreset,
} from "@/timeline/keyframe-preset";
import type { TimelineElement } from "@/timeline/types";
import { VOLUME_DB_MIN } from "@/timeline/audio-constants";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const CANVAS = { width: 1920, height: 1080 };
const CLIP = 10 * TICKS_PER_SECOND;
const START = mediaTime({ ticks: 0 });
const DURATION = mediaTime({ ticks: CLIP });

function withId<T extends object>(element: T): T & { id: string } {
	return { id: "clip", ...element };
}

function clips(): Record<string, TimelineElement> {
	const common = { duration: DURATION, startTime: START };
	return {
		video: withId(
			buildElementFromMedia({
				mediaId: "m",
				mediaType: "video",
				name: "v",
				...common,
			}),
		),
		image: withId(
			buildElementFromMedia({
				mediaId: "m",
				mediaType: "image",
				name: "i",
				...common,
			}),
		),
		audio: withId(
			buildElementFromMedia({
				mediaId: "m",
				mediaType: "audio",
				name: "a",
				...common,
			}),
		),
		text: withId(buildTextElement({ raw: { duration: DURATION }, startTime: START })),
		sticker: withId({
			...buildStickerElement({ stickerId: "emoji:1", startTime: START }),
			duration: DURATION,
		}),
		graphic: withId({
			...buildGraphicElement({ definitionId: "rectangle", startTime: START }),
			duration: DURATION,
		}),
	};
}

function definition(id: KeyframePresetId): KeyframePresetDefinition {
	return getKeyframePresetDefinition({ id });
}

/** A MediaTime as the plain tick count the test compares with. */
function tick(time: number): number {
	return time;
}

function seconds(value: number): number {
	return Math.round(value * TICKS_PER_SECOND);
}

function apply({
	element,
	id,
	placement = "start",
	length,
	playhead = 0,
}: {
	element: TimelineElement;
	id: KeyframePresetId;
	placement?: "start" | "playhead" | "end";
	length?: number;
	playhead?: number;
}) {
	const result = applyKeyframePresetToElement({
		element,
		presetId: id,
		placement,
		seconds: length ?? definition(id).defaultSeconds,
		playheadLocal: playhead,
		canvas: CANVAS,
	});
	if (!result) throw new Error(`preset ${id} did not apply`);
	return result;
}

function keysOf({
	animations,
	path,
}: {
	animations: ElementAnimations | undefined;
	path: string;
}): ScalarAnimationKey[] {
	const channel = getChannel({ animations, propertyPath: path });
	return channel && isScalarChannel(channel) ? channel.keys : [];
}

function valueAt({
	animations,
	path,
	time,
	fallback,
}: {
	animations: ElementAnimations | undefined;
	path: string;
	time: number;
	fallback: number;
}): number {
	return resolveAnimationPathValueAtTime({
		animations,
		propertyPath: path,
		localTime: time,
		fallbackValue: fallback,
	});
}

describe("every preset really works", () => {
	test("there are the ten visual and four audio presets of the brief", () => {
		expect(KEYFRAME_PRESET_DEFINITIONS.map((entry) => entry.id)).toEqual([
			"zoom-in",
			"zoom-out",
			"pulse",
			"shake",
			"float",
			"swing",
			"pan-left",
			"pan-right",
			"pan-up",
			"pan-down",
			"volume-fade-in",
			"volume-fade-out",
			"volume-duck",
			"volume-swell",
		]);
	});

	for (const entry of KEYFRAME_PRESET_DEFINITIONS) {
		describe(entry.id, () => {
			test("has keys for every path it names, from the first to the last tick of its range", () => {
				const plan = entry.plan({
					base: Object.fromEntries(entry.paths.map((path) => [path, 0])),
					canvas: CANVAS,
					seconds: entry.defaultSeconds,
				});
				expect(Object.keys(plan).sort()).toEqual([...entry.paths].sort());
				for (const path of entry.paths) {
					const keys = plan[path];
					expect(keys.length).toBeGreaterThanOrEqual(2);
					expect(keys[0].at).toBe(0);
					expect(keys[keys.length - 1].at).toBe(1);
					for (let index = 1; index < keys.length; index++) {
						expect(keys[index].at).toBeGreaterThan(keys[index - 1].at);
					}
					for (const key of keys) expect(Number.isFinite(key.value)).toBe(true);
				}
			});

			test("writes keys that move the property, on every clip type that has it", () => {
				let tested = 0;
				for (const element of Object.values(clips())) {
					if (!elementSupportsKeyframePreset({ element, definition: entry })) {
						continue;
					}
					tested++;
					const { element: animated, range } = apply({ element, id: entry.id });
					for (const path of entry.paths) {
						const keys = keysOf({ animations: animated.animations, path });
						expect(keys.length).toBeGreaterThanOrEqual(2);
						const values = keys.map((key) => key.value);
						expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0);
						expect(tick(keys[0].time)).toBe(range.start);
						expect(tick(keys[keys.length - 1].time)).toBe(range.end);
					}
				}
				expect(tested).toBeGreaterThan(0);
			});
		});
	}

	test("visual presets apply to video, image, text, sticker and graphic; audio presets to audio and video", () => {
		const all = clips();
		const supports = (id: KeyframePresetId) =>
			Object.keys(all).filter((type) =>
				elementSupportsKeyframePreset({
					element: all[type],
					definition: definition(id),
				}),
			);
		const visual = ["video", "image", "text", "sticker", "graphic"];
		for (const id of [
			"zoom-in",
			"zoom-out",
			"pulse",
			"shake",
			"float",
			"swing",
			"pan-left",
			"pan-right",
			"pan-up",
			"pan-down",
		] as const) {
			expect(supports(id)).toEqual(visual);
		}
		for (const id of [
			"volume-fade-in",
			"volume-fade-out",
			"volume-duck",
			"volume-swell",
		] as const) {
			expect(supports(id)).toEqual(["video", "audio"]);
		}
	});

	test("a clip without the property is refused and left alone", () => {
		const { image, audio } = clips();
		for (const [element, id] of [
			[image, "volume-fade-in"],
			[audio, "zoom-in"],
		] as const) {
			expect(
				applyKeyframePresetToElement({
					element,
					presetId: id,
					placement: "start",
					seconds: 1,
					playheadLocal: 0,
					canvas: CANVAS,
				}),
			).toBeNull();
		}
	});
});

describe("what each preset does to the picture and the sound", () => {
	const scale = ({ animations, time }: { animations: ElementAnimations | undefined; time: number }) =>
		valueAt({ animations, path: "transform.scaleX", time, fallback: 1 });

	test("zoom in grows from the current scale to 130% and holds it", () => {
		const { video } = clips();
		const { element, range } = apply({ element: video, id: "zoom-in", length: 3 });
		expect(scale({ animations: element.animations, time: 0 })).toBe(1);
		expect(scale({ animations: element.animations, time: range.end })).toBeCloseTo(1.3, 9);
		expect(scale({ animations: element.animations, time: range.end + 1000 })).toBeCloseTo(1.3, 9);
		const mid = scale({ animations: element.animations, time: (range.start + range.end) / 2 });
		expect(mid).toBeGreaterThan(1);
		expect(mid).toBeLessThan(1.3);
		// Both axes move together.
		expect(valueAt({ animations: element.animations, path: "transform.scaleY", time: range.end, fallback: 1 })).toBeCloseTo(1.3, 9);
	});

	test("zoom in builds on the clip's own scale, not on 1", () => {
		const { video } = clips();
		const scaled: TimelineElement = {
			...video,
			params: { ...video.params, "transform.scaleX": 2, "transform.scaleY": 2 },
		};
		const { element, range } = apply({ element: scaled, id: "zoom-in" });
		expect(scale({ animations: element.animations, time: 0 })).toBe(2);
		expect(scale({ animations: element.animations, time: range.end })).toBeCloseTo(2.6, 9);
	});

	test("zoom out starts big and settles on the current scale", () => {
		const { video } = clips();
		const { element, range } = apply({ element: video, id: "zoom-out" });
		expect(scale({ animations: element.animations, time: 0 })).toBeCloseTo(1.3, 9);
		expect(scale({ animations: element.animations, time: range.end })).toBe(1);
	});

	test("pulse pops to 120% at 30% of its range and is back to rest at the end", () => {
		const { video } = clips();
		const { element, range } = apply({ element: video, id: "pulse" });
		const length = range.end - range.start;
		expect(scale({ animations: element.animations, time: range.start + length * 0.3 })).toBeCloseTo(1.2, 9);
		expect(scale({ animations: element.animations, time: range.end })).toBe(1);
		expect(scale({ animations: element.animations, time: range.end + seconds(2) })).toBe(1);
	});

	test("shake wiggles the position and ends exactly where it began", () => {
		const { video } = clips();
		const placed: TimelineElement = {
			...video,
			params: { ...video.params, "transform.positionX": 40, "transform.positionY": -10 },
		};
		const { element, range } = apply({ element: placed, id: "shake" });
		const xs = keysOf({ animations: element.animations, path: "transform.positionX" });
		const ys = keysOf({ animations: element.animations, path: "transform.positionY" });
		expect(xs.length).toBeGreaterThanOrEqual(7);
		expect(xs[0].value).not.toBe(40);
		expect(xs[xs.length - 1].value).toBe(40);
		expect(ys[ys.length - 1].value).toBe(-10);
		// The jitter fades: the first swing is larger than the last one.
		expect(Math.abs(xs[0].value - 40)).toBeGreaterThan(Math.abs(xs[xs.length - 2].value - 40));
		// It stays within 1.5% of the canvas width.
		for (const key of xs) expect(Math.abs(key.value - 40)).toBeLessThanOrEqual(0.015 * CANVAS.width + 1e-9);
		expect(tick(xs[xs.length - 1].time)).toBe(range.end);
	});

	test("shake gets more keys for a longer range, but never more than 30 or fewer than 7", () => {
		const { video } = clips();
		const count = (length: number) =>
			keysOf({
				animations: apply({ element: video, id: "shake", length }).element.animations,
				path: "transform.positionX",
			}).length;
		expect(count(0.1)).toBe(7);
		expect(count(1)).toBe(15);
		expect(count(9)).toBe(31);
	});

	test("float drifts up by 3% of the canvas height and comes back", () => {
		const { image } = clips();
		const { element, range } = apply({ element: image, id: "float" });
		const mid = (range.start + range.end) / 2;
		expect(valueAt({ animations: element.animations, path: "transform.positionY", time: mid, fallback: 0 })).toBeCloseTo(-0.03 * CANVAS.height, 6);
		expect(valueAt({ animations: element.animations, path: "transform.positionY", time: range.end, fallback: 0 })).toBe(0);
	});

	test("swing rocks 8 degrees to either side and ends upright", () => {
		const { text } = clips();
		const { element, range } = apply({ element: text, id: "swing", length: 4 });
		const length = range.end - range.start;
		const at = (fraction: number) =>
			valueAt({ animations: element.animations, path: "transform.rotate", time: range.start + length * fraction, fallback: 0 });
		expect(at(0.25)).toBeCloseTo(8, 9);
		expect(at(0.75)).toBeCloseTo(-8, 9);
		expect(at(1)).toBe(0);
	});

	test("each pan moves its axis by 10% of the canvas, the right way", () => {
		const { image } = clips();
		const expected: Array<[KeyframePresetId, string, number]> = [
			["pan-left", "transform.positionX", -192],
			["pan-right", "transform.positionX", 192],
			["pan-up", "transform.positionY", -108],
			["pan-down", "transform.positionY", 108],
		];
		for (const [id, path, end] of expected) {
			const { element, range } = apply({ element: image, id });
			expect(valueAt({ animations: element.animations, path, time: range.start, fallback: 0 })).toBe(0);
			expect(valueAt({ animations: element.animations, path, time: range.end, fallback: 0 })).toBeCloseTo(end, 9);
		}
	});

	test("a pan and a zoom stack: they write different paths", () => {
		const { image } = clips();
		const zoomed = apply({ element: image, id: "zoom-in" }).element;
		const both = apply({ element: zoomed, id: "pan-left" }).element;
		expect(keysOf({ animations: both.animations, path: "transform.scaleX" })).toEqual(
			keysOf({ animations: zoomed.animations, path: "transform.scaleX" }),
		);
		expect(keysOf({ animations: both.animations, path: "transform.positionX" }).length).toBe(2);
	});

	test("fade in goes from silence (-60 dB) to the clip's volume, in a straight line in dB", () => {
		const { audio } = clips();
		const loud: TimelineElement = { ...audio, params: { ...audio.params, volume: -6 } };
		const { element, range } = apply({ element: loud, id: "volume-fade-in", length: 2 });
		const vol = (time: number) => valueAt({ animations: element.animations, path: "volume", time, fallback: -6 });
		expect(vol(0)).toBe(VOLUME_DB_MIN);
		expect(vol(range.end)).toBe(-6);
		expect(vol((range.start + range.end) / 2)).toBeCloseTo((VOLUME_DB_MIN + -6) / 2, 9);
	});

	test("fade out ends at the clip's end, at silence", () => {
		const { audio } = clips();
		const { element, range } = apply({ element: audio, id: "volume-fade-out", placement: "end", length: 2 });
		expect(range.end).toBe(CLIP);
		expect(range.start).toBe(CLIP - seconds(2));
		const vol = (time: number) => valueAt({ animations: element.animations, path: "volume", time, fallback: 0 });
		expect(vol(range.start)).toBe(0);
		expect(vol(CLIP)).toBe(VOLUME_DB_MIN);
	});

	test("duck dips 12 dB between 20% and 80% of its range and comes back", () => {
		const { video } = clips();
		const { element, range } = apply({ element: video, id: "volume-duck", length: 5 });
		const length = range.end - range.start;
		const vol = (fraction: number) => valueAt({ animations: element.animations, path: "volume", time: range.start + length * fraction, fallback: 0 });
		expect(vol(0)).toBe(0);
		expect(vol(0.2)).toBeCloseTo(-12, 9);
		expect(vol(0.5)).toBeCloseTo(-12, 9);
		expect(vol(0.8)).toBeCloseTo(-12, 9);
		expect(vol(1)).toBe(0);
	});

	test("swell rises from 18 dB below to the clip's volume in the middle and falls again", () => {
		const { audio } = clips();
		const { element, range } = apply({ element: audio, id: "volume-swell", length: 4 });
		const length = range.end - range.start;
		const vol = (fraction: number) => valueAt({ animations: element.animations, path: "volume", time: range.start + length * fraction, fallback: 0 });
		expect(vol(0)).toBe(-18);
		expect(vol(0.5)).toBeCloseTo(0, 9);
		expect(vol(1)).toBe(-18);
	});

	test("eased segments never overshoot: every value stays between the keys it joins", () => {
		const { video } = clips();
		for (const id of ["zoom-in", "zoom-out", "pulse", "float", "swing"] as const) {
			const { element, range } = apply({ element: video, id });
			for (const path of definition(id).paths) {
				const keys = keysOf({ animations: element.animations, path });
				const low = Math.min(...keys.map((key) => key.value));
				const high = Math.max(...keys.map((key) => key.value));
				for (let step = 0; step <= 200; step++) {
					const time = range.start + ((range.end - range.start) * step) / 200;
					const value = valueAt({ animations: element.animations, path, time, fallback: 0 });
					expect(value).toBeGreaterThanOrEqual(low - 1e-9);
					expect(value).toBeLessThanOrEqual(high + 1e-9);
				}
			}
		}
	});
});

describe("limits", () => {
	test("values are held to the param's own range", () => {
		const { video, audio } = clips();
		const nearZero: TimelineElement = {
			...video,
			params: { ...video.params, "transform.rotate": 359 },
		};
		const swing = apply({ element: nearZero, id: "swing" });
		for (const key of keysOf({ animations: swing.element.animations, path: "transform.rotate" })) {
			expect(key.value).toBeLessThanOrEqual(360);
			expect(key.value).toBeGreaterThanOrEqual(-360);
		}
		const quiet: TimelineElement = { ...audio, params: { ...audio.params, volume: -55 } };
		const swell = apply({ element: quiet, id: "volume-swell" });
		for (const key of keysOf({ animations: swell.element.animations, path: "volume" })) {
			expect(key.value).toBeGreaterThanOrEqual(VOLUME_DB_MIN);
		}
		const loud: TimelineElement = { ...audio, params: { ...audio.params, volume: 20 } };
		const fadeIn = apply({ element: loud, id: "volume-fade-in" });
		for (const key of keysOf({ animations: fadeIn.element.animations, path: "volume" })) {
			expect(key.value).toBeLessThanOrEqual(20);
		}
		const tiny: TimelineElement = {
			...video,
			params: { ...video.params, "transform.scaleX": 0.01, "transform.scaleY": 0.01 },
		};
		const zoomOut = apply({ element: tiny, id: "zoom-out" });
		for (const key of keysOf({ animations: zoomOut.element.animations, path: "transform.scaleX" })) {
			expect(key.value).toBeGreaterThanOrEqual(0.01);
		}
	});
});

describe("placement and length", () => {
	const place = ({ placement, playheadLocal, requested }: { placement: "start" | "playhead" | "end"; playheadLocal: number; requested: number }) =>
		resolveKeyframePresetRange({ placement, playheadLocal, clipDuration: CLIP, requestedDuration: requested });

	test("start, end and playhead", () => {
		expect(place({ placement: "start", playheadLocal: seconds(5), requested: seconds(2) })).toEqual({ start: 0, end: seconds(2) });
		expect(place({ placement: "end", playheadLocal: 0, requested: seconds(2) })).toEqual({ start: CLIP - seconds(2), end: CLIP });
		expect(place({ placement: "playhead", playheadLocal: seconds(5), requested: seconds(2) })).toEqual({ start: seconds(5), end: seconds(7) });
	});

	test("the playhead is held inside the clip and the range never runs past its end", () => {
		expect(place({ placement: "playhead", playheadLocal: -seconds(3), requested: seconds(2) })).toEqual({ start: 0, end: seconds(2) });
		expect(place({ placement: "playhead", playheadLocal: seconds(9.5), requested: seconds(2) })).toEqual({ start: seconds(8), end: CLIP });
	});

	test("a range longer than the clip is cut to the clip", () => {
		expect(place({ placement: "playhead", playheadLocal: seconds(4), requested: seconds(30) })).toEqual({ start: 0, end: CLIP });
	});

	test("a clip or length under the 0.1 s minimum gets no preset", () => {
		expect(MIN_KEYFRAME_PRESET_SECONDS).toBe(0.1);
		expect(place({ placement: "start", playheadLocal: 0, requested: seconds(0.05) })).toBeNull();
		expect(resolveKeyframePresetRange({ placement: "start", playheadLocal: 0, clipDuration: seconds(0.05), requestedDuration: seconds(1) })).toBeNull();
		expect(place({ placement: "start", playheadLocal: 0, requested: seconds(0.1) })).toEqual({ start: 0, end: seconds(0.1) });
	});

	test("an applied preset is a whole number of ticks inside the clip", () => {
		const { video } = clips();
		const { element, range } = apply({ element: video, id: "pulse", placement: "playhead", playhead: seconds(3.337), length: 0.77 });
		for (const path of definition("pulse").paths) {
			for (const key of keysOf({ animations: element.animations, path })) {
				expect(Number.isInteger(key.time)).toBe(true);
				expect(key.time).toBeGreaterThanOrEqual(range.start);
				expect(key.time).toBeLessThanOrEqual(range.end);
				expect(key.time).toBeLessThanOrEqual(CLIP);
			}
		}
	});
});

describe("over existing keyframes", () => {
	const RANGE: KeyframePresetRange = { start: seconds(2), end: seconds(4) };
	function existing(): ElementAnimations {
		const key = ({ id, time, value }: { id: string; time: number; value: number }): ScalarAnimationKey => ({
			id,
			time: mediaTime({ ticks: time }),
			value,
			segmentToNext: "linear",
			tangentMode: "flat",
		});
		return {
			"transform.scaleX": {
				keys: [key({ id: "before", time: seconds(1), value: 1.5 }), key({ id: "inside-a", time: seconds(2), value: 9 }), key({ id: "inside-b", time: seconds(3), value: 9 }), key({ id: "after", time: seconds(6), value: 2 })],
				extrapolation: { before: "linear", after: "hold" },
			},
			opacity: { keys: [key({ id: "o", time: seconds(3), value: 0.5 })] },
		};
	}

	test("keys inside the range (ends included) are replaced, keys outside stay", () => {
		const next = applyKeyframePresetToAnimations({
			animations: existing(),
			definition: definition("zoom-in"),
			range: RANGE,
			canvas: CANVAS,
			base: { "transform.scaleX": 1.5, "transform.scaleY": 1.5 },
			limits: {},
		});
		const keys = keysOf({ animations: next, path: "transform.scaleX" });
		expect(keys.map((key) => key.id).filter((id) => id === "before" || id === "after")).toEqual(["before", "after"]);
		expect(keys.some((key) => key.id === "inside-a" || key.id === "inside-b")).toBe(false);
		expect(keys.map((key) => tick(key.time))).toEqual([seconds(1), seconds(2), seconds(4), seconds(6)]);
		expect(keys.map((key) => key.value)).toEqual([1.5, 1.5, 1.5 * 1.3, 2]);
	});

	test("other paths and the channel's extrapolation are untouched", () => {
		const before = existing();
		const next = applyKeyframePresetToAnimations({
			animations: before,
			definition: definition("zoom-in"),
			range: RANGE,
			canvas: CANVAS,
			base: { "transform.scaleX": 1, "transform.scaleY": 1 },
			limits: {},
		});
		expect(next?.opacity).toEqual(before.opacity);
		const channel = getChannel({ animations: next, propertyPath: "transform.scaleX" });
		expect(channel && isScalarChannel(channel) ? channel.extrapolation : undefined).toEqual({ before: "linear", after: "hold" });
	});

	test("the keys are built around the value the clip has where the range starts", () => {
		const { video } = clips();
		const animated: TimelineElement = {
			...video,
			animations: {
				"transform.scaleX": {
					keys: [
						{ id: "a", time: mediaTime({ ticks: 0 }), value: 1, segmentToNext: "linear", tangentMode: "flat" },
						{ id: "b", time: mediaTime({ ticks: seconds(4) }), value: 2, segmentToNext: "linear", tangentMode: "flat" },
					],
				},
			},
		};
		const { element } = apply({ element: animated, id: "pulse", placement: "playhead", playhead: seconds(2), length: 1 });
		const keys = keysOf({ animations: element.animations, path: "transform.scaleX" });
		const first = keys.find((key) => key.time === seconds(2));
		expect(first?.value).toBeCloseTo(1.5, 9);
		const peak = keys.find((key) => key.time === seconds(2) + Math.round(0.3 * seconds(1)));
		expect(peak?.value).toBeCloseTo(1.8, 9);
	});

	test("applying a preset twice leaves one copy of it", () => {
		const { video } = clips();
		const once = apply({ element: video, id: "pulse" });
		const twice = apply({ element: once.element, id: "pulse" });
		const shape = (animations: ElementAnimations | undefined) =>
			keysOf({ animations, path: "transform.scaleX" }).map((key) => [key.time, key.value]);
		expect(shape(twice.element.animations)).toEqual(shape(once.element.animations));
	});

	test("an empty or reversed range is refused", () => {
		expect(() =>
			applyKeyframePresetToAnimations({
				animations: undefined,
				definition: definition("pulse"),
				range: { start: 5, end: 5 },
				canvas: CANVAS,
				base: {},
				limits: {},
			}),
		).toThrow(RangeError);
	});
});

describe("buildPresetKeys", () => {
	test("plan keys that land on one tick collapse into the later one", () => {
		const keys = buildPresetKeys({
			plan: [
				{ at: 0, value: 1, easing: "linear" },
				{ at: 0.4, value: 2, easing: "linear" },
				{ at: 0.4, value: 3, easing: "linear" },
				{ at: 1, value: 4, easing: "linear" },
			],
			range: { start: 0, end: 1000 },
		});
		expect(keys.map((key) => [key.time, key.value])).toEqual([
			[0, 1],
			[400, 3],
			[1000, 4],
		]);
	});

	test("ids are unique", () => {
		const keys = buildPresetKeys({
			plan: definition("shake").plan({ base: { "transform.positionX": 0, "transform.positionY": 0 }, canvas: CANVAS, seconds: 3 })["transform.positionX"],
			range: { start: 0, end: seconds(3) },
		});
		expect(new Set(keys.map((key) => key.id)).size).toBe(keys.length);
	});
});

describe("segment easing", () => {
	function pair(): [ScalarAnimationKey, ScalarAnimationKey] {
		return [
			{ id: "l", time: mediaTime({ ticks: 0 }), value: 0, segmentToNext: "linear", tangentMode: "flat" },
			{ id: "r", time: mediaTime({ ticks: 1000 }), value: 10, segmentToNext: "linear", tangentMode: "flat" },
		];
	}

	test("every menu entry is recognised again after it is written", () => {
		for (const easing of SEGMENT_EASING_IDS) {
			const [left, right] = pair();
			const patch = getSegmentEasingPatch({ leftKey: left, rightKey: right, easing });
			if (!patch) throw new Error(`no patch for ${easing}`);
			const written = { ...left, segmentToNext: patch.segmentToNext, rightHandle: patch.rightHandle ?? undefined };
			const target = { ...right, leftHandle: patch.nextLeftHandle ?? undefined };
			expect(detectSegmentEasing({ leftKey: written, rightKey: target })).toBe(easing);
		}
	});

	test("a hand-shaped curve reads as custom", () => {
		const [left, right] = pair();
		const written = { ...left, segmentToNext: "bezier" as const, rightHandle: { dt: mediaTime({ ticks: 100 }), dv: 9 } };
		const target = { ...right, leftHandle: { dt: mediaTime({ ticks: -100 }), dv: -1 } };
		expect(detectSegmentEasing({ leftKey: written, rightKey: target })).toBe("custom");
	});

	test("a segment between equal values is a plain line whatever the easing", () => {
		const [left, right] = pair();
		const flat = { ...right, value: 0 };
		expect(getSegmentEasingPatch({ leftKey: left, rightKey: flat, easing: "ease-in-out" })?.segmentToNext).toBe("linear");
	});

	test("two keys on one tick cannot be eased", () => {
		const [left, right] = pair();
		expect(getSegmentEasingPatch({ leftKey: left, rightKey: { ...right, time: left.time }, easing: "ease-in" })).toBeNull();
	});

	test("ease in starts slow and ease out starts fast", () => {
		const sample = (easing: "ease-in" | "ease-out") => {
			const [left, right] = pair();
			const patch = getSegmentEasingPatch({ leftKey: left, rightKey: right, easing });
			if (!patch) throw new Error("no patch");
			return resolveAnimationPathValueAtTime({
				animations: {
					v: {
						keys: [
							{ ...left, segmentToNext: patch.segmentToNext, rightHandle: patch.rightHandle ?? undefined },
							{ ...right, leftHandle: patch.nextLeftHandle ?? undefined },
						],
					},
				},
				propertyPath: "v",
				localTime: 250,
				fallbackValue: 0,
			});
		};
		expect(sample("ease-in")).toBeLessThan(2.5);
		expect(sample("ease-out")).toBeGreaterThan(2.5);
	});
});

describe("what a click asks for", () => {
	const pulse = definition("pulse");
	test("auto and an empty length use the preset's own", () => {
		expect(resolveKeyframePresetRequest({ definition: pulse, placement: "auto", lengthText: "" })).toEqual({ placement: "playhead", seconds: 0.4 });
		expect(resolveKeyframePresetRequest({ definition: definition("volume-fade-out"), placement: "auto", lengthText: "  " })).toEqual({ placement: "end", seconds: 1 });
	});
	test("the user's placement and length win", () => {
		expect(resolveKeyframePresetRequest({ definition: pulse, placement: "start", lengthText: "2.5" })).toEqual({ placement: "start", seconds: 2.5 });
	});
	test("a length under the minimum or over ten minutes is held to the limits", () => {
		expect(resolveKeyframePresetRequest({ definition: pulse, placement: "auto", lengthText: "0" })?.seconds).toBe(0.1);
		expect(resolveKeyframePresetRequest({ definition: pulse, placement: "auto", lengthText: "100000" })?.seconds).toBe(600);
	});
	test("text that is not a number is refused", () => {
		expect(resolveKeyframePresetRequest({ definition: pulse, placement: "auto", lengthText: "abc" })).toBeNull();
		expect(resolveKeyframePresetRequest({ definition: pulse, placement: "auto", lengthText: "Infinity" })).toBeNull();
	});
});
