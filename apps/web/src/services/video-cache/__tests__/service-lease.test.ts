import { describe, expect, test } from "bun:test";
import { CanvasRecycler } from "../canvas-recycler";
import {
	type MemorySource,
	RENDER_LEASE_TIMEOUT_MS,
	type RenderLease,
	VideoCache,
	withRenderLease,
} from "../service";
import { type FakeCanvas, createFakeVideo, settle } from "./fake-video";

// A render holds the frames it got until it has uploaded them (it ends its
// lease): no canvas of theirs is drawn over, reused or destroyed meanwhile,
// however many draws other renders make (review P4-RB 2: a snapshot's
// canvases were destroyed by the playing preview before the snapshot
// uploaded them). A lease that never ends stops holding after a timeout.

const GiB = 1024 ** 3;
const FPS = 30;
const NORMAL = {
	totalBytes: 15.3 * GiB,
	availableBytes: 6.3 * GiB,
	swapTotalBytes: 8 * GiB,
	swapFreeBytes: 8 * GiB,
	appBytes: 1.2 * GiB,
};
const PRESSED = { ...NORMAL, availableBytes: 0.5 * GiB };

function setup({ reading }: { reading: unknown }) {
	const video = createFakeVideo({ fps: FPS, frameCount: 3000 });
	const clock = { now: 0 };
	const memory: MemorySource = {
		readMemory: async () => reading,
		mode: () => "balanced",
		deviceMemoryGiB: () => null,
	};
	const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => clock.now, memory });
	const file = new File([], "m1");
	const ask = ({ clip, time, scale, lease }: { clip: number; time: number; scale: number; lease?: RenderLease }) =>
		cache.getFrameAt({
			mediaId: "m1",
			file,
			time: time + 1.7 * clip,
			streamKey: `c${clip}`,
			scale,
			...(lease && { lease }),
		});
	/** One render of the playing preview at 0.25, with its own lease. */
	const preview = async ({ clips, draw }: { clips: number; draw: number }) => {
		clock.now += 1000 / FPS;
		const lease = cache.beginRender();
		try {
			return await cache.withPlaybackTolerance({
				maxStaleSeconds: 0.09,
				run: () =>
					Promise.all(
						Array.from({ length: clips }, (_, clip) =>
							ask({ clip, time: 10.3 + draw / FPS, scale: 0.25, lease }),
						),
					),
			});
		} finally {
			cache.endRender({ lease });
		}
	};
	return { video, clock, cache, ask, preview };
}

/** A snapshot (full size, exact) of every clip next to a preview render; its lease stays open. */
async function snapshotBesidePreview({
	setupResult,
	clips,
	draw,
}: {
	setupResult: ReturnType<typeof setup>;
	clips: number;
	draw: number;
}) {
	const { cache, ask, preview } = setupResult;
	const lease = cache.beginRender();
	const [snapshot] = await Promise.all([
		Promise.all(
			Array.from({ length: clips }, (_, clip) => ask({ clip, time: 10.3 + draw / FPS, scale: 1, lease })),
		),
		preview({ clips, draw }),
	]);
	const held = snapshot.flatMap((frame) => (frame ? [{ canvas: frame.canvas, frame: frame.canvas.frame }] : []));
	expect(held).toHaveLength(clips);
	return { lease, held };
}

function broken(held: Array<{ canvas: FakeCanvas; frame: number | null }>): number {
	return held.filter((entry) => entry.canvas.destroyed || entry.canvas.frame !== entry.frame).length;
}

describe("VideoCache: a render's lease on its frames", () => {
	for (const [label, reading] of [
		["normal budget", NORMAL],
		["pressure floor", PRESSED],
		["no reading (256 MB)", null],
	] as const) {
		for (const clips of [1, 3, 5]) {
			test(`${label}, ${clips} clips: a snapshot's canvases keep their pictures while the preview plays 60 renders before it uploads`, async () => {
				const run = setup({ reading });
				await run.cache.tickMemory();
				let draw = 0;
				for (; draw < 30; draw++) {
					await run.preview({ clips, draw });
					await settle();
				}
				const { lease, held } = await snapshotBesidePreview({ setupResult: run, clips, draw: draw++ });
				const brokenAfter: number[] = [];
				for (let extra = 0; extra < 60; extra++, draw++) {
					await run.preview({ clips, draw });
					await settle();
					brokenAfter.push(broken(held));
				}
				expect(brokenAfter.filter((count) => count > 0)).toEqual([]);
				run.cache.endRender({ lease });
				expect(run.video.log.drawsIntoDestroyed).toBe(0);
				expect(run.video.log.doubleDestroyed).toBe(0);
				run.cache.clearAll();
			});
		}
	}

	test("once the snapshot ended its lease, its canvases are reused or freed: memory is not pinned", async () => {
		const run = setup({ reading: PRESSED });
		await run.cache.tickMemory();
		let draw = 0;
		for (; draw < 10; draw++) {
			await run.preview({ clips: 3, draw });
			await settle();
		}
		const { lease, held } = await snapshotBesidePreview({ setupResult: run, clips: 3, draw: draw++ });
		run.cache.endRender({ lease });
		for (let extra = 0; extra < 60; extra++, draw++) {
			await run.preview({ clips: 3, draw });
			await settle();
		}
		// Full-size canvases nobody draws at any more are destroyed once let go.
		expect(held.filter((entry) => entry.canvas.destroyed).length).toBe(3);
		run.cache.clearAll();
	});

	test(`a lease never ended stops holding after ${RENDER_LEASE_TIMEOUT_MS} ms`, async () => {
		const run = setup({ reading: PRESSED });
		await run.cache.tickMemory();
		let draw = 0;
		for (; draw < 10; draw++) {
			await run.preview({ clips: 3, draw });
			await settle();
		}
		const { held } = await snapshotBesidePreview({ setupResult: run, clips: 3, draw: draw++ });
		// A render that hangs: its lease is never ended.
		for (let extra = 0; extra < 40; extra++, draw++) {
			await run.preview({ clips: 3, draw });
			await settle();
		}
		expect(broken(held)).toBe(0);
		run.clock.now += RENDER_LEASE_TIMEOUT_MS;
		for (let extra = 0; extra < 60; extra++, draw++) {
			await run.preview({ clips: 3, draw });
			await settle();
		}
		expect(held.filter((entry) => entry.canvas.destroyed).length).toBe(3);
		run.cache.clearAll();
	});

	test("a lease that ended, or none, holds nothing", async () => {
		const run = setup({ reading: null });
		const lease = run.cache.beginRender();
		run.cache.endRender({ lease });
		run.cache.endRender({ lease });
		const frame = await run.ask({ clip: 0, time: 10.3, scale: 1, lease });
		expect(frame?.canvas.frame).toBe(309);
		run.cache.clearAll();
	});
});

describe("CanvasRecycler: a held canvas", () => {
	test("is not reused, dropped or destroyed past its quarantine; once let go it is", () => {
		const held = new Set<{ id: number }>();
		const destroyed: number[] = [];
		let created = 0;
		const recycler = new CanvasRecycler<{ id: number }>({
			create: () => {
				created += 1;
				return { id: created };
			},
			quarantine: () => 1,
			maxFree: () => 0,
			isHeld: (canvas) => held.has(canvas),
			destroy: (canvas) => {
				destroyed.push(canvas.id);
			},
		});
		const first = recycler.acquire();
		recycler.noteHandOut(first);
		held.add(first);
		for (let draw = 0; draw < 5; draw++) recycler.release(recycler.acquire());
		recycler.release(first);
		recycler.trim();
		expect(destroyed).not.toContain(first.id);
		held.delete(first);
		recycler.trim();
		expect(destroyed).toContain(first.id);
	});
});

describe("withRenderLease", () => {
	function recordingCache() {
		const events: string[] = [];
		let id = 0;
		return {
			events,
			cache: {
				beginRender: (): RenderLease => {
					id += 1;
					events.push(`begin ${id}`);
					return { id };
				},
				endRender: ({ lease }: { lease: RenderLease }) => {
					events.push(`end ${lease.id}`);
				},
			},
		};
	}

	test("ends the lease when the render resolves", async () => {
		const { events, cache } = recordingCache();
		const seen: number[] = [];
		const result = await withRenderLease({
			cache,
			run: async (lease) => {
				seen.push(lease.id);
				return "drawn";
			},
		});
		expect(result).toBe("drawn");
		expect(seen).toEqual([1]);
		expect(events).toEqual(["begin 1", "end 1"]);
	});

	test("ends the lease when the render fails, and the failure reaches the caller", async () => {
		const { events, cache } = recordingCache();
		const outcome = await withRenderLease({
			cache,
			run: async () => {
				throw new Error("render failed");
			},
		}).then(
			() => "resolved",
			(error: unknown) => String(error),
		);
		expect(outcome).toBe("Error: render failed");
		expect(events).toEqual(["begin 1", "end 1"]);
	});
});
