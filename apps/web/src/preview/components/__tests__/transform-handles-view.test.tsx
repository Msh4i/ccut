/**
 * LOW-1 of the review: the pin chip keeps clear of "every transform handle",
 * but its list of handle centres (handle-layout.ts) and the handles the
 * selection box draws (transform-handles.tsx) were written twice, down to the
 * edge list and the top-centre arithmetic. The chip's forbidden squares must
 * be the drawn handles, so both read the same layout, and this test holds the
 * two to each other on the markup the selection box really renders.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ElementBounds } from "@/preview/element-bounds";
import { allHandleCentres, CORNERS, EDGES, getTransformHandleCentres } from "../../handle-layout";
import { HANDLE_HIT_AREA_SIZE, ICON_HANDLE_RADIUS } from "../handle-primitives";
import { TransformHandlesView } from "../transform-handles-view";

interface Point {
	x: number;
	y: number;
}

const noop = () => {};
const identity = ({ canvasX, canvasY }: { canvasX: number; canvasY: number }): Point => ({ x: canvasX, y: canvasY });
/** A mapping that is not the identity, so a handle that skipped it would show. */
const mapped = ({ canvasX, canvasY }: { canvasX: number; canvasY: number }): Point => ({
	x: canvasX * 0.5 + 10,
	y: canvasY * 0.5 + 20,
});

function viewOf({ bounds, toOverlay }: { bounds: ElementBounds; toOverlay: typeof identity }): string {
	return renderToStaticMarkup(
		<TransformHandlesView
			bounds={bounds}
			toOverlay={toOverlay}
			displayScale={{ x: 0.5, y: 0.5 }}
			onCornerPointerDown={noop}
			onEdgePointerDown={noop}
			onRotationPointerDown={noop}
			onPointerMove={noop}
			onPointerUp={noop}
		/>,
	);
}

/** The centre of every handle <button> in the markup: its box is `left/top` and `width/height` px. */
function drawnHandleCentres({ markup }: { markup: string }): Point[] {
	const centres: Point[] = [];
	for (const match of markup.matchAll(/<button[^>]*style="([^"]*)"/g)) {
		const style = match[1];
		const number = (name: string) => {
			const found = new RegExp(`(?:^|;)${name}:(-?[\\d.e+-]+)px`).exec(style);
			if (!found) throw new Error(`a handle without ${name}: ${style}`);
			return Number(found[1]);
		};
		centres.push({ x: number("left") + number("width") / 2, y: number("top") + number("height") / 2 });
	}
	return centres;
}

function sameSet({ drawn, wanted }: { drawn: Point[]; wanted: Point[] }) {
	expect(drawn.length).toBe(wanted.length);
	const sortedDrawn = [...drawn].sort((a, b) => a.x - b.x || a.y - b.y);
	const sortedWanted = [...wanted].sort((a, b) => a.x - b.x || a.y - b.y);
	sortedWanted.forEach((point, index) => {
		expect(sortedDrawn[index].x).toBeCloseTo(point.x, 6);
		expect(sortedDrawn[index].y).toBeCloseTo(point.y, 6);
	});
}

const BOXES: Array<{ name: string; bounds: ElementBounds }> = [
	{ name: "upright", bounds: { cx: 300, cy: 200, width: 200, height: 100, rotation: 0 } },
	{ name: "turned 30 degrees", bounds: { cx: 300, cy: 200, width: 200, height: 100, rotation: 30 } },
	{ name: "turned upside down", bounds: { cx: 120, cy: 90, width: 80, height: 40, rotation: 180 } },
	{ name: "turned 77.5 degrees, tall", bounds: { cx: 510.25, cy: 33.5, width: 60, height: 240, rotation: 77.5 } },
];

describe("the handles the selection box draws are the handles the pin chip keeps clear of", () => {
	for (const { name, bounds } of BOXES) {
		for (const [mappingName, toOverlay] of [["identity", identity], ["scaled and shifted", mapped]] as const) {
			test(`${name} box, ${mappingName} mapping: the drawn set equals allHandleCentres`, () => {
				const centres = getTransformHandleCentres({ bounds, toOverlay });
				sameSet({
					drawn: drawnHandleCentres({ markup: viewOf({ bounds, toOverlay }) }),
					wanted: allHandleCentres({ centres }),
				});
			});
		}
	}

	test("eight handles: 4 corners, 3 edges (right, left, bottom) and the rotate handle", () => {
		const { bounds } = BOXES[0];
		const drawn = drawnHandleCentres({ markup: viewOf({ bounds, toOverlay: identity }) });
		expect(drawn.length).toBe(8);
		expect(CORNERS.length).toBe(4);
		// There is no handle on the top edge: the rotate handle stands there. That is
		// intentional, so the chip has no forbidden square for it either.
		expect([...EDGES]).toEqual(["right", "left", "bottom"]);
		expect(allHandleCentres({ centres: getTransformHandleCentres({ bounds, toOverlay: identity }) }).length).toBe(8);
		const topMiddle = { x: bounds.cx, y: bounds.cy - bounds.height / 2 };
		expect(drawn.some((point) => Math.hypot(point.x - topMiddle.x, point.y - topMiddle.y) < 1)).toBe(false);
	});

	test("seven handles have an 18 px hit area and the rotate icon a 20 px one", () => {
		const markup = viewOf({ bounds: BOXES[0].bounds, toOverlay: identity });
		const widths = [...markup.matchAll(/<button[^>]*style="[^"]*width:(\d+)px/g)].map((match) => Number(match[1]));
		expect(widths.filter((width) => width === HANDLE_HIT_AREA_SIZE).length).toBe(7);
		expect(widths.filter((width) => width === ICON_HANDLE_RADIUS * 2).length).toBe(1);
	});
});
