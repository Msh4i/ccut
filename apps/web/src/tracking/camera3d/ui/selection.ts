/**
 * Selection of track points (AE: click, Shift-click, marquee, lasso). A
 * selection is a sorted list of unique track ids: tracks, not frame samples,
 * so it survives scrubbing (the target it defines is a 3D object).
 */

export type Selection = readonly number[];

export type SelectionHit =
	| { kind: "point"; trackId: number }
	| { kind: "triangle"; trackIds: readonly [number, number, number] }
	| { kind: "none" };

function normalized(ids: Iterable<number>): Selection {
	return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * A click (pointer down and up without a drag). On a point: that point
 * alone, Shift toggles it. On a hovered triangle: its three points, Shift
 * adds them (or removes them when all three are already selected). On
 * nothing: clears, Shift keeps the selection.
 */
export function selectOnClick({
	selection,
	hit,
	shift,
}: {
	selection: Selection;
	hit: SelectionHit;
	shift: boolean;
}): Selection {
	if (hit.kind === "none") return shift ? selection : [];
	if (hit.kind === "point") {
		if (!shift) return [hit.trackId];
		return selection.includes(hit.trackId)
			? selection.filter((id) => id !== hit.trackId)
			: normalized([...selection, hit.trackId]);
	}
	if (!shift) return normalized(hit.trackIds);
	const allSelected = hit.trackIds.every((id) => selection.includes(id));
	return allSelected
		? selection.filter((id) => !hit.trackIds.includes(id))
		: normalized([...selection, ...hit.trackIds]);
}

/** A marquee or lasso: replaces the selection, Shift adds to it. */
export function selectInRegion({
	selection,
	trackIds,
	shift,
}: {
	selection: Selection;
	trackIds: readonly number[];
	shift: boolean;
}): Selection {
	return normalized(shift ? [...selection, ...trackIds] : trackIds);
}

/**
 * Drops ids that can no longer be selected (deleted, or without a solved 3D
 * point after a re-solve). Returns the same array when nothing is dropped,
 * so a store update can be skipped.
 */
export function keepSelectable({
	selection,
	selectable,
}: {
	selection: Selection;
	selectable: (trackId: number) => boolean;
}): Selection {
	const kept = selection.filter(selectable);
	return kept.length === selection.length ? selection : kept;
}
