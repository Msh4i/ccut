import { create } from "zustand";
import type { MediaTime } from "@/wasm";

/**
 * Beats picked on ONE clip, as source-media ticks: the values stored in
 * `element.beats`, so they survive trimming, retiming and zooming. Not saved
 * with the project: it is only what the next "keep"/"delete" acts on.
 */
export type BeatSelection = {
	trackId: string;
	elementId: string;
	ticks: ReadonlySet<number>;
	/** Where a range pick (Shift) starts. */
	anchor: number | null;
};

/** replace: this beat only. toggle (Ctrl/Cmd): add or drop it. range (Shift): from the anchor to it. */
export type BeatPickMode = "replace" | "toggle" | "range";

/** The selection after picking `tick` among the `visible` beats of a clip, ascending. */
export function pickBeat({
	current,
	trackId,
	elementId,
	tick,
	mode,
	visible,
}: {
	current: BeatSelection | null;
	trackId: string;
	elementId: string;
	tick: number;
	mode: BeatPickMode;
	visible: readonly number[];
}): BeatSelection | null {
	// Picks on another clip start over.
	const own = current?.elementId === elementId ? current : null;

	if (mode === "range" && own?.anchor != null) {
		const from = Math.min(own.anchor, tick);
		const to = Math.max(own.anchor, tick);
		const ticks = new Set(visible.filter((beat) => beat >= from && beat <= to));
		return { trackId, elementId, ticks, anchor: own.anchor };
	}

	if (mode === "toggle") {
		const ticks = new Set(own?.ticks);
		if (!ticks.delete(tick)) ticks.add(tick);
		return ticks.size > 0 ? { trackId, elementId, ticks, anchor: tick } : null;
	}

	// Clicking the one picked beat again drops it.
	if (own?.ticks.size === 1 && own.ticks.has(tick)) {
		return null;
	}
	return { trackId, elementId, ticks: new Set([tick]), anchor: tick };
}

/** The beats that stay when only the picked ones are kept (empty when none match). */
export function keepPicked({
	beats,
	ticks,
}: {
	beats: readonly MediaTime[];
	ticks: ReadonlySet<number>;
}): MediaTime[] {
	return beats.filter((beat) => ticks.has(beat));
}

/** The beats that stay when the picked ones are deleted. */
export function dropPicked({
	beats,
	ticks,
}: {
	beats: readonly MediaTime[];
	ticks: ReadonlySet<number>;
}): MediaTime[] {
	return beats.filter((beat) => !ticks.has(beat));
}

/**
 * What "keep" or "delete" writes to `element.beats`, or `null` to leave the clip
 * alone. Only picked beats inside the clip's visible window count (a trim since
 * the pick may have hidden some), and "keep" never touches the beats outside the
 * window. `beats: undefined` means no beat is left.
 */
export function editPickedBeats({
	beats,
	visible,
	ticks,
	keep,
}: {
	beats: readonly MediaTime[];
	visible: readonly number[];
	ticks: ReadonlySet<number>;
	keep: boolean;
}): { beats: MediaTime[] | undefined } | null {
	const shown = new Set(visible);
	const picked = new Set([...ticks].filter((tick) => shown.has(tick)));
	if (picked.size === 0) {
		return null;
	}
	const next = keep
		? beats.filter((beat) => picked.has(beat) || !shown.has(beat))
		: dropPicked({ beats, ticks: picked });
	return { beats: next.length > 0 ? next : undefined };
}

export const useBeatSelectionStore = create<{ selection: BeatSelection | null }>(
	() => ({ selection: null }),
);

export function pickBeatOnClip(args: Omit<Parameters<typeof pickBeat>[0], "current">) {
	useBeatSelectionStore.setState(({ selection }) => ({
		selection: pickBeat({ current: selection, ...args }),
	}));
}

export function clearBeatSelection() {
	useBeatSelectionStore.setState({ selection: null });
}
