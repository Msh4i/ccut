import { memo, useMemo } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { timelineTimeToPixels } from "@/timeline";
import {
	TIMELINE_BEAT_MARKER_COLOR,
	TIMELINE_BEAT_MARKER_HALO_COLOR,
	TIMELINE_BEAT_MARKER_PICKED_COLOR,
} from "@/timeline/components/theme";
import type { TimelineElement } from "@/timeline/types";
import { cn } from "@/utils/ui";
import type { MediaTime } from "@/wasm";
import {
	buildBeatTickPath,
	getBeatMarkerPath,
	isBeatMarkerSpacingTooDense,
	nearestBeatIndex,
} from "../marker-path";
import { getBeatClipOffsets, getVisibleSourceBeats } from "../resolve";
import { pickBeatOnClip, useBeatSelectionStore } from "../selection";

const NO_BEATS: readonly MediaTime[] = [];
const NO_TICKS: ReadonlySet<number> = new Set();
/** A click this close to a tick (px) picks it; anywhere else it reaches the clip. */
const PICK_RADIUS_PX = 6;
/** The clip's trim handles are 8 px wide: a tick closer to an edge than its pick strip plus that is not pickable. */
const EDGE_INSET_PX = 8 + PICK_RADIUS_PX;
const MOUSE_BUTTON_RIGHT = 2;

/**
 * Beat ticks along the bottom third of a clip. Positions are clip-relative.
 * `isDimmed` follows the clip body (hidden or drop-target clips).
 *
 * The ticks can be picked: the SVG itself ignores the pointer, only an invisible
 * wide stroke along the ticks takes it, so a click between ticks still selects
 * or drags the clip. Picked ticks are amber and are what the toolbar's "keep" and
 * "delete" act on.
 */
export const BeatMarkers = memo(function BeatMarkers({
	element,
	trackId,
	zoomLevel,
	width,
	height,
	isDimmed,
	onSecondaryMouseDown,
}: {
	element: TimelineElement;
	trackId: string;
	zoomLevel: number;
	width: number;
	height: number;
	isDimmed: boolean;
	/** The clip's own handling of a right-click (it selects the clip), which a tick must not swallow. */
	onSecondaryMouseDown: (event: MouseEvent) => void;
}) {
	const isAudible = element.type === "audio" || element.type === "video";
	// Same list twice: where each beat sits in the clip, and its stored tick.
	const offsets = useMemo(
		() => (isAudible ? getBeatClipOffsets({ element }) : NO_BEATS),
		[element, isAudible],
	);
	const sources = useMemo(
		() => (isAudible ? getVisibleSourceBeats({ element }) : NO_BEATS),
		[element, isAudible],
	);
	const picked = useBeatSelectionStore(({ selection }) =>
		selection?.elementId === element.id ? selection.ticks : NO_TICKS,
	);

	const positions = useMemo(() => {
		if (offsets.length === 0) {
			return null;
		}
		const toPixels = (time: number) => timelineTimeToPixels({ time, zoomLevel });
		// Zoomed far out: decide from the two ends before touching every beat.
		if (
			isBeatMarkerSpacingTooDense({
				firstPx: toPixels(offsets[0]),
				lastPx: toPixels(offsets[offsets.length - 1]),
				count: offsets.length,
			})
		) {
			return null;
		}
		return offsets.map(toPixels);
	}, [offsets, zoomLevel]);

	const path = useMemo(
		() =>
			positions &&
			getBeatMarkerPath({
				positions,
				top: Math.round((height * 2) / 3),
				bottom: height,
			}),
		[positions, height],
	);
	// The picked ticks are drawn even when the clip as a whole is too dense for the
	// density guard: five picked ticks 2 px apart are still five picked ticks.
	const pickedPath = useMemo(
		() =>
			positions && picked.size > 0
				? buildBeatTickPath({
						positions: positions.filter((_, index) => picked.has(sources[index])),
						top: Math.round(height / 3),
						bottom: height,
					})
				: null,
		[positions, picked, sources, height],
	);
	// Ticks within reach of a trim handle are drawn but not pickable.
	const pickable = useMemo(() => {
		const indexes: number[] = [];
		positions?.forEach((x, index) => {
			if (x >= EDGE_INSET_PX && x <= width - EDGE_INSET_PX) indexes.push(index);
		});
		return {
			indexes,
			positions: indexes.map((index) => positions?.[index] ?? 0),
			path: buildBeatTickPath({
				positions: indexes.map((index) => positions?.[index] ?? 0),
				top: Math.round((height * 2) / 3),
				bottom: height,
			}),
		};
	}, [positions, width, height]);

	if (!path || !positions) {
		return null;
	}

	const handlePick = (event: PointerEvent<SVGPathElement>) => {
		// Only the primary button picks; the right one is handled in handleMouseDown.
		if (event.button !== 0) {
			return;
		}
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) {
			return;
		}
		const nearest = nearestBeatIndex({
			positions: pickable.positions,
			x: event.clientX - svg.getBoundingClientRect().left,
			radius: PICK_RADIUS_PX,
		});
		if (nearest === null) {
			return;
		}
		event.stopPropagation();
		pickBeatOnClip({
			trackId,
			elementId: element.id,
			tick: sources[pickable.indexes[nearest]],
			mode: event.shiftKey
				? "range"
				: event.ctrlKey || event.metaKey
					? "toggle"
					: "replace",
			visible: sources,
		});
	};
	// The compatibility mouse events follow a pointer down: the clip must not see
	// them. The right button is the clip's own: it selects the clip, and the event
	// must keep bubbling so the clip's context menu opens on the clip it names.
	const handleMouseDown = (event: MouseEvent) => {
		if (event.button === MOUSE_BUTTON_RIGHT) {
			onSecondaryMouseDown(event);
			return;
		}
		event.stopPropagation();
	};
	const keepFromClip = (event: MouseEvent) => event.stopPropagation();

	return (
		<svg
			className={cn(
				"pointer-events-none absolute top-0 left-0",
				isDimmed && "opacity-50",
			)}
			width={width}
			height={height}
			shapeRendering="crispEdges"
			aria-hidden="true"
		>
			<path d={path} stroke={TIMELINE_BEAT_MARKER_HALO_COLOR} strokeWidth={4} />
			<path d={path} stroke={TIMELINE_BEAT_MARKER_COLOR} strokeWidth={2} />
			{pickedPath && (
				<>
					<path
						d={pickedPath}
						stroke={TIMELINE_BEAT_MARKER_HALO_COLOR}
						strokeWidth={6}
					/>
					<path
						d={pickedPath}
						stroke={TIMELINE_BEAT_MARKER_PICKED_COLOR}
						strokeWidth={4}
					/>
				</>
			)}
			{pickable.path && (
				<path
					d={pickable.path}
					data-beat-hit-area=""
					fill="none"
					stroke="transparent"
					strokeWidth={PICK_RADIUS_PX * 2}
					style={{ pointerEvents: "stroke", cursor: "pointer" }}
					onPointerDown={handlePick}
					onMouseDown={handleMouseDown}
					onClick={keepFromClip}
				/>
			)}
		</svg>
	);
});
