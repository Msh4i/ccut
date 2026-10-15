import { describe, expect, test } from "bun:test";
import { MIN_ACTIVE_SCALES, ScaledCanvasPools } from "../scaled-canvases";

type Canvas = { id: number; scale: number };

function setup({
	quarantine = 0,
	maxFree = 3,
	maxActiveScales,
}: {
	quarantine?: number;
	maxFree?: number;
	maxActiveScales?: number;
} = {}) {
	const created: Canvas[] = [];
	const pools = new ScaledCanvasPools<Canvas>({
		create: ({ scale }) => {
			const canvas = { id: created.length + 1, scale };
			created.push(canvas);
			return canvas;
		},
		quarantine: () => quarantine,
		maxFree: () => maxFree,
		...(maxActiveScales !== undefined && { maxActiveScales: () => maxActiveScales }),
	});
	return { pools, created };
}

/**
 * `sizes` drawn in turn for `rounds` rounds, each size like one stream: its
 * new frame handed out, its previous one released. Returns the canvases made.
 */
function drawInTurn({
	pools,
	created,
	sizes,
	rounds,
}: ReturnType<typeof setup> & { sizes: number[]; rounds: number }): number {
	const shown = new Map<number, Canvas>();
	for (let round = 0; round < rounds; round++) {
		for (const scale of sizes) {
			const canvas = pools.acquire({ scale });
			pools.noteHandOut({ canvas, scale });
			const previous = shown.get(scale);
			if (previous) pools.release({ canvas: previous, scale });
			shown.set(scale, canvas);
		}
	}
	return created.length;
}

describe("ScaledCanvasPools", () => {
	test("a canvas is made at the scale asked for and comes back for that scale only", () => {
		const { pools, created } = setup();
		const small = pools.acquire({ scale: 0.25 });
		pools.release({ canvas: small, scale: 0.25 });
		const full = pools.acquire({ scale: 1 });
		expect(full).not.toBe(small);
		expect(full.scale).toBe(1);
		expect(pools.acquire({ scale: 0.25 })).toBe(small);
		expect(created).toHaveLength(2);
	});

	test("the quarantine of a canvas counts the draws of the media at its own size", () => {
		const { pools } = setup({ quarantine: 2 });
		const first = pools.acquire({ scale: 0.5 });
		pools.noteHandOut({ canvas: first, scale: 0.5 });
		pools.release({ canvas: first, scale: 0.5 });
		// one more draw at this size is still inside the quarantine
		const second = pools.acquire({ scale: 0.5 });
		expect(second).not.toBe(first);
		pools.noteHandOut({ canvas: second, scale: 0.5 });
		pools.release({ canvas: second, scale: 0.5 });
		// the next draw: the first is past its quarantine, the second is not
		expect(pools.acquire({ scale: 0.5 })).toBe(first);
	});

	test("... and at every other size: the quarantine is a number of the media's draws", () => {
		// a render asks for every layer of the media before it uploads them,
		// whatever their sizes: draws at other sizes are draws of that render too
		const { pools } = setup({ quarantine: 3, maxActiveScales: 3 });
		const first = pools.acquire({ scale: 0.5 });
		pools.noteHandOut({ canvas: first, scale: 0.5 });
		pools.release({ canvas: first, scale: 0.5 });
		pools.acquire({ scale: 1 });
		pools.acquire({ scale: 0.25 });
		expect(pools.acquire({ scale: 0.5 })).toBe(first);
	});

	test("a size pushed out of the room keeps no free canvas past its quarantine; one in it waits", () => {
		// room for two sizes (the default), a quarantine of 5 draws
		const { pools } = setup({ quarantine: 5 });
		const shown = pools.acquire({ scale: 1 });
		pools.noteHandOut({ canvas: shown, scale: 1 });
		const spare = pools.acquire({ scale: 1 });
		pools.release({ canvas: spare, scale: 1 });
		pools.release({ canvas: shown, scale: 1 });
		const half = pools.acquire({ scale: 0.5 });
		// a third size pushes size 1 out: the spare goes, the canvas shown may still be uploaded
		const quarter = pools.acquire({ scale: 0.25 });
		expect(pools.getStats()).toEqual({ live: 3, free: 1 });
		// two draws later (five after its hand-out) it goes too
		pools.release({ canvas: quarter, scale: 0.25 });
		pools.release({ canvas: half, scale: 0.5 });
		const again = pools.acquire({ scale: 0.25 });
		expect(pools.getStats()).toEqual({ live: 3, free: 2 });
		pools.release({ canvas: again, scale: 0.25 });
		pools.acquire({ scale: 0.25 });
		expect(pools.getStats()).toEqual({ live: 2, free: 1 });
	});

	test("a size not drawn for twice the quarantine leaves: its free canvases go, the size drawn keeps its own", () => {
		// a quarantine of 2 draws: a size not drawn for more than 4 draws leaves
		const { pools } = setup({ quarantine: 2, maxActiveScales: 8 });
		const big = pools.acquire({ scale: 1 });
		pools.release({ canvas: big, scale: 1 });
		let shown = pools.acquire({ scale: 0.25 });
		for (let draw = 0; draw < 3; draw++) {
			const next = pools.acquire({ scale: 0.25 });
			pools.release({ canvas: shown, scale: 0.25 });
			shown = next;
		}
		// four draws after its last one, size 1 still keeps its free canvas
		expect(pools.getStats()).toEqual({ live: 3, free: 2 });
		// and the frame cache leaves room for the free canvases of both sizes
		expect(pools.reservedFreeBytes({ fullBytes: 1024 })).toBe(3 * (1 + 0.0625) * 1024);
		const next = pools.acquire({ scale: 0.25 });
		pools.release({ canvas: shown, scale: 0.25 });
		// five: it left, and nothing is reserved for it any more
		expect(pools.getStats()).toEqual({ live: 2, free: 1 });
		expect(pools.reservedFreeBytes({ fullBytes: 1024 })).toBe(3 * 0.0625 * 1024);
		expect(next.scale).toBe(0.25);
	});

	test("a size beyond the room keeps no free canvases (no quarantine)", () => {
		const { pools } = setup();
		const sizes = [1, 0.5, 0.25];
		expect(MIN_ACTIVE_SCALES).toBe(2);
		const first = pools.acquire({ scale: sizes[0] });
		pools.release({ canvas: first, scale: sizes[0] });
		expect(pools.getStats().free).toBe(1);
		const second = pools.acquire({ scale: sizes[1] });
		pools.release({ canvas: second, scale: sizes[1] });
		expect(pools.getStats().free).toBe(2);
		// a third size pushes the oldest one out: its free canvas is dropped
		const third = pools.acquire({ scale: sizes[2] });
		expect(pools.getStats()).toEqual({ live: 2, free: 1 });
		pools.release({ canvas: third, scale: sizes[2] });
		expect(pools.getStats()).toEqual({ live: 2, free: 2 });
	});

	test("a canvas of a size that left use is dropped when its owner lets go of it", () => {
		const { pools } = setup();
		const kept = pools.acquire({ scale: 1 });
		pools.acquire({ scale: 0.5 });
		pools.acquire({ scale: 0.25 });
		expect(pools.getStats().live).toBe(3);
		pools.release({ canvas: kept, scale: 1 });
		expect(pools.getStats()).toEqual({ live: 2, free: 0 });
	});

	test("a canvas released to a size the pools do not know is ignored", () => {
		const { pools } = setup();
		const stranger = { id: 99, scale: 0.7 };
		pools.release({ canvas: stranger, scale: 0.7 });
		pools.noteHandOut({ canvas: stranger, scale: 0.7 });
		expect(pools.getStats()).toEqual({ live: 0, free: 0 });
	});

	test("live and reserved bytes follow the size of each canvas", () => {
		const { pools } = setup({ maxFree: 2 });
		pools.acquire({ scale: 1 });
		pools.acquire({ scale: 0.5 });
		pools.acquire({ scale: 0.5 });
		// 1 canvas at full size + 2 at a quarter of the area
		expect(pools.liveBytes({ fullBytes: 1000 })).toBe(1000 + 2 * 250);
		// free canvases that may be kept: 2 per size in use
		expect(pools.reservedFreeBytes({ fullBytes: 1000 })).toBe(2 * 1000 + 2 * 250);
	});

	test("clear drops every free canvas of every size", () => {
		const { pools } = setup();
		const a = pools.acquire({ scale: 1 });
		const b = pools.acquire({ scale: 0.5 });
		pools.release({ canvas: a, scale: 1 });
		pools.release({ canvas: b, scale: 0.5 });
		pools.clear();
		expect(pools.getStats()).toEqual({ live: 0, free: 0 });
	});

	test("three sizes in turn with room for two: a size pushed out keeps its canvases in quarantine and comes back to them", () => {
		// before: every draw made a canvas (150), the pushed-out size dropped them all
		const made = drawInTurn({ ...setup({ quarantine: 9, maxFree: 10 }), sizes: [0.25, 0.5, 1], rounds: 50 });
		expect(made).toBeLessThanOrEqual(3 * 11);
	});

	test("with room for as many sizes as are drawn, their canvases are reused", () => {
		const made = drawInTurn({
			...setup({ quarantine: 9, maxFree: 10, maxActiveScales: 3 }),
			sizes: [0.25, 0.5, 1],
			rounds: 50,
		});
		// each size cycles through the canvases its quarantine needs, then reuses them
		expect(made).toBeLessThanOrEqual(3 * 11);
	});

	test("the room is bounded below by MIN_ACTIVE_SCALES, also for an unusable answer", () => {
		for (const maxActiveScales of [0, 1, Number.NaN, -3]) {
			const { pools } = setup({ maxActiveScales });
			const first = pools.acquire({ scale: 1 });
			pools.release({ canvas: first, scale: 1 });
			const second = pools.acquire({ scale: 0.5 });
			pools.release({ canvas: second, scale: 0.5 });
			expect(pools.getStats()).toEqual({ live: 2, free: 2 });
			// a third size pushes the oldest one out
			pools.acquire({ scale: 0.25 });
			expect(pools.getStats()).toEqual({ live: 2, free: 1 });
		}
	});

	test("free canvases are kept for at most maxActiveScales sizes", () => {
		const { pools } = setup({ maxActiveScales: 3 });
		for (const scale of [1, 0.5, 0.25, 0.125]) {
			pools.release({ canvas: pools.acquire({ scale }), scale });
		}
		// the fourth size pushed the first one out: three free canvases are kept
		expect(pools.getStats()).toEqual({ live: 3, free: 3 });
		expect(pools.reservedFreeBytes({ fullBytes: 1024 })).toBe(3 * (0.25 + 0.0625 + 0.015625) * 1024);
	});
});
