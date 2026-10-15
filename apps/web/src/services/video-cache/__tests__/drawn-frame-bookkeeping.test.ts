import { describe, expect, test } from "bun:test";
import { DrawnFrameCache, SizeCounts } from "../drawn-frame-cache";
import type { PresentedFrame } from "../frame-stream";
import { ScaledCanvasPools } from "../scaled-canvases";

// Bookkeeping that replaced scans on every retired frame: checked against a
// brute-force reference on seeded random sequences (bounded loops).

/** A small deterministic generator (mulberry32). */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

describe("SizeCounts", () => {
	test("the smallest size equals a brute-force scan after every add and remove", () => {
		for (const seed of [1, 7, 42]) {
			const random = seeded(seed);
			const counts = new SizeCounts();
			const reference: number[] = [];
			for (let step = 0; step < 400; step++) {
				if (reference.length > 0 && random() < 0.45) {
					const [removed] = reference.splice(Math.floor(random() * reference.length), 1);
					counts.remove(removed);
				} else {
					const size = [1, 2, 8, 33, 64][Math.floor(random() * 5)];
					reference.push(size);
					counts.add(size);
				}
				const expected = reference.length === 0 ? null : Math.min(...reference);
				expect({ seed, step, smallest: counts.smallest() }).toEqual({ seed, step, smallest: expected });
			}
		}
	});
});

describe("DrawnFrameCache: removal keeps every other kept frame findable", () => {
	test("frames removed in random order (evictions, replacements) leave the rest in place", () => {
		const random = seeded(3);
		const cache = new DrawnFrameCache<{ id: number }>({ budgetBytes: 1000 });
		const kept = new Set<number>();
		const frameAt = ({ index, scale }: { index: number; scale: number }): PresentedFrame<{ id: number }> => ({
			canvas: { id: index },
			timestamp: index / 30,
			duration: 1 / 30,
			scale,
			displayWidth: 1920,
			displayHeight: 1080,
		});
		for (let step = 0; step < 300; step++) {
			const index = Math.floor(random() * 60);
			// A larger drawing of a kept time replaces it.
			const scale = random() < 0.2 ? 1 : 0.5;
			cache.offer({
				mediaId: "m1",
				frame: frameAt({ index, scale }),
				bytes: 10,
				release: () => kept.delete(index),
			});
			if (cache.find({ mediaId: "m1", time: (index + 0.5) / 30, scale: 0.5 })) kept.add(index);
			for (const keptIndex of kept) {
				const found = cache.find({ mediaId: "m1", time: (keptIndex + 0.5) / 30, scale: 0.5 });
				expect({ step, keptIndex, found: found?.canvas.id }).toEqual({ step, keptIndex, found: keptIndex });
			}
		}
		expect(cache.getStats().frames).toBe(kept.size);
		// Every removal found its entry by the binary search, never by the scan.
		expect(cache.slowRemovalCount()).toBe(0);
	});
});

describe("DrawnFrameCache: the smallest kept size follows removals", () => {
	test("once the small frames are gone, a budget under 8 of the large ones keeps none", () => {
		const cache = new DrawnFrameCache<{ id: number }>({ budgetBytes: 10_000 });
		const offer = ({ mediaId, index, bytes }: { mediaId: string; index: number; bytes: number }) =>
			cache.offer({
				mediaId,
				frame: {
					canvas: { id: index },
					timestamp: index / 30,
					duration: 1 / 30,
					scale: 1,
					displayWidth: 1920,
					displayHeight: 1080,
				},
				bytes,
				release: () => {},
			});
		for (let index = 0; index < 8; index++) {
			offer({ mediaId: "small", index, bytes: 10 });
			offer({ mediaId: "large", index, bytes: 100 });
		}
		cache.removeMedia({ mediaId: "small" });
		expect(cache.getStats().frames).toBe(8);
		cache.setBudget({ budgetBytes: 799 });
		expect(cache.getStats().frames).toBe(0);
	});
});

describe("ScaledCanvasPools: room for fewer sizes", () => {
	test("when the room shrinks, the oldest size leaves even while the newest one draws on", () => {
		const destroyed: string[] = [];
		let created = 0;
		const room = { sizes: 3 };
		const pools = new ScaledCanvasPools<{ id: string }>({
			create: ({ scale }) => {
				created += 1;
				return { id: `${scale}:${created}` };
			},
			// A long quarantine: no size expires by time in this test, only the room.
			quarantine: () => 5,
			maxFree: () => 2,
			maxActiveScales: () => room.sizes,
			destroy: (canvas) => {
				destroyed.push(canvas.id);
			},
		});
		const kept: Record<number, { id: string }> = {};
		for (const scale of [0.25, 0.5, 1]) {
			kept[scale] = pools.acquire({ scale });
			pools.release({ canvas: kept[scale], scale });
		}
		expect(destroyed).toEqual([]);
		room.sizes = 2;
		pools.release({ canvas: pools.acquire({ scale: 1 }), scale: 1 });
		expect(destroyed).toEqual([kept[0.25].id]);
	});
});
