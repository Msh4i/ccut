/** The compact chip is one round button this many px on a side. */
export const CHIP_COMPACT_SIZE = 32;
/**
 * Half the side of the square the chip keeps out of around every transform
 * handle's centre: the biggest hit area (the rotate handle's) is 20 px wide,
 * plus a little air so a press never lands on the chip's edge.
 */
export const HANDLE_CLEARANCE = 14;
/** Distance from the area's bottom edge of a chip that has no element to sit next to. */
const REST_MARGIN = 8;
const EPSILON = 1e-9;

export interface Point {
	x: number;
	y: number;
}

export interface ChipSize {
	width: number;
	height: number;
}

export interface PlacementArea {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface PinChipPlacement {
	/** The chip's top-left corner, overlay px. */
	left: number;
	top: number;
	/**
	 * `full`: the whole chip. `compact`: a single button of {@link CHIP_COMPACT_SIZE}
	 * px, for when the full chip has no spot that keeps clear of the handles.
	 */
	mode: "full" | "compact";
}

interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The chip before it has been measured: one row of buttons. */
export const CHIP_DEFAULT_SIZE: ChipSize = { width: 240, height: 40 };
const COMPACT: ChipSize = { width: CHIP_COMPACT_SIZE, height: CHIP_COMPACT_SIZE };

/**
 * The part of the scene the user sees: zoomed in, the scene is larger than the
 * viewport, whose layer clips what lies outside it. Without a viewport size
 * (not measured yet) or when they do not overlap, the scene is used as it is.
 */
export function visibleChipArea({
	scene,
	viewport,
}: {
	scene: PlacementArea;
	viewport: { width: number; height: number };
}): PlacementArea {
	if (!(viewport.width > 0 && viewport.height > 0)) return scene;
	const left = Math.max(scene.left, 0);
	const top = Math.max(scene.top, 0);
	const right = Math.min(scene.left + scene.width, viewport.width);
	const bottom = Math.min(scene.top + scene.height, viewport.height);
	if (right <= left || bottom <= top) return scene;
	return { left, top, width: right - left, height: bottom - top };
}

function overlaps({ a, b }: { a: Rect; b: Rect }): boolean {
	return (
		a.left < b.left + b.width - EPSILON &&
		b.left < a.left + a.width - EPSILON &&
		a.top < b.top + b.height - EPSILON &&
		b.top < a.top + a.height - EPSILON
	);
}

function clamp({ value, min, max }: { value: number; min: number; max: number }): number {
	return max < min ? min : Math.min(max, Math.max(min, value));
}

function boundsOf({ points }: { points: readonly Point[] }): Rect {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const left = Math.min(...xs);
	const top = Math.min(...ys);
	return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** The square a chip must stay out of around one handle. */
function zoneOf({ handle }: { handle: Point }): Rect {
	return {
		left: handle.x - HANDLE_CLEARANCE,
		top: handle.y - HANDLE_CLEARANCE,
		width: 2 * HANDLE_CLEARANCE,
		height: 2 * HANDLE_CLEARANCE,
	};
}

/**
 * The best spot for a chip of `size`: free of every handle's square and inside
 * the area, outside the element's own box if any such spot exists, nearest to
 * the middle of the element's bottom edge. `null` when no spot is free.
 *
 * Exact, not a grid search: a free spot can always be slid left, then up,
 * until it rests against the area or a square, so the spots resting there (plus
 * a few that centre the chip on the element) are all that have to be tried.
 */
function findSpot({
	size,
	body,
	zones,
	area,
}: {
	size: ChipSize;
	body: Rect;
	zones: readonly Rect[];
	area: PlacementArea;
}): Rect | null {
	if (size.width > area.width + EPSILON || size.height > area.height + EPSILON) return null;
	const maxLeft = area.left + area.width - size.width;
	const maxTop = area.top + area.height - size.height;
	const centreX = body.left + body.width / 2;
	const centreY = body.top + body.height / 2;
	const lefts = new Set<number>([
		area.left,
		maxLeft,
		clamp({ value: centreX - size.width / 2, min: area.left, max: maxLeft }),
		body.left + body.width,
		body.left - size.width,
	]);
	const tops = new Set<number>([
		area.top,
		maxTop,
		clamp({ value: centreY - size.height / 2, min: area.top, max: maxTop }),
		body.top + body.height,
		body.top - size.height,
	]);
	for (const zone of zones) {
		lefts.add(zone.left + zone.width);
		lefts.add(zone.left - size.width);
		tops.add(zone.top + zone.height);
		tops.add(zone.top - size.height);
	}

	const anchor = { x: centreX, y: body.top + body.height };
	let outside: Rect | null = null;
	let outsideDistance = Infinity;
	let over: Rect | null = null;
	let overDistance = Infinity;
	for (const top of [...tops].sort((a, b) => a - b)) {
		if (top < area.top - EPSILON || top > maxTop + EPSILON) continue;
		for (const left of [...lefts].sort((a, b) => a - b)) {
			if (left < area.left - EPSILON || left > maxLeft + EPSILON) continue;
			const rect: Rect = { left, top, ...size };
			if (zones.some((zone) => overlaps({ a: rect, b: zone }))) continue;
			const distance = Math.hypot(left + size.width / 2 - anchor.x, top + size.height / 2 - anchor.y);
			if (overlaps({ a: rect, b: body })) {
				if (distance < overDistance) {
					over = rect;
					overDistance = distance;
				}
			} else if (distance < outsideDistance) {
				outside = rect;
				outsideDistance = distance;
			}
		}
	}
	return outside ?? over;
}

/**
 * Where the pin chip goes for an element with these `corners` and `handles`
 * (every transform handle's centre, overlay px): next to the element and never
 * on a handle, so every handle can be pressed with the chip showing. The chip
 * is `size` (measured; its width and height as it is now) and held inside
 * `area`. When the full chip has no spot that keeps clear of the handles (a
 * tiny preview, an element filling it), the answer is the `compact` button
 * instead, placed the same way. Without corners (the element is not on screen
 * at the playhead) the chip rests at the bottom centre.
 */
export function placePinChip({
	corners,
	handles,
	area,
	size,
}: {
	corners: readonly Point[];
	handles: readonly Point[];
	area: PlacementArea;
	size: ChipSize;
}): PinChipPlacement {
	const areaCentre = area.left + area.width / 2;
	const areaBottom = area.top + area.height;
	if (corners.length === 0) {
		const fits = size.width <= area.width + EPSILON && size.height <= area.height + EPSILON;
		const used = fits ? size : COMPACT;
		return {
			left: clamp({ value: areaCentre - used.width / 2, min: area.left, max: area.left + area.width - used.width }),
			top: clamp({ value: areaBottom - REST_MARGIN - used.height, min: area.top, max: areaBottom - used.height }),
			mode: fits ? "full" : "compact",
		};
	}

	const body = boundsOf({ points: corners });
	const zones = handles.map((handle) => zoneOf({ handle }));
	const full = findSpot({ size, body, zones, area });
	if (full) return { left: full.left, top: full.top, mode: "full" };
	const compact = findSpot({ size: COMPACT, body, zones, area });
	if (compact) return { left: compact.left, top: compact.top, mode: "compact" };
	// Handles and clearances cover the whole area: nothing is clear, keep the button in view.
	return {
		left: clamp({ value: area.left + area.width - COMPACT.width - REST_MARGIN, min: area.left, max: area.left + area.width - COMPACT.width }),
		top: clamp({ value: areaBottom - COMPACT.height - REST_MARGIN, min: area.top, max: areaBottom - COMPACT.height }),
		mode: "compact",
	};
}
