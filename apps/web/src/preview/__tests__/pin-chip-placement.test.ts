import { describe, expect, test } from "bun:test";
import { getCornerPosition, ROTATION_HANDLE_OFFSET, type ElementBounds } from "@/preview/element-bounds";
import { allHandleCentres, CORNERS, EDGES, getRotationHandleCentre, getTransformHandleCentres } from "../handle-layout";
import {
	CHIP_COMPACT_SIZE,
	CHIP_DEFAULT_SIZE,
	HANDLE_CLEARANCE,
	placePinChip,
	visibleChipArea,
	type ChipSize,
	type PinChipPlacement,
	type PlacementArea,
	type Point,
} from "../pin-chip-placement";

/** The preview of a 1440x900 window: 609 x 341 px of canvas. */
const SMALL = { left: 0, top: 0, width: 609, height: 341 };
const ROOMY = { left: 0, top: 0, width: 1200, height: 700 };
const ONE_ROW: ChipSize = { width: 240, height: 40 };
const STUCK_ROWS: ChipSize = { width: 296, height: 70 };
const TALLEST: ChipSize = { width: 320, height: 130 };
const identity = ({ canvasX, canvasY }: { canvasX: number; canvasY: number }) => ({ x: canvasX, y: canvasY });

function bounds({
	cx,
	cy,
	width,
	height,
	rotation = 0,
}: {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation?: number;
}): ElementBounds {
	return { cx, cy, width, height, rotation };
}

/** The corners and every handle of a selection box, as the preview draws them. */
function boxOf(args: Parameters<typeof bounds>[0]) {
	const box = bounds(args);
	const centres = getTransformHandleCentres({ bounds: box, toOverlay: identity });
	return { corners: centres.corners, handles: allHandleCentres({ centres }), centres };
}

function chipRect({ placement, size }: { placement: PinChipPlacement; size: ChipSize }) {
	const used = placement.mode === "compact" ? { width: CHIP_COMPACT_SIZE, height: CHIP_COMPACT_SIZE } : size;
	return { left: placement.left, top: placement.top, width: used.width, height: used.height };
}

function coversPoint({ rect, point, reach }: { rect: ReturnType<typeof chipRect>; point: Point; reach: number }): boolean {
	return (
		point.x + reach > rect.left &&
		point.x - reach < rect.left + rect.width &&
		point.y + reach > rect.top &&
		point.y - reach < rect.top + rect.height
	);
}

/** Inside the area, and not one handle's hit area (half 10 px at the widest) touched. */
function expectClear({
	placement,
	size,
	handles,
	area,
	reach = 10,
}: {
	placement: PinChipPlacement;
	size: ChipSize;
	handles: readonly Point[];
	area: PlacementArea;
	reach?: number;
}) {
	const rect = chipRect({ placement, size });
	expect(rect.left).toBeGreaterThanOrEqual(area.left - 1e-9);
	expect(rect.top).toBeGreaterThanOrEqual(area.top - 1e-9);
	expect(rect.left + rect.width).toBeLessThanOrEqual(area.left + area.width + 1e-9);
	expect(rect.top + rect.height).toBeLessThanOrEqual(area.top + area.height + 1e-9);
	for (const handle of handles) {
		expect(coversPoint({ rect, point: handle, reach })).toBe(false);
	}
}

describe("the geometry the chip keeps clear of", () => {
	test("the rotate handle is 24 px past the middle of the top edge, along the box's own up direction", () => {
		const upright = getRotationHandleCentre({ topCenter: { x: 100, y: 50 }, rotationDeg: 0 });
		expect(upright.x).toBeCloseTo(100, 9);
		expect(upright.y).toBeCloseTo(50 - ROTATION_HANDLE_OFFSET, 9);
		const upsideDown = getRotationHandleCentre({ topCenter: { x: 100, y: 50 }, rotationDeg: 180 });
		expect(upsideDown.x).toBeCloseTo(100, 9);
		expect(upsideDown.y).toBeCloseTo(50 + ROTATION_HANDLE_OFFSET, 9);
		const quarter = getRotationHandleCentre({ topCenter: { x: 100, y: 50 }, rotationDeg: 90 });
		expect(quarter.x).toBeCloseTo(100 + ROTATION_HANDLE_OFFSET, 9);
		expect(quarter.y).toBeCloseTo(50, 9);
	});

	test("an upright box has 4 corners, 3 edge handles (right, left, bottom) and the rotate handle above the top edge", () => {
		const { centres } = boxOf({ cx: 300, cy: 200, width: 200, height: 100 });
		expect(centres.corners).toEqual([
			{ x: 200, y: 150 },
			{ x: 400, y: 150 },
			{ x: 400, y: 250 },
			{ x: 200, y: 250 },
		]);
		expect(centres.edges).toEqual([
			{ x: 400, y: 200 },
			{ x: 200, y: 200 },
			{ x: 300, y: 250 },
		]);
		expect(centres.rotation.x).toBeCloseTo(300, 9);
		expect(centres.rotation.y).toBeCloseTo(150 - ROTATION_HANDLE_OFFSET, 9);
	});

	test("allHandleCentres lists all eight, corners then edges then the rotate handle, and nothing else", () => {
		const { centres } = boxOf({ cx: 300, cy: 200, width: 200, height: 100 });
		const all = allHandleCentres({ centres });
		expect(all.length).toBe(CORNERS.length + EDGES.length + 1);
		expect(all.length).toBe(8);
		expect(all).toEqual([...centres.corners, ...centres.edges, centres.rotation]);
		// the layout's lists are the ones the centres are computed from, one centre each, in order
		expect([...CORNERS]).toEqual(["top-left", "top-right", "bottom-right", "bottom-left"]);
		expect([...EDGES]).toEqual(["right", "left", "bottom"]);
		expect(centres.corners.length).toBe(CORNERS.length);
		expect(centres.edges.length).toBe(EDGES.length);
	});

	test("the corners are the ones the transform handles use, through the canvas-to-overlay mapping", () => {
		const box = bounds({ cx: 300, cy: 200, width: 200, height: 100, rotation: 30 });
		const mapped = getTransformHandleCentres({
			bounds: box,
			toOverlay: ({ canvasX, canvasY }) => ({ x: canvasX * 0.5 + 10, y: canvasY * 0.5 + 20 }),
		});
		const topLeft = getCornerPosition({ bounds: box, corner: "top-left" });
		expect(mapped.corners[0].x).toBeCloseTo(topLeft.x * 0.5 + 10, 9);
		expect(mapped.corners[0].y).toBeCloseTo(topLeft.y * 0.5 + 20, 9);
	});
});

describe("placePinChip (next to the element, never on a handle)", () => {
	test("the unmeasured chip is one row tall and the compact button is a finger-sized target", () => {
		expect(CHIP_DEFAULT_SIZE.height).toBeGreaterThanOrEqual(40);
		expect(CHIP_COMPACT_SIZE).toBeGreaterThanOrEqual(28);
	});

	test("goes below the element, centred on it, past the lowest handle's clearance", () => {
		const { corners, handles } = boxOf({ cx: 400, cy: 150, width: 200, height: 100 });
		const placement = placePinChip({ corners, handles, area: ROOMY, size: ONE_ROW });
		expect(placement.mode).toBe("full");
		expect(placement.left + ONE_ROW.width / 2).toBeCloseTo(400, 9);
		// as near as it can be: resting on the lowest handle's clearance
		expect(placement.top).toBeCloseTo(200 + HANDLE_CLEARANCE, 9);
		expectClear({ placement, size: ONE_ROW, handles, area: ROOMY });
	});

	test("below even for a tall, narrow element whose sides are nearer its middle (the chip hugs the bottom edge)", () => {
		const { corners, handles } = boxOf({ cx: 600, cy: 300, width: 100, height: 400 });
		const placement = placePinChip({ corners, handles, area: ROOMY, size: ONE_ROW });
		expect(placement.mode).toBe("full");
		expect(placement.left + ONE_ROW.width / 2).toBeCloseTo(600, 9);
		expect(placement.top).toBeCloseTo(500 + HANDLE_CLEARANCE, 9);
	});

	test("an element with a roomy inside and room outside: the chip stays off the element", () => {
		const { corners, handles } = boxOf({ cx: 600, cy: 350, width: 600, height: 300 });
		const placement = placePinChip({ corners, handles, area: ROOMY, size: ONE_ROW });
		expect(placement.mode).toBe("full");
		const rect = chipRect({ placement, size: ONE_ROW });
		const overlapsBody = rect.left < 900 && rect.left + rect.width > 300 && rect.top < 500 && rect.top + rect.height > 200;
		expect(overlapsBody).toBe(false);
		expectClear({ placement, size: ONE_ROW, handles, area: ROOMY });
	});

	test("above the element when there is no room below, clear of the rotate handle", () => {
		const { corners, handles, centres } = boxOf({ cx: 600, cy: 640, width: 200, height: 100 });
		const placement = placePinChip({ corners, handles, area: ROOMY, size: STUCK_ROWS });
		expect(placement.mode).toBe("full");
		// resting on the rotate handle's clearance, right above it
		expect(placement.top + STUCK_ROWS.height).toBeCloseTo(centres.rotation.y - HANDLE_CLEARANCE, 9);
		expect(placement.left + STUCK_ROWS.width / 2).toBeCloseTo(600, 9);
		expectClear({ placement, size: STUCK_ROWS, handles, area: ROOMY });
	});

	test("beside the element when it has no room above or below", () => {
		const area = { left: 0, top: 0, width: 900, height: 160 };
		const { corners, handles } = boxOf({ cx: 200, cy: 90, width: 120, height: 80 });
		const placement = placePinChip({ corners, handles, area, size: ONE_ROW });
		expect(placement.mode).toBe("full");
		// resting on the right-hand handles' clearance
		expect(placement.left).toBeCloseTo(260 + HANDLE_CLEARANCE, 9);
		expectClear({ placement, size: ONE_ROW, handles, area });
	});

	test("on the left when the right side is out of the area", () => {
		const area = { left: 0, top: 0, width: 600, height: 160 };
		const { corners, handles } = boxOf({ cx: 520, cy: 90, width: 120, height: 80 });
		const placement = placePinChip({ corners, handles, area, size: ONE_ROW });
		expect(placement.mode).toBe("full");
		// resting against the left-hand handles' clearance
		expect(placement.left + ONE_ROW.width).toBeCloseTo(460 - HANDLE_CLEARANCE, 9);
		expectClear({ placement, size: ONE_ROW, handles, area });
	});

	test("THE WINDOW CASE: a mid-size element in the middle of a 609 x 341 preview, the chip two rows tall: the rotate handle and every corner stay pressable", () => {
		const { corners, handles, centres } = boxOf({ cx: 304.5, cy: 170.5, width: 243, height: 137 });
		const placement = placePinChip({ corners, handles, area: SMALL, size: STUCK_ROWS });
		expect(placement.mode).toBe("full");
		const rect = chipRect({ placement, size: STUCK_ROWS });
		expect(coversPoint({ rect, point: centres.rotation, reach: 10 })).toBe(false);
		for (const corner of centres.corners) expect(coversPoint({ rect, point: corner, reach: 9 })).toBe(false);
		for (const edge of centres.edges) expect(coversPoint({ rect, point: edge, reach: 9 })).toBe(false);
		expectClear({ placement, size: STUCK_ROWS, handles, area: SMALL });
	});

	test("the same element with the tallest chip (progress and notices): still clear, still inside, maybe compact", () => {
		const { corners, handles } = boxOf({ cx: 304.5, cy: 170.5, width: 243, height: 137 });
		const placement = placePinChip({ corners, handles, area: SMALL, size: TALLEST });
		expectClear({ placement, size: TALLEST, handles, area: SMALL });
	});

	test("an element that fills the preview: the chip goes over it, clear of the handles on its outline", () => {
		const { corners, handles } = boxOf({ cx: 304.5, cy: 170.5, width: 609, height: 341 });
		const placement = placePinChip({ corners, handles, area: SMALL, size: ONE_ROW });
		expect(placement.mode).toBe("full");
		expectClear({ placement, size: ONE_ROW, handles, area: SMALL });
	});

	test("an element bigger than the visible area (zoomed in): the chip stays inside the area, clear of the handles that are in view", () => {
		const { corners, handles } = boxOf({ cx: 300, cy: 170, width: 1400, height: 900 });
		const placement = placePinChip({ corners, handles, area: SMALL, size: STUCK_ROWS });
		expect(placement.mode).toBe("full");
		expectClear({ placement, size: STUCK_ROWS, handles, area: SMALL });
	});

	test("an element hanging off the left and the top: the chip stays inside the area", () => {
		const { corners, handles } = boxOf({ cx: 20, cy: 10, width: 300, height: 120 });
		const placement = placePinChip({ corners, handles, area: SMALL, size: ONE_ROW });
		expect(placement.mode).toBe("full");
		expectClear({ placement, size: ONE_ROW, handles, area: SMALL });
	});

	test("an element against the right and bottom edges", () => {
		const { corners, handles } = boxOf({ cx: 560, cy: 310, width: 200, height: 100 });
		const placement = placePinChip({ corners, handles, area: SMALL, size: STUCK_ROWS });
		expect(placement.mode).toBe("full");
		expectClear({ placement, size: STUCK_ROWS, handles, area: SMALL });
	});

	test("upside down (180 degrees) the rotate handle is below the box: the chip clears it", () => {
		const { corners, handles, centres } = boxOf({ cx: 400, cy: 150, width: 200, height: 100, rotation: 180 });
		expect(centres.rotation.y).toBeGreaterThan(200);
		const placement = placePinChip({ corners, handles, area: ROOMY, size: ONE_ROW });
		expectClear({ placement, size: ONE_ROW, handles, area: ROOMY });
	});

	test("turned 45 degrees", () => {
		const { corners, handles } = boxOf({ cx: 400, cy: 300, width: 220, height: 120, rotation: 45 });
		const placement = placePinChip({ corners, handles, area: SMALL, size: STUCK_ROWS });
		expect(placement.mode).toBe("full");
		expectClear({ placement, size: STUCK_ROWS, handles, area: SMALL });
	});

	test("a visible area that is an offset window of a zoomed scene", () => {
		const area = { left: 120, top: 60, width: 500, height: 280 };
		const { corners, handles } = boxOf({ cx: 400, cy: 200, width: 160, height: 90 });
		const placement = placePinChip({ corners, handles, area, size: STUCK_ROWS });
		expect(placement.mode).toBe("full");
		expectClear({ placement, size: STUCK_ROWS, handles, area });
	});

	test("an area narrower than the chip gets the compact button, clear of the handles and inside", () => {
		const area = { left: 0, top: 0, width: 200, height: 300 };
		const { corners, handles } = boxOf({ cx: 100, cy: 120, width: 80, height: 60 });
		const placement = placePinChip({ corners, handles, area, size: ONE_ROW });
		expect(placement.mode).toBe("compact");
		expectClear({ placement, size: ONE_ROW, handles, area });
	});

	test("an area shorter than the chip gets the compact button too", () => {
		const area = { left: 0, top: 0, width: 500, height: 30 };
		const { corners, handles } = boxOf({ cx: 100, cy: 15, width: 40, height: 10 });
		const placement = placePinChip({ corners, handles, area, size: ONE_ROW });
		expect(placement.mode).toBe("compact");
		expect(placement.top).toBeGreaterThanOrEqual(-1e-9);
	});

	test("when handles and their clearances cover the whole area the compact button still stays in view", () => {
		const area = { left: 0, top: 0, width: 60, height: 60 };
		const handles: Point[] = [];
		for (let x = 0; x <= 60; x += 10) for (let y = 0; y <= 60; y += 10) handles.push({ x, y });
		const placement = placePinChip({ corners: [{ x: 0, y: 0 }, { x: 60, y: 60 }], handles, area, size: ONE_ROW });
		expect(placement.mode).toBe("compact");
		const rect = chipRect({ placement, size: ONE_ROW });
		expect(rect.left).toBeGreaterThanOrEqual(0);
		expect(rect.top).toBeGreaterThanOrEqual(0);
		expect(rect.left + rect.width).toBeLessThanOrEqual(60);
		expect(rect.top + rect.height).toBeLessThanOrEqual(60);
	});

	test("without corners (the element is not on screen) the chip rests at the bottom centre", () => {
		const placement = placePinChip({ corners: [], handles: [], area: ROOMY, size: ONE_ROW });
		expect(placement.mode).toBe("full");
		expect(placement.left + ONE_ROW.width / 2).toBeCloseTo(600, 9);
		// a little above the bottom edge, not on it
		expect(placement.top + ONE_ROW.height).toBeLessThan(699);
		expect(placement.top + ONE_ROW.height).toBeGreaterThan(680);
	});

	test("without corners in an area too narrow for the chip: the compact button, inside", () => {
		const area = { left: 10, top: 20, width: 100, height: 200 };
		const placement = placePinChip({ corners: [], handles: [], area, size: ONE_ROW });
		expect(placement.mode).toBe("compact");
		expect(placement.left).toBeGreaterThanOrEqual(10);
		expect(placement.left + CHIP_COMPACT_SIZE).toBeLessThanOrEqual(110);
		expect(placement.top + CHIP_COMPACT_SIZE).toBeLessThanOrEqual(220);
	});

	test("the same input gives the same place", () => {
		const { corners, handles } = boxOf({ cx: 304.5, cy: 170.5, width: 243, height: 137 });
		const first = placePinChip({ corners, handles, area: SMALL, size: STUCK_ROWS });
		const second = placePinChip({ corners, handles, area: SMALL, size: STUCK_ROWS });
		expect(second).toEqual(first);
	});
});

describe("placePinChip, swept over elements, areas and chips (the chip is never on a handle, always inside)", () => {
	const AREAS: PlacementArea[] = [
		SMALL,
		ROOMY,
		{ left: 0, top: 0, width: 320, height: 180 },
		{ left: 90, top: 40, width: 420, height: 260 },
	];
	const SIZES = [
		{ width: 120, height: 60 },
		{ width: 360, height: 90 },
		{ width: 700, height: 120 },
		{ width: 1400, height: 900 },
	];
	const CHIPS: ChipSize[] = [ONE_ROW, STUCK_ROWS, TALLEST];
	const ROTATIONS = [0, 30, 90, 180, 300];

	/** Is there any CHIP_COMPACT_SIZE square inside the area clear of every handle's hit area? (1 px grid) */
	function compactSpotExists({ area, handles }: { area: PlacementArea; handles: readonly Point[] }): boolean {
		for (let top = area.top; top + CHIP_COMPACT_SIZE <= area.top + area.height; top += 1) {
			for (let left = area.left; left + CHIP_COMPACT_SIZE <= area.left + area.width; left += 1) {
				const rect = { left, top, width: CHIP_COMPACT_SIZE, height: CHIP_COMPACT_SIZE };
				if (!handles.some((handle) => coversPoint({ rect, point: handle, reach: 10 }))) return true;
			}
		}
		return false;
	}

	test("for every combination: inside the area, and clear of every handle unless truly nothing is", () => {
		let combinations = 0;
		let compact = 0;
		for (const area of AREAS) {
			for (const rotation of ROTATIONS) {
				for (const size of SIZES) {
					for (const fx of [0, 0.5, 1]) {
						for (const fy of [0, 0.5, 1]) {
							const { corners, handles } = boxOf({
								cx: area.left + area.width * fx,
								cy: area.top + area.height * fy,
								width: size.width,
								height: size.height,
								rotation,
							});
							for (const chip of CHIPS) {
								const placement = placePinChip({ corners, handles, area, size: chip });
								combinations++;
								if (placement.mode === "compact") compact++;
								const rect = chipRect({ placement, size: chip });
								expect(rect.left).toBeGreaterThanOrEqual(area.left - 1e-9);
								expect(rect.top).toBeGreaterThanOrEqual(area.top - 1e-9);
								expect(rect.left + rect.width).toBeLessThanOrEqual(area.left + area.width + 1e-9);
								expect(rect.top + rect.height).toBeLessThanOrEqual(area.top + area.height + 1e-9);
								const onHandle = handles.some((handle) => coversPoint({ rect, point: handle, reach: 10 }));
								if (onHandle) {
									// the last resort: only when a brute-force search finds no free square for even the compact button
									expect(placement.mode).toBe("compact");
									expect(compactSpotExists({ area, handles })).toBe(false);
								}
								if (placement.mode === "full") expect(chip.width <= area.width && chip.height <= area.height).toBe(true);
							}
						}
					}
				}
			}
		}
		expect(combinations).toBe(AREAS.length * ROTATIONS.length * SIZES.length * 9 * CHIPS.length);
		// not everything collapses: the roomy cases keep the full chip
		expect(compact).toBeLessThan(combinations / 2);
	});

	test("with room on a side of the element the full chip is used (never compact just because the spot is not below)", () => {
		for (const rotation of ROTATIONS) {
			for (const fx of [0.25, 0.5, 0.75]) {
				const { corners, handles } = boxOf({ cx: 1200 * fx, cy: 350, width: 220, height: 120, rotation });
				for (const chip of CHIPS) {
					expect(placePinChip({ corners, handles, area: ROOMY, size: chip }).mode).toBe("full");
				}
			}
		}
	});
});

describe("visibleChipArea (zoomed in, the scene is bigger than the viewport that clips the chip)", () => {
	const VIEWPORT = { width: 800, height: 450 };

	test("at fit the scene lies inside the viewport and is the area", () => {
		const scene = { left: 40, top: 0, width: 720, height: 405 };
		expect(visibleChipArea({ scene, viewport: VIEWPORT })).toEqual(scene);
	});

	test("zoomed in, the area is the scene cut to the viewport", () => {
		const scene = { left: -400, top: -225, width: 1600, height: 900 };
		expect(visibleChipArea({ scene, viewport: VIEWPORT })).toEqual({ left: 0, top: 0, width: 800, height: 450 });
	});

	test("zoomed and panned, only the overlap counts", () => {
		const scene = { left: 200, top: -300, width: 1600, height: 900 };
		expect(visibleChipArea({ scene, viewport: VIEWPORT })).toEqual({ left: 200, top: 0, width: 600, height: 450 });
	});

	test("a chip placed for an element near the scene's bottom stays inside the viewport when zoomed", () => {
		const scene = { left: -400, top: -225, width: 1600, height: 900 };
		const area = visibleChipArea({ scene, viewport: VIEWPORT });
		const { corners, handles } = boxOf({ cx: 400, cy: 340, width: 200, height: 80 });
		const placement = placePinChip({ corners, handles, area, size: STUCK_ROWS });
		expectClear({ placement, size: STUCK_ROWS, handles, area: { left: 0, top: 0, ...VIEWPORT } });
	});

	test("an unmeasured viewport (0 x 0) leaves the scene as it is", () => {
		const scene = { left: -400, top: -225, width: 1600, height: 900 };
		expect(visibleChipArea({ scene, viewport: { width: 0, height: 0 } })).toEqual(scene);
	});
});
