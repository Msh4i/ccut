import { getClipTimeAtSourceTime, getSourceSpanAtClipTime } from "@/retime";
import { isSourceAudioSeparated } from "@/timeline/audio-separation";
import type { AudioCapableElement } from "@/timeline/audio-state";
import { addMediaTime, type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import { roundMediaTime } from "@/wasm/media-time";
import { normalizeBeats } from "./normalize";

// Elements are immutable, so the offsets of one element never go stale. A
// preview element during a live trim is a new object and simply misses.
const offsetsByElement = new WeakMap<AudioCapableElement, readonly MediaTime[]>();
const sourceBeatsByElement = new WeakMap<AudioCapableElement, readonly MediaTime[]>();
// Clips split or copied from one another share the same beats array.
const normalizedByBeats = new WeakMap<object, MediaTime[] | undefined>();

function getNormalizedBeats({ raw }: { raw: unknown }): MediaTime[] | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	if (!normalizedByBeats.has(raw)) {
		normalizedByBeats.set(raw, normalizeBeats({ raw }));
	}
	return normalizedByBeats.get(raw);
}

/** Index of the first value that is >= `target` in an ascending array. */
function lowerBound({
	values,
	target,
}: {
	values: MediaTime[];
	target: number;
}): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle] < target) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

/**
 * Beats inside the visible window of a clip, as ticks from the clip start.
 *
 * `element.beats` are source-media ticks and never change. The window is
 * `[trimStart, trimStart + source span of duration)`, half open, with the span
 * rounded exactly like `SplitElementsCommand` does, so the two halves of a
 * split clip together own every beat of the original exactly once. A video
 * whose audio was separated shows none: the extracted audio clip owns them.
 * Stored beats are untrusted: anything unusable is dropped.
 */
export function getBeatClipOffsets({
	element,
}: {
	element: AudioCapableElement;
}): readonly MediaTime[] {
	const cached = offsetsByElement.get(element);
	if (cached) {
		return cached;
	}
	const offsets = computeBeatClipOffsets({ element });
	offsetsByElement.set(element, offsets);
	return offsets;
}

/**
 * The stored beats inside the visible window of a clip, as source-media ticks,
 * ascending. `getBeatClipOffsets` is the same list in clip time, item for item,
 * so a beat picked on screen can be found in `element.beats` again.
 */
export function getVisibleSourceBeats({
	element,
}: {
	element: AudioCapableElement;
}): readonly MediaTime[] {
	const cached = sourceBeatsByElement.get(element);
	if (cached) {
		return cached;
	}
	const beats = computeVisibleSourceBeats({ element });
	sourceBeatsByElement.set(element, beats);
	return beats;
}

function computeBeatClipOffsets({
	element,
}: {
	element: AudioCapableElement;
}): MediaTime[] {
	const { trimStart, retime } = element;
	return computeVisibleSourceBeats({ element }).map((beat) =>
		roundMediaTime({
			time: getClipTimeAtSourceTime({ sourceTime: beat - trimStart, retime }),
		}),
	);
}

/**
 * The part of the source the given clips of one media actually play, in source
 * seconds: from the earliest trim start to the latest end of a clip's span.
 */
export function getClipsSourceRangeSeconds({
	elements,
}: {
	elements: AudioCapableElement[];
}): { startSeconds: number; endSeconds: number } {
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const { trimStart, duration, retime } of elements) {
		const span = roundMediaTime({ time: getSourceSpanAtClipTime({ clipTime: duration, retime }) });
		start = Math.min(start, trimStart);
		end = Math.max(end, trimStart + span);
	}
	return { startSeconds: start / TICKS_PER_SECOND, endSeconds: end / TICKS_PER_SECOND };
}

function computeVisibleSourceBeats({
	element,
}: {
	element: AudioCapableElement;
}): MediaTime[] {
	const { trimStart, duration, retime } = element;
	const beats = getNormalizedBeats({ raw: element.beats });
	if (!beats || (element.type === "video" && isSourceAudioSeparated({ element }))) {
		return [];
	}

	const windowEnd =
		trimStart +
		roundMediaTime({ time: getSourceSpanAtClipTime({ clipTime: duration, retime }) });
	const from = lowerBound({ values: beats, target: trimStart });
	const to = lowerBound({ values: beats, target: windowEnd });
	return beats.slice(from, to);
}

export function getBeatTimelineTimes({
	element,
}: {
	element: AudioCapableElement;
}): MediaTime[] {
	return getBeatClipOffsets({ element }).map((offset) =>
		addMediaTime({ a: element.startTime, b: offset }),
	);
}
