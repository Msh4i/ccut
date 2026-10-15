import { getChannel } from "@/animation/keyframes";
import { isScalarChannel } from "@/animation/interpolation";
import { resolveAnimationPathValueAtTime } from "@/animation";
import { getDbFromLinePos, getLinePosFromDb } from "@/timeline/audio-display";
import { clampDb, getElementVolume, type AudioCapableElement } from "@/timeline/audio-state";

/** Nearest the line steps before a click on a point counts as a click on the line. */
export const ENVELOPE_POLYLINE_STEPS = 96;

export interface EnvelopePoint {
	id: string;
	/** Ticks from the clip's start. */
	time: number;
	db: number;
	/** 0..100 across the clip. */
	xPercent: number;
	/** 0..100 from the top, on the same scale as the static volume line. */
	yPercent: number;
}

function toPoint({
	id,
	time,
	db,
	duration,
}: {
	id: string;
	time: number;
	db: number;
	duration: number;
}): EnvelopePoint {
	return {
		id,
		time,
		db,
		xPercent: duration <= 0 ? 0 : (time / duration) * 100,
		yPercent: getLinePosFromDb({ db }),
	};
}

/** The keys of the clip's volume channel, in time order. */
export function getVolumeEnvelopePoints({
	element,
}: {
	element: AudioCapableElement;
}): EnvelopePoint[] {
	const channel = getChannel({
		animations: element.animations,
		propertyPath: "volume",
	});
	if (!channel || !isScalarChannel(channel)) {
		return [];
	}
	return channel.keys.map((key) =>
		toPoint({
			id: key.id,
			time: key.time,
			db: key.value,
			duration: element.duration,
		}),
	);
}

/**
 * A pointer position over the clip as a time and a volume. Positions are
 * fractions (0 to 1) of the clip's width and height; they are held to the clip
 * and to the volume range.
 */
export function pointFromPosition({
	x,
	y,
	duration,
}: {
	x: number;
	y: number;
	duration: number;
}): { time: number; db: number } {
	const clampedX = Math.max(0, Math.min(1, x));
	return {
		time: Math.round(clampedX * duration),
		db: clampDb(getDbFromLinePos({ percent: Math.max(0, Math.min(1, y)) * 100 })),
	};
}

/**
 * The curve to draw: the volume as the renderer and the mixer resolve it,
 * sampled across the clip, as [x, y] percentages. Bezier and hold segments
 * therefore look the way they sound.
 */
export function buildEnvelopePolyline({
	element,
	steps = ENVELOPE_POLYLINE_STEPS,
}: {
	element: AudioCapableElement;
	steps?: number;
}): Array<[number, number]> {
	const fallback = getElementVolume({ element });
	const out: Array<[number, number]> = [];
	for (let index = 0; index <= steps; index++) {
		const fraction = index / steps;
		const db = resolveAnimationPathValueAtTime({
			animations: element.animations,
			propertyPath: "volume",
			localTime: Math.round(fraction * element.duration),
			fallbackValue: fallback,
		});
		out.push([fraction * 100, getLinePosFromDb({ db })]);
	}
	return out;
}
