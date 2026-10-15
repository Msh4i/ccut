import { describe, expect, test } from "bun:test";
import { CanvasRecycler } from "../canvas-recycler";
import { shrinkCanvas } from "../mediabunny-source";
import { ScaledCanvasPools } from "../scaled-canvases";
import { VideoCache } from "../service";
import { type FakeCanvas, createFakeVideo, settle } from "./fake-video";

// A canvas the pools let go of is destroyed (its backing freed) at once
// instead of waiting for the garbage collector, but never while a render may
// still upload it: only once its quarantine is over.

type Canvas = { id: number };

function setup({ quarantine = 3, maxFree = 0, maxUnused }: { quarantine?: number; maxFree?: number; maxUnused?: number } = {}) {
	let created = 0;
	const destroyed: number[] = [];
	const recycler = new CanvasRecycler<Canvas>({
		create: () => {
			created += 1;
			return { id: created };
		},
		quarantine: () => quarantine,
		maxFree: () => maxFree,
		...(maxUnused !== undefined && { maxUnused: () => maxUnused }),
		destroy: (canvas) => {
			destroyed.push(canvas.id);
		},
	});
	return { recycler, destroyed };
}

describe("CanvasRecycler: destroying canvases it lets go of", () => {
	test("a canvas dropped past its quarantine is destroyed at once, and only once", () => {
		const { recycler, destroyed } = setup({ quarantine: 2, maxFree: 0 });
		const first = recycler.acquire();
		recycler.noteHandOut(first);
		recycler.acquire();
		recycler.acquire();
		recycler.release(first);
		expect(destroyed).toEqual([first.id]);
		recycler.release(first);
		recycler.clear();
		expect(destroyed).toEqual([first.id]);
	});

	test("a canvas still in its quarantine when the media is cleared is destroyed once its quarantine is over, and never handed out again", () => {
		const { recycler, destroyed } = setup({ quarantine: 3, maxFree: 5 });
		const shown = recycler.acquire();
		recycler.noteHandOut(shown);
		recycler.release(shown);
		recycler.clear();
		expect(destroyed).toEqual([]);
		expect(recycler.getStats().live).toBe(1);
		const later: Canvas[] = [];
		// Handed out at draw 1: its quarantine of 3 is over at draw 4.
		const destroyedAfter: number[][] = [];
		for (let draw = 0; draw < 3; draw++) {
			later.push(recycler.acquire());
			destroyedAfter.push([...destroyed]);
		}
		expect(later.map((canvas) => canvas.id)).not.toContain(shown.id);
		expect(destroyedAfter).toEqual([[], [], [shown.id]]);
		for (let draw = 0; draw < 3; draw++) recycler.acquire();
		expect(destroyed).toEqual([shown.id]);
	});

	test("trim destroys the free canvases it drops", () => {
		const { recycler, destroyed } = setup({ quarantine: 1, maxFree: 1, maxUnused: 2 });
		const a = recycler.acquire();
		const b = recycler.acquire();
		recycler.release(a);
		recycler.release(b);
		// b goes over maxFree: dropped at once (past its quarantine, never handed out)
		expect(destroyed).toEqual([b.id]);
		for (let draw = 0; draw < 4; draw++) recycler.release(recycler.acquire());
		recycler.trim();
		expect(new Set(destroyed).size).toBe(destroyed.length);
	});
});

describe("ScaledCanvasPools: a size left behind", () => {
	test("destroys its free canvases once their quarantine is over", () => {
		const destroyed: string[] = [];
		let created = 0;
		const pools = new ScaledCanvasPools<{ id: string }>({
			create: ({ scale }) => {
				created += 1;
				return { id: `${scale}:${created}` };
			},
			quarantine: () => 2,
			maxFree: () => 2,
			destroy: (canvas) => {
				destroyed.push(canvas.id);
			},
		});
		const big = pools.acquire({ scale: 1 });
		pools.noteHandOut({ canvas: big, scale: 1 });
		pools.release({ canvas: big, scale: 1 });
		expect(destroyed).toEqual([]);
		// Only small frames from now on: the size 1 leaves after 2 x 2 draws.
		for (let draw = 0; draw < 8; draw++) {
			const small = pools.acquire({ scale: 0.25 });
			pools.release({ canvas: small, scale: 0.25 });
		}
		expect(destroyed).toContain(big.id);
		expect(destroyed.filter((id) => id === big.id)).toHaveLength(1);
	});
});

describe("ScaledCanvasPools: a size cleared while its canvas is in quarantine", () => {
	test("the canvas is destroyed by the draws at another size once its quarantine is over", () => {
		const destroyed: string[] = [];
		let created = 0;
		const pools = new ScaledCanvasPools<{ id: string }>({
			create: ({ scale }) => {
				created += 1;
				return { id: `${scale}:${created}` };
			},
			quarantine: () => 3,
			maxFree: () => 2,
			destroy: (canvas) => {
				destroyed.push(canvas.id);
			},
		});
		const big = pools.acquire({ scale: 1 });
		pools.noteHandOut({ canvas: big, scale: 1 });
		pools.release({ canvas: big, scale: 1 });
		pools.clear();
		const destroyedAfter: string[][] = [];
		for (let draw = 0; draw < 4; draw++) {
			pools.acquire({ scale: 0.25 });
			destroyedAfter.push(destroyed.filter((id) => id === big.id));
		}
		expect(destroyedAfter).toEqual([[], [], [big.id], [big.id]]);
	});
});

describe("mediabunny source: destroying a canvas", () => {
	test("shrinkCanvas sets width and height to 0 (Chromium frees the backing)", () => {
		const canvas = { width: 1920, height: 1080 };
		shrinkCanvas({ canvas });
		expect(canvas).toEqual({ width: 0, height: 0 });
	});
});

describe("VideoCache: destroyed canvases", () => {
	test("five clips of one 4K file: dropped canvases are destroyed, never one a render still holds, never twice", async () => {
		const video = createFakeVideo({
			fps: 30,
			frameCount: 3000,
			frameBytes: { decoded: 3840 * 2160 * 1.5, drawn: 3840 * 2160 * 4 },
		});
		const clock = { now: 0 };
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => clock.now });
		const file = new File([], "m1");
		for (let draw = 0; draw < 40; draw++) {
			clock.now += 1000 / 30;
			// Halfway every clip shrinks to a tile: the larger sizes leave.
			const scales = draw < 20 ? [1, 0.5, 0.25, 0.5, 1] : [0.25, 0.25, 0.25, 0.25, 0.25];
			const lease = cache.beginRender();
			const answers = await Promise.all(
				scales.map((scale, clip) =>
					cache.getFrameAt({
						mediaId: "m1",
						file,
						time: video.timeOf(300 + clip * 51 + draw),
						streamKey: `c${clip}`,
						scale,
						lease,
					}),
				),
			);
			// What this render holds is never destroyed before it ends its lease.
			await settle();
			for (const answer of answers) expect(answer?.canvas.destroyed).toBe(false);
			cache.endRender({ lease });
			await settle();
		}
		expect(video.log.destroyed).toBeGreaterThan(0);
		expect(video.log.doubleDestroyed).toBe(0);
		expect(video.log.drawsIntoDestroyed).toBe(0);
		cache.clearAll();
		expect(video.log.doubleDestroyed).toBe(0);
	});
});
