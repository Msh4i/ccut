import { getChannel, resolveAnimationPathValueAtTime, setChannel } from "@/animation";
import { isScalarChannel } from "@/animation/interpolation";
import type {
	ElementAnimations,
	ScalarAnimationChannel,
	ScalarAnimationKey,
} from "@/animation/types";
import type { ParamValues } from "@/params";
import { buildTransformFromParams } from "@/rendering";
import { generateUUID } from "@/utils/id";
import {
	clampMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTimeFromSeconds,
	minMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import type { PinKey, SimplifiedPinChannels } from "./simplify-channels";

/** The five channels a camera pin writes, by the names `buildCameraPinChannels` uses. */
const CHANNEL_NAMES = ["x", "y", "scaleX", "scaleY", "rotate"] as const;

export type CameraPinChannelName = (typeof CHANNEL_NAMES)[number];

export const CAMERA_PIN_PATHS = {
	x: "transform.positionX",
	y: "transform.positionY",
	scaleX: "transform.scaleX",
	scaleY: "transform.scaleY",
	rotate: "transform.rotate",
} as const satisfies Record<CameraPinChannelName, string>;

/** Keyframes of the five channels, times relative to the element's start. */
export type CameraPinKeys = Record<CameraPinChannelName, ScalarAnimationKey[]>;

/** The stretch of the element a pin covers, in ticks from the element's start; both ends belong to it. */
export interface CameraPinRange {
	start: MediaTime;
	end: MediaTime;
}

function scalarKey({ time, value }: { time: MediaTime; value: number }): ScalarAnimationKey {
	return {
		id: generateUUID(),
		time,
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

/**
 * Turns simplified channels (timeline seconds) into keyframes of an element
 * that starts at `elementStartSec`: integer ticks, linear segments, flat
 * tangents, as the follow keys are. Times are held inside the element. Keys
 * that land on the same tick collapse into one (the last sample's value wins
 * at the end). The range is from the first to the last key of any channel.
 */
export function buildCameraPinKeys({
	simplified,
	elementStartSec,
	durationTicks,
}: {
	simplified: SimplifiedPinChannels;
	elementStartSec: number;
	durationTicks: MediaTime;
}): { keys: CameraPinKeys; range: CameraPinRange } {
	const convert = ({ source, name }: { source: PinKey[]; name: string }): ScalarAnimationKey[] => {
		const out: ScalarAnimationKey[] = [];
		source.forEach((sample, index) => {
			const time = clampMediaTime({
				time: mediaTimeFromSeconds({ seconds: sample.time - elementStartSec }),
				min: ZERO_MEDIA_TIME,
				max: durationTicks,
			});
			const previous = out[out.length - 1];
			if (previous && previous.time === time) {
				if (index === source.length - 1) out[out.length - 1] = { ...previous, value: sample.value };
				return;
			}
			out.push(scalarKey({ time, value: sample.value }));
		});
		if (out.length === 0) throw new Error(`camera pin: the ${name} channel has no keys`);
		return out;
	};
	const keys = {
		x: convert({ source: simplified.x, name: "x" }),
		y: convert({ source: simplified.y, name: "y" }),
		scaleX: convert({ source: simplified.scaleX, name: "scaleX" }),
		scaleY: convert({ source: simplified.scaleY, name: "scaleY" }),
		rotate: convert({ source: simplified.rotate, name: "rotate" }),
	};
	let start = keys.x[0].time;
	let end = keys.x[keys.x.length - 1].time;
	for (const name of CHANNEL_NAMES) {
		start = minMediaTime({ a: start, b: keys[name][0].time });
		end = maxMediaTime({ a: end, b: keys[name][keys[name].length - 1].time });
	}
	return { keys, range: { start, end } };
}

/** The scalar channel of an animation path (for the pin's paths, the only kind there is), or undefined. */
export function getScalarChannel({
	animations,
	path,
}: {
	animations: ElementAnimations | undefined;
	path: string;
}): ScalarAnimationChannel | undefined {
	const channel = getChannel({ animations, propertyPath: path });
	return channel && isScalarChannel(channel) ? channel : undefined;
}

function isInside({ time, range }: { time: number; range: CameraPinRange }): boolean {
	return time >= range.start && time <= range.end;
}

function withKeys({
	animations,
	path,
	keys,
	extrapolation,
}: {
	animations: ElementAnimations | undefined;
	path: string;
	keys: ScalarAnimationKey[];
	extrapolation: ScalarAnimationChannel["extrapolation"];
}): ElementAnimations | undefined {
	return setChannel({
		animations,
		propertyPath: path,
		channel: extrapolation ? { keys, extrapolation } : { keys },
	});
}

/**
 * Writes the five channels with `setChannel`, which keeps decimals (the
 * single-keyframe path snaps to whole pixels and degrees, which would make a
 * stuck element jitter). Only keys inside `range` are replaced: keys outside
 * stay exactly as they were, the channel holds its end values beyond them, so
 * a second pin on another segment does not touch the first. Everything else
 * in `animations` (opacity, colours, effects) is the same objects as before.
 */
export function applyCameraPinChannels({
	animations,
	channels,
	range,
}: {
	animations: ElementAnimations | undefined;
	channels: CameraPinKeys;
	range: CameraPinRange;
}): ElementAnimations | undefined {
	if (!(range.start <= range.end)) {
		throw new RangeError("camera pin: the range ends before it starts");
	}
	for (const name of CHANNEL_NAMES) {
		const written = channels[name];
		if (written.length === 0) throw new Error(`camera pin: the ${name} channel has no keys`);
		if (written.some((key) => !isInside({ time: key.time, range }))) {
			throw new RangeError(`camera pin: a ${name} key lies outside the pin range`);
		}
	}
	let next = animations;
	for (const name of CHANNEL_NAMES) {
		const path = CAMERA_PIN_PATHS[name];
		const existing = getScalarChannel({ animations: next, path });
		const outside = (existing?.keys ?? []).filter((key) => !isInside({ time: key.time, range }));
		next = withKeys({
			animations: next,
			path,
			keys: [...outside, ...channels[name]],
			extrapolation: existing?.extrapolation,
		});
	}
	return next;
}

/** A rotation as an equal one within a half turn either way, which the rotate field accepts. */
function foldDegrees(value: number): number {
	return value - 360 * Math.round(value / 360);
}

/**
 * Takes a camera pin off an element (Unstick) so that nothing jumps at
 * `localTime` (ticks from the element's start, held inside `range`). Per
 * channel that has keys in `range`:
 *  - no key outside the range: the channel goes and the look at `localTime` is
 *    written into the base params, as it was, decimals and all (rotation folded
 *    to an equal angle within a half turn);
 *  - keys outside the range (another pin): they stay, and the removed stretch
 *    holds the look at `localTime` from end to end with two flat keys.
 * Channels without keys in the range, and everything else, are left alone.
 */
export function removeCameraPinChannels<
	T extends { animations?: ElementAnimations; params: ParamValues },
>({
	element,
	range,
	localTime,
}: {
	element: T;
	range: CameraPinRange;
	localTime: number;
}): T {
	const base = buildTransformFromParams({ params: element.params });
	const fallback: Record<CameraPinChannelName, number> = {
		x: base.position.x,
		y: base.position.y,
		scaleX: base.scaleX,
		scaleY: base.scaleY,
		rotate: base.rotate,
	};
	const at = Math.min(Math.max(localTime, range.start), range.end);
	let animations = element.animations;
	let params = element.params;
	let touched = false;
	for (const name of CHANNEL_NAMES) {
		const path = CAMERA_PIN_PATHS[name];
		const existing = getScalarChannel({ animations: element.animations, path });
		if (!existing || !existing.keys.some((key) => isInside({ time: key.time, range }))) continue;
		touched = true;
		const value = resolveAnimationPathValueAtTime({
			animations: element.animations,
			propertyPath: path,
			localTime: at,
			fallbackValue: fallback[name],
		});
		const outside = existing.keys.filter((key) => !isInside({ time: key.time, range }));
		if (outside.length === 0) {
			animations = setChannel({ animations, propertyPath: path, channel: undefined });
			params = { ...params, [path]: name === "rotate" ? foldDegrees(value) : value };
			continue;
		}
		const holds =
			range.start === range.end
				? [scalarKey({ time: range.start, value })]
				: [scalarKey({ time: range.start, value }), scalarKey({ time: range.end, value })];
		animations = withKeys({
			animations,
			path,
			keys: [...outside, ...holds],
			extrapolation: existing.extrapolation,
		});
	}
	return touched ? { ...element, animations, params } : element;
}
