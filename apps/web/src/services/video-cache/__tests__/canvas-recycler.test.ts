import { describe, expect, test } from "bun:test";
import { CanvasRecycler } from "../canvas-recycler";

type Canvas = { id: number };

function setup({ quarantine = 3, maxFree = 3 }: { quarantine?: number; maxFree?: number } = {}) {
	let created = 0;
	const recycler = new CanvasRecycler<Canvas>({
		create: () => {
			created += 1;
			return { id: created };
		},
		quarantine: () => quarantine,
		maxFree: () => maxFree,
	});
	return { recycler, created: () => created };
}

describe("CanvasRecycler", () => {
	test("one owner drawing frame after frame: three canvases in turn, as the old round robin", () => {
		const { recycler, created } = setup();
		let presented: Canvas | null = null;
		const order: number[] = [];
		for (let draw = 0; draw < 9; draw++) {
			const canvas = recycler.acquire();
			recycler.noteHandOut(canvas);
			if (presented) recycler.release(presented);
			presented = canvas;
			order.push(canvas.id);
		}
		expect(created()).toBe(3);
		expect(order).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);
	});

	test("a canvas is drawn into again only `quarantine` draws after it was last handed out", () => {
		const { recycler } = setup({ quarantine: 3, maxFree: 10 });
		const first = recycler.acquire();
		recycler.noteHandOut(first);
		recycler.release(first);
		// two draws later: still in quarantine
		expect(recycler.acquire()).not.toBe(first);
		expect(recycler.acquire()).not.toBe(first);
		// handed out again in the meantime (a cached frame shown again): the wait starts over
		recycler.noteHandOut(first);
		expect(recycler.acquire()).not.toBe(first);
		expect(recycler.acquire()).not.toBe(first);
		expect(recycler.acquire()).toBe(first);
	});

	test("the quarantine follows the number of streams of the media", () => {
		let quarantine = 3;
		const recycler = new CanvasRecycler<Canvas>({
			create: (() => {
				let id = 0;
				return () => ({ id: ++id });
			})(),
			quarantine: () => quarantine,
			maxFree: () => 10,
		});
		const canvas = recycler.acquire();
		recycler.noteHandOut(canvas);
		recycler.release(canvas);
		quarantine = 6;
		for (let draw = 0; draw < 5; draw++) {
			expect(recycler.acquire()).not.toBe(canvas);
		}
		expect(recycler.acquire()).toBe(canvas);
	});

	test("keeps at most maxFree free canvases and counts the live ones", () => {
		const { recycler } = setup({ quarantine: 1, maxFree: 2 });
		const canvases = [recycler.acquire(), recycler.acquire(), recycler.acquire(), recycler.acquire()];
		expect(recycler.getStats()).toEqual({ live: 4, free: 0, maxFree: 2 });
		for (const canvas of canvases) recycler.release(canvas);
		expect(recycler.getStats()).toEqual({ live: 2, free: 2, maxFree: 2 });
	});

	test("a canvas released twice is kept once", () => {
		const { recycler } = setup({ quarantine: 0, maxFree: 5 });
		const canvas = recycler.acquire();
		recycler.release(canvas);
		recycler.release(canvas);
		expect(recycler.getStats()).toEqual({ live: 1, free: 1, maxFree: 5 });
		expect(recycler.acquire()).toBe(canvas);
		expect(recycler.acquire()).not.toBe(canvas);
	});

	test("clear forgets every free canvas", () => {
		const { recycler } = setup({ quarantine: 0, maxFree: 5 });
		const canvas = recycler.acquire();
		recycler.release(canvas);
		recycler.clear();
		expect(recycler.getStats()).toEqual({ live: 0, free: 0, maxFree: 5 });
		expect(recycler.acquire()).not.toBe(canvas);
	});

	test("recyclers sharing a draw clock count each other's draws (one media, two sizes)", () => {
		const clock = { draws: 0 };
		let id = 0;
		const make = () =>
			new CanvasRecycler<Canvas>({
				create: () => ({ id: ++id }),
				quarantine: () => 3,
				maxFree: () => 10,
				clock,
			});
		const small = make();
		const large = make();
		const canvas = small.acquire();
		small.noteHandOut(canvas);
		small.release(canvas);
		// two draws at the other size: the canvas waited three draws of the media
		large.acquire();
		large.acquire();
		expect(small.acquire()).toBe(canvas);
		expect(clock.draws).toBe(4);
	});

	test("a canvas in its quarantine is never dropped: released into a full free list it waits there", () => {
		const { recycler } = setup({ quarantine: 3, maxFree: 1 });
		const [a, b] = [recycler.acquire(), recycler.acquire()];
		recycler.noteHandOut(a);
		recycler.noteHandOut(b);
		recycler.release(a);
		// the free list is full, but b may still be uploaded
		recycler.release(b);
		expect(recycler.getStats()).toEqual({ live: 2, free: 2, maxFree: 1 });
		recycler.trim();
		expect(recycler.getStats()).toEqual({ live: 2, free: 2, maxFree: 1 });
		// three draws after the hand-out its quarantine is over: trim keeps maxFree of them
		recycler.acquire();
		recycler.acquire();
		recycler.acquire();
		recycler.trim();
		expect(recycler.getStats().free).toBe(1);
	});

	test("trim drops free canvases past their quarantine beyond maxFree, never one in it", () => {
		let maxFree = 3;
		const recycler = new CanvasRecycler<Canvas>({
			create: (() => {
				let id = 0;
				return () => ({ id: ++id });
			})(),
			quarantine: () => 2,
			maxFree: () => maxFree,
		});
		const canvases = [recycler.acquire(), recycler.acquire(), recycler.acquire()];
		recycler.noteHandOut(canvases[2]);
		for (const canvas of canvases) recycler.release(canvas);
		// the size is no longer in use
		maxFree = 0;
		recycler.trim();
		// the one handed out at the last draw waits for its quarantine
		expect(recycler.getStats()).toEqual({ live: 1, free: 1, maxFree: 0 });
	});

	test("free canvases in their quarantine count toward maxFree: an idle one beyond them goes", () => {
		const { recycler } = setup({ quarantine: 3, maxFree: 2 });
		const [idle, a, b] = [recycler.acquire(), recycler.acquire(), recycler.acquire()];
		recycler.noteHandOut(a);
		recycler.noteHandOut(b);
		for (const canvas of [idle, a, b]) recycler.release(canvas);
		expect(recycler.getStats().free).toBe(3);
		recycler.trim();
		expect(recycler.getStats()).toEqual({ live: 2, free: 2, maxFree: 2 });
	});

	test("the newest free canvas past its quarantine is reused first", () => {
		const { recycler } = setup({ quarantine: 1, maxFree: 5 });
		const [a, b] = [recycler.acquire(), recycler.acquire()];
		recycler.release(a);
		recycler.release(b);
		expect(recycler.acquire()).toBe(b);
		expect(recycler.acquire()).toBe(a);
	});

	test("a spare free canvas left unused for maxUnused draws is dropped by trim; the ones in use stay", () => {
		let id = 0;
		const recycler = new CanvasRecycler<Canvas>({
			create: () => ({ id: ++id }),
			quarantine: () => 1,
			maxFree: () => 10,
			maxUnused: () => 4,
		});
		// two canvases in turn would do, a third came back once (two streams drew here)
		const spare = recycler.acquire();
		const turn = recycler.acquire();
		let shown = recycler.acquire();
		recycler.release(spare);
		recycler.release(turn);
		for (let draw = 0; draw < 6; draw++) {
			const next = recycler.acquire();
			recycler.noteHandOut(next);
			recycler.release(shown);
			shown = next;
			recycler.trim();
		}
		expect(recycler.getStats()).toEqual({ live: 2, free: 1, maxFree: 10 });
		expect(recycler.acquire()).not.toBe(spare);
	});
});
