import type { SceneTracks, TimelineElement } from "@/timeline";
import { mediaTime, type MediaTime } from "@/wasm";

/** 30 min at 200 BPM is 6000 beats, so this only ever trims hostile data. */
export const MAX_BEATS_PER_CLIP = 20_000;
const MAX_RAW_LENGTH = 10 * MAX_BEATS_PER_CLIP;

function isNormalized(raw: unknown): raw is MediaTime[] {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BEATS_PER_CLIP) {
		return false;
	}
	let previous = -1;
	for (const value of raw) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= previous) {
			return false;
		}
		previous = value;
	}
	return true;
}

/**
 * Beats as stored in a project may be anything. Returns ascending, unique,
 * non-negative whole ticks (the input itself when it already is), or
 * `undefined` when nothing usable is left, which reads as "not analysed".
 */
export function normalizeBeats({ raw }: { raw: unknown }): MediaTime[] | undefined {
	if (isNormalized(raw)) {
		return raw;
	}
	if (!Array.isArray(raw) || raw.length > MAX_RAW_LENGTH) {
		return undefined;
	}

	const unique = new Set<number>();
	for (const value of raw) {
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
			unique.add(value);
		}
	}
	if (unique.size === 0) {
		return undefined;
	}
	return [...unique]
		.sort((a, b) => a - b)
		.slice(0, MAX_BEATS_PER_CLIP)
		.map((ticks) => mediaTime({ ticks }));
}

function normalizeElement<T extends TimelineElement>(element: T): T {
	if (!element || (element.type !== "audio" && element.type !== "video")) {
		return element;
	}
	const raw: unknown = element.beats;
	if (raw === undefined) {
		return element;
	}
	const beats = normalizeBeats({ raw });
	if (beats === raw) {
		return element;
	}
	return { ...element, beats };
}

function mapUnchanged<T>({
	items,
	map,
}: {
	items: T[];
	map: (item: T) => T;
}): T[] {
	let changed = false;
	const next = items.map((item) => {
		const mapped = map(item);
		if (mapped !== item) changed = true;
		return mapped;
	});
	return changed ? next : items;
}

/** Applies `normalizeBeats` to every clip; untouched parts keep their identity. */
export function normalizeSceneTracksBeats({
	tracks,
}: {
	tracks: SceneTracks;
}): SceneTracks {
	// Loaded data is untrusted: a broken shape is not ours to fix.
	if (
		!Array.isArray(tracks.overlay) ||
		!Array.isArray(tracks.audio) ||
		![...tracks.overlay, tracks.main, ...tracks.audio].every((track) =>
			Array.isArray(track?.elements),
		)
	) {
		return tracks;
	}

	const overlay = mapUnchanged({
		items: tracks.overlay,
		map: (track) => {
			if (track.type !== "video") return track;
			const elements = mapUnchanged({
				items: track.elements,
				map: normalizeElement,
			});
			return elements === track.elements ? track : { ...track, elements };
		},
	});
	const mainElements = mapUnchanged({
		items: tracks.main.elements,
		map: normalizeElement,
	});
	const audio = mapUnchanged({
		items: tracks.audio,
		map: (track) => {
			const elements = mapUnchanged({
				items: track.elements,
				map: normalizeElement,
			});
			return elements === track.elements ? track : { ...track, elements };
		},
	});

	if (
		overlay === tracks.overlay &&
		mainElements === tracks.main.elements &&
		audio === tracks.audio
	) {
		return tracks;
	}
	return {
		overlay,
		main:
			mainElements === tracks.main.elements
				? tracks.main
				: { ...tracks.main, elements: mainElements },
		audio,
	};
}
