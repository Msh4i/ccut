import { describe, expect, test } from "bun:test";
import { DrawnFrameCache, MIN_CACHED_FRAMES } from "../drawn-frame-cache";

type Canvas = { id: number };

const FPS = 30;

function frame({
	index,
	canvas,
	scale = 1,
}: {
	index: number;
	canvas?: Canvas;
	scale?: number;
}) {
	return {
		canvas: canvas ?? { id: index },
		timestamp: index / FPS,
		duration: 1 / FPS,
		scale,
		displayWidth: 1920,
		displayHeight: 1080,
	};
}

function setup({ budgetBytes, bytes = 100 }: { budgetBytes: number; bytes?: number }) {
	const cache = new DrawnFrameCache<Canvas>({ budgetBytes });
	const released: Array<{ media: string; id: number }> = [];
	const offer = ({ media = "m1", index }: { media?: string; index: number }) => {
		const offered = frame({ index });
		return cache.offer({
			mediaId: media,
			frame: offered,
			bytes,
			release: () => released.push({ media, id: offered.canvas.id }),
		});
	};
	const find = ({ media = "m1", index }: { media?: string; index: number }) =>
		cache.find({ mediaId: media, time: (index + 0.5) / FPS });
	return { cache, released, offer, find };
}

describe("DrawnFrameCache", () => {
	test("a kept frame is found again for any time inside it, only for its own media", () => {
		const { cache, offer, find } = setup({ budgetBytes: 10_000 });
		expect(offer({ index: 5 })).toBe(true);
		expect(find({ index: 5 })?.canvas.id).toBe(5);
		expect(cache.find({ mediaId: "m1", time: 5 / FPS })?.canvas.id).toBe(5);
		expect(cache.find({ mediaId: "m1", time: 6 / FPS - 1e-6 })?.canvas.id).toBe(5);
		expect(cache.find({ mediaId: "m1", time: 6 / FPS })).toBeNull();
		expect(cache.find({ mediaId: "m1", time: 5 / FPS - 1e-6 })).toBeNull();
		expect(find({ media: "m2", index: 5 })).toBeNull();
		expect(cache.getStats()).toEqual({ bytes: 100, frames: 1, hits: 3, evictions: 0 });
	});

	test("finds the right frame among many offered in any order", () => {
		const { offer, find } = setup({ budgetBytes: 1_000_000 });
		for (const index of [40, 3, 17, 4, 99, 0, 41]) offer({ index });
		for (const index of [0, 3, 4, 17, 40, 41, 99]) {
			expect(find({ index })?.canvas.id).toBe(index);
		}
		for (const index of [1, 2, 5, 39, 42, 100]) {
			expect(find({ index })).toBeNull();
		}
	});

	test("over its byte budget it evicts the least recently used frames and hands their canvases back", () => {
		const { cache, released, offer, find } = setup({ budgetBytes: 1000 });
		for (let index = 0; index < 10; index++) offer({ index });
		// frame 0 used again: frame 1 is now the least recently used
		expect(find({ index: 0 })).not.toBeNull();
		offer({ index: 10 });
		expect(released).toEqual([{ media: "m1", id: 1 }]);
		expect(find({ index: 1 })).toBeNull();
		expect(find({ index: 0 })).not.toBeNull();
		expect(cache.getStats().bytes).toBe(1000);
		expect(cache.getStats().evictions).toBe(1);
	});

	test("a smaller budget evicts at once, in least recently used order", () => {
		const { cache, released, offer, find } = setup({ budgetBytes: 1000 });
		for (let index = 0; index < 10; index++) offer({ index });
		find({ index: 2 });
		cache.setBudget({ budgetBytes: 800 });
		expect(cache.getStats().bytes).toBe(800);
		expect(released.map(({ id }) => id)).toEqual([0, 1]);
		// below what holds the minimum number of frames, it keeps nothing
		cache.setBudget({ budgetBytes: 100 * MIN_CACHED_FRAMES - 1 });
		expect(cache.getStats()).toMatchObject({ bytes: 0, frames: 0 });
		expect(released.length).toBe(10);
	});

	test("refuses a frame it could not keep with at least the minimum number of frames", () => {
		const { cache, released, offer } = setup({ budgetBytes: 100 * MIN_CACHED_FRAMES - 1 });
		expect(offer({ index: 1 })).toBe(false);
		expect(cache.getStats().frames).toBe(0);
		// a refused canvas stays its owner's: nothing is released
		expect(released).toEqual([]);
	});

	test("refuses a second frame with the same time of the same media", () => {
		const { cache, offer } = setup({ budgetBytes: 10_000 });
		expect(offer({ index: 7 })).toBe(true);
		expect(offer({ index: 7 })).toBe(false);
		expect(offer({ media: "m2", index: 7 })).toBe(true);
		expect(cache.getStats().frames).toBe(2);
	});

	test("removeMedia and clear hand every canvas back", () => {
		const { cache, released, offer, find } = setup({ budgetBytes: 10_000 });
		for (let index = 0; index < 3; index++) {
			offer({ index });
			offer({ media: "m2", index });
		}
		cache.removeMedia({ mediaId: "m1" });
		expect(released.filter(({ media }) => media === "m1").length).toBe(3);
		expect(find({ index: 1 })).toBeNull();
		expect(find({ media: "m2", index: 1 })).not.toBeNull();
		cache.clear();
		expect(released.length).toBe(6);
		expect(cache.getStats()).toMatchObject({ bytes: 0, frames: 0 });
		expect(cache.framesOf({ mediaId: "m2" })).toBe(0);
	});

	test("counts the frames it holds per media", () => {
		const { cache, offer } = setup({ budgetBytes: 10_000 });
		offer({ index: 1 });
		offer({ index: 2 });
		offer({ media: "m2", index: 1 });
		expect(cache.framesOf({ mediaId: "m1" })).toBe(2);
		expect(cache.framesOf({ mediaId: "m2" })).toBe(1);
		expect(cache.framesOf({ mediaId: "m3" })).toBe(0);
	});

	test("an absurd budget keeps nothing", () => {
		for (const budgetBytes of [Number.NaN, -1, 0]) {
			const { offer } = setup({ budgetBytes });
			expect(offer({ index: 1 })).toBe(false);
		}
	});
});

describe("DrawnFrameCache: frames at a scale", () => {
	function setupScaled() {
		const cache = new DrawnFrameCache<Canvas>({ budgetBytes: 10_000 });
		const released: number[] = [];
		const offer = ({ index, scale, id }: { index: number; scale: number; id: number }) =>
			cache.offer({
				mediaId: "m1",
				frame: frame({ index, scale, canvas: { id } }),
				bytes: 100 * scale * scale,
				release: () => released.push(id),
			});
		const find = ({ index, scale }: { index: number; scale?: number }) =>
			cache.find({ mediaId: "m1", time: (index + 0.5) / FPS, ...(scale !== undefined && { scale }) });
		return { cache, released, offer, find };
	}

	test("a frame drawn at the scale asked for or larger is a hit, a smaller one is not", () => {
		const { offer, find } = setupScaled();
		offer({ index: 5, scale: 0.5, id: 1 });
		expect(find({ index: 5, scale: 0.25 })?.canvas.id).toBe(1);
		expect(find({ index: 5, scale: 0.5 })?.canvas.id).toBe(1);
		expect(find({ index: 5, scale: 0.7 })).toBeNull();
		expect(find({ index: 5, scale: 1 })).toBeNull();
	});

	test("without a scale only full-size frames are found (the default is what export needs)", () => {
		const { offer, find } = setupScaled();
		offer({ index: 5, scale: 0.25, id: 1 });
		offer({ index: 6, scale: 1, id: 2 });
		expect(find({ index: 5 })).toBeNull();
		expect(find({ index: 6 })?.canvas.id).toBe(2);
	});

	test("a miss for a larger scale is not counted as a hit", () => {
		const { cache, offer, find } = setupScaled();
		offer({ index: 5, scale: 0.5, id: 1 });
		find({ index: 5, scale: 1 });
		expect(cache.getStats().hits).toBe(0);
	});

	test("one entry per time: a larger drawing replaces a smaller one, which gives its canvas back", () => {
		const { cache, released, offer, find } = setupScaled();
		expect(offer({ index: 5, scale: 0.25, id: 1 })).toBe(true);
		expect(offer({ index: 5, scale: 1, id: 2 })).toBe(true);
		expect(released).toEqual([1]);
		expect(cache.getStats().frames).toBe(1);
		expect(cache.getStats().bytes).toBe(100);
		expect(find({ index: 5, scale: 1 })?.canvas.id).toBe(2);
	});

	test("a smaller or equal drawing of a time that is kept is refused, its canvas stays its owner's", () => {
		const { cache, released, offer } = setupScaled();
		offer({ index: 5, scale: 0.5, id: 1 });
		expect(offer({ index: 5, scale: 0.25, id: 2 })).toBe(false);
		expect(offer({ index: 5, scale: 0.5, id: 3 })).toBe(false);
		expect(released).toEqual([]);
		expect(cache.getStats().frames).toBe(1);
	});

	test("replacing keeps the frames of the media in time order", () => {
		const { offer, find } = setupScaled();
		for (const index of [3, 5, 4]) offer({ index, scale: 0.25, id: index });
		offer({ index: 4, scale: 1, id: 40 });
		expect(find({ index: 3, scale: 0.25 })?.canvas.id).toBe(3);
		expect(find({ index: 4, scale: 1 })?.canvas.id).toBe(40);
		expect(find({ index: 5, scale: 0.25 })?.canvas.id).toBe(5);
	});
});
