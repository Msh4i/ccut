import { describe, expect, test } from "bun:test";
import {
	type SlotView,
	type StreamPick,
	type StreamPickLimits,
	STREAM_DECODED_FRAMES,
	STREAM_SHOWN_CANVASES,
	chooseBorrowSlot,
	chooseStreamToRelease,
	ownStreamFirst,
	planStreamPick,
	streamCapForBudget,
	streamQuota,
} from "../stream-plan";

const LIMITS: StreamPickLimits = {
	continueSeconds: 0.5,
	maxAdvanceSeconds: 3,
	reuseIdleAfterMs: 500,
};

/** A stream; without a borrower the owner's position is the stream's. */
function slot(overrides: Partial<SlotView> = {}): SlotView {
	return {
		owner: null,
		ownerAskedAt: 0,
		position: 0,
		ownerPosition: overrides.position ?? 0,
		shownTimestamp: null,
		pending: 0,
		latest: new Map(),
		...overrides,
	};
}

function pick({
	key,
	time,
	slots,
	quota = 4,
	activityMs = 1000,
}: {
	key: string | null;
	time: number;
	slots: SlotView[];
	quota?: number;
	activityMs?: number;
}): StreamPick {
	return planStreamPick({ key, time, slots, quota, limits: LIMITS, activityMs });
}

/** Four streams owned by c1..c4 at 10.3 + 1.7 i s, every owner asked a moment ago. */
function fourOwned({ pending = 0 }: { pending?: number } = {}): SlotView[] {
	return [0, 1, 2, 3].map((index) =>
		slot({
			owner: `c${index + 1}`,
			ownerAskedAt: 1000,
			position: 10.3 + 1.7 * index,
			shownTimestamp: 10.3 + 1.7 * index,
			pending,
		}),
	);
}

describe("planStreamPick", () => {
	test("a clip keeps its own stream, busy or not, even when another one continues its time closer", () => {
		const slots = [
			slot({ owner: "a", position: 5, shownTimestamp: 5, pending: 2, ownerAskedAt: 0 }),
			slot({ owner: "b", position: 5.99, shownTimestamp: 5.99, ownerAskedAt: 0 }),
		];
		expect(pick({ key: "a", time: 6, slots })).toEqual({ kind: "own", index: 0 });
	});

	test("a new clip opens a stream below the quota", () => {
		const slots = [slot({ owner: "a", position: 5, ownerAskedAt: 1000, pending: 1 })];
		expect(pick({ key: "b", time: 20, slots, quota: 2 })).toEqual({ kind: "open" });
		expect(pick({ key: "b", time: 20, slots: [], quota: 0 })).toEqual({ kind: "open" });
	});

	test("at the quota with every owner visible a new clip borrows, and no owner changes", () => {
		const idle = pick({ key: "c5", time: 17.1, slots: fourOwned() });
		expect(idle).toEqual({ kind: "borrow", index: 0 });
		const busy = pick({ key: "c5", time: 17.1, slots: fourOwned({ pending: 1 }) });
		expect(busy).toEqual({ kind: "borrow", index: 0 });
	});

	test("the same key and time joins its queued request (a blur backdrop and its video)", () => {
		const slots = fourOwned({ pending: 1 });
		slots[0] = { ...slots[0], pending: 2, latest: new Map([["c1", 10.3], ["c5", 17.1]]) };
		expect(pick({ key: "c5", time: 17.1, slots })).toEqual({ kind: "join", index: 0 });
		// Another time of that key, or the time of another key, does not join.
		expect(pick({ key: "c5", time: 17.2, slots })).toEqual({ kind: "borrow", index: 1 });
		expect(pick({ key: "c6", time: 10.3, slots })).toEqual({ kind: "borrow", index: 1 });
	});

	test("an owner gone for 500 ms of activity loses its idle stream to a new clip", () => {
		const slots = fourOwned();
		slots[2] = { ...slots[2], ownerAskedAt: 500 };
		expect(pick({ key: "c5", time: 40, slots, activityMs: 1000 })).toEqual({
			kind: "take",
			index: 2,
		});
		// 499 ms is not gone yet: borrowed (its owner is the least recently asked), not taken.
		expect(pick({ key: "c5", time: 40, slots, activityMs: 999 })).toEqual({
			kind: "borrow",
			index: 2,
		});
	});

	test("of the streams left behind, one the time continues goes first, then the least recently asked", () => {
		const slots = [
			slot({ owner: "a", ownerAskedAt: 100, position: 50, shownTimestamp: 50 }),
			slot({ owner: "b", ownerAskedAt: 200, position: 8, shownTimestamp: 8 }),
			slot({ owner: "c", ownerAskedAt: 50, position: 30, shownTimestamp: 30 }),
		];
		// 10 s continues "b" (8 s) within the decoder's 3 s window.
		expect(pick({ key: "d", time: 10, slots, quota: 3 })).toEqual({ kind: "take", index: 1 });
		// 20 s continues none: the least recently asked owner ("c").
		expect(pick({ key: "d", time: 20, slots, quota: 3 })).toEqual({ kind: "take", index: 2 });
	});

	test("a split clip takes over the idle stream its time continues by at most 0.5 s", () => {
		const slots = [slot({ owner: "left", ownerAskedAt: 1000, position: 19.98, shownTimestamp: 19.97 })];
		expect(pick({ key: "right", time: 20, slots, quota: 1 })).toEqual({ kind: "take", index: 0 });
		// More than 0.5 s ahead of an owner still on screen: borrowed, not taken.
		expect(pick({ key: "right", time: 20.6, slots, quota: 1 })).toEqual({
			kind: "borrow",
			index: 0,
		});
		// Behind the frame it shows: not a continuation.
		expect(pick({ key: "right", time: 19.9, slots, quota: 1 })).toEqual({
			kind: "borrow",
			index: 0,
		});
	});

	test("a borrower never takes over its owner's stream while the owner is on screen, even when the stream's last request was its own", () => {
		// c5 borrowed c1's stream last draw (its newest request and frame are
		// c5's); c1 was just answered from the drawn-frame cache, so the stream
		// is idle, and c5's next time continues its own last one.
		const slots = fourOwned({ pending: 1 });
		slots[0] = {
			...slots[0],
			pending: 0,
			position: 17.1,
			ownerPosition: 10.3,
			shownTimestamp: 17.1,
			latest: new Map([
				["c1", 10.3],
				["c5", 17.1],
			]),
		};
		expect(pick({ key: "c5", time: 17.1 + 1 / 30, slots })).toEqual({ kind: "borrow", index: 0 });
	});

	test("a busy stream is never taken over, however long its owner is gone", () => {
		const slots = [
			slot({ owner: "a", ownerAskedAt: 0, position: 19.98, shownTimestamp: 19.97, pending: 1 }),
		];
		expect(pick({ key: "b", time: 20, slots, quota: 1, activityMs: 10_000 })).toEqual({
			kind: "borrow",
			index: 0,
		});
		expect(pick({ key: "b", time: 20, slots, quota: 2, activityMs: 10_000 })).toEqual({
			kind: "open",
		});
	});

	test("one parallel draw: 5 clips share 4 streams, 8 lend one each, 12 lend two each; owners never change", () => {
		const expected: Record<number, number[]> = {
			5: [2, 1, 1, 1],
			8: [2, 2, 2, 2],
			12: [3, 3, 3, 3],
		};
		for (const count of [5, 8, 12]) {
			const slots: SlotView[] = [];
			const owners: Array<string | null> = [];
			// Two draws: the first opens the streams, the second is the steady state.
			for (let draw = 0; draw < 2; draw++) {
				for (let index = 0; index < slots.length; index++) {
					slots[index] = { ...slots[index], pending: 0, latest: new Map() };
				}
				for (let clip = 0; clip < count; clip++) {
					const key = `c${clip + 1}`;
					const time = 10.3 + 1.7 * clip + draw / 30;
					const decision = pick({ key, time, slots, activityMs: 1000 + draw * 33 });
					if (decision.kind === "open") {
						slots.push(slot({ owner: key, ownerAskedAt: 1000 + draw * 33 }));
					}
					const index = decision.kind === "open" ? slots.length - 1 : decision.index;
					if (draw === 1) expect(decision.kind === "open" || decision.kind === "take").toBe(false);
					const target = slots[index];
					slots[index] = {
						...target,
						position: time,
						pending: target.pending + 1,
						latest: new Map([...target.latest, [key, time]]),
						...(target.owner === key && { ownerAskedAt: 1000 + draw * 33, ownerPosition: time }),
					};
				}
				if (draw === 0) owners.push(...slots.map((view) => view.owner));
			}
			expect(slots.map((view) => view.pending)).toEqual(expected[count]);
			expect(slots.map((view) => view.owner)).toEqual(owners);
			expect(owners).toEqual(["c1", "c2", "c3", "c4"]);
		}
	});

	test("without a key: the same time joins any request, then the nearest stream within the decoder's window, idle first", () => {
		const slots = [
			slot({ owner: "a", position: 5, shownTimestamp: 5, pending: 1, latest: new Map([["a", 5]]) }),
			slot({ owner: "b", position: 9, shownTimestamp: 9, pending: 1 }),
			slot({ owner: null, position: 7, shownTimestamp: 7 }),
		];
		expect(pick({ key: null, time: 5, slots, quota: 3 })).toEqual({ kind: "join", index: 0 });
		// 9.5 s: "b" is nearer but busy, the idle stream at 7 s is within 3 s.
		expect(pick({ key: null, time: 9.5, slots, quota: 3 })).toEqual({ kind: "borrow", index: 2 });
		// 11 s: only the busy "b" is within reach (scrubbing one clip).
		expect(pick({ key: null, time: 11, slots, quota: 3 })).toEqual({ kind: "borrow", index: 1 });
		// 40 s: nothing within reach, below the quota.
		expect(pick({ key: null, time: 40, slots, quota: 4 })).toEqual({ kind: "open" });
		expect(pick({ key: null, time: 40, slots, quota: 3 })).toEqual({ kind: "borrow", index: 2 });
	});
});

describe("chooseBorrowSlot", () => {
	test("the fewest requests in flight first", () => {
		const slots = [
			slot({ owner: "a", pending: 2, ownerAskedAt: 0 }),
			slot({ owner: "b", pending: 1, ownerAskedAt: 900 }),
			slot({ owner: "c", pending: 3, ownerAskedAt: 0 }),
		];
		expect(chooseBorrowSlot({ time: 40, slots, continueSeconds: 0.5 })).toBe(1);
	});

	test("then a stream the time continues forward by at most 0.5 s", () => {
		const slots = [
			slot({ owner: "a", pending: 1, position: 39.4, ownerAskedAt: 0 }),
			slot({ owner: "b", pending: 1, position: 39.7, ownerAskedAt: 900 }),
			slot({ owner: "c", pending: 1, position: 40.2, ownerAskedAt: 0 }),
		];
		expect(chooseBorrowSlot({ time: 40, slots, continueSeconds: 0.5 })).toBe(1);
	});

	test("then the least recently asked owner, then the lowest index", () => {
		const slots = [
			slot({ owner: "a", pending: 1, ownerAskedAt: 700 }),
			slot({ owner: "b", pending: 1, ownerAskedAt: 600 }),
			slot({ owner: "c", pending: 1, ownerAskedAt: 600 }),
		];
		expect(chooseBorrowSlot({ time: 40, slots, continueSeconds: 0.5 })).toBe(1);
		expect(
			chooseBorrowSlot({
				time: 40,
				slots: slots.map((view) => ({ ...view, ownerAskedAt: 600 })),
				continueSeconds: 0.5,
			}),
		).toBe(0);
	});

	test("no stream: nothing to borrow", () => {
		expect(chooseBorrowSlot({ time: 40, slots: [], continueSeconds: 0.5 })).toBeNull();
	});
});

describe("streamQuota", () => {
	const LIMITS_4_8 = { maxPerMedia: 4, maxTotal: 8 };

	function quotas(clips: Array<[string, number]>): Array<[string, number]> {
		return [...streamQuota({ clipsByMedia: new Map(clips), limits: LIMITS_4_8 })];
	}

	test("one media gets a stream per clip up to 4", () => {
		expect(quotas([["m1", 12]])).toEqual([["m1", 4]]);
		expect(quotas([["m1", 3]])).toEqual([["m1", 3]]);
	});

	test("over 8 in total the streams are shared out evenly, scene order first", () => {
		expect(quotas([["a", 4], ["b", 4], ["c", 4]])).toEqual([["a", 3], ["b", 3], ["c", 2]]);
		expect(quotas([["a", 2], ["b", 6]])).toEqual([["a", 2], ["b", 4]]);
		expect(quotas([["a", 4], ["b", 4], ["c", 4], ["d", 4], ["e", 4]])).toEqual([
			["a", 2],
			["b", 2],
			["c", 2],
			["d", 1],
			["e", 1],
		]);
	});

	test("every visible media keeps one stream, past 8 in total (soft)", () => {
		const nine = Array.from({ length: 9 }, (_, index): [string, number] => [`m${index}`, 1]);
		expect(quotas(nine).map(([, quota]) => quota)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
	});

	test("a media without visible clips gets none; odd counts are read as whole clips", () => {
		expect(
			quotas([
				["gone", 0],
				["negative", -2],
				["nan", Number.NaN],
				["half", 0.5],
				["two-and-a-half", 2.5],
			]),
		).toEqual([
			["gone", 0],
			["negative", 0],
			["nan", 0],
			["half", 1],
			["two-and-a-half", 2],
		]);
	});

	test("invalid limits fall back to one stream per visible media", () => {
		expect([
			...streamQuota({
				clipsByMedia: new Map([["a", 3], ["b", 3]]),
				limits: { maxPerMedia: Number.NaN, maxTotal: Number.NaN },
			}),
		]).toEqual([
			["a", 1],
			["b", 1],
		]);
	});
});

describe("streamCapForBudget", () => {
	const MiB = 1024 ** 2;
	const GiB = 1024 ** 3;
	const DECODED_1080P = 1920 * 1080 * 1.5;
	const DECODED_4K = 3840 * 2160 * 1.5;

	const DRAWN_1080P = 1920 * 1080 * 4;
	const DRAWN_4K = 3840 * 2160 * 4;

	function cap(overrides: Partial<Parameters<typeof streamCapForBudget>[0]>): number {
		return streamCapForBudget({
			budgetBytes: 256 * MiB,
			decodedFrameBytes: DECODED_1080P,
			drawnFrameBytes: DRAWN_1080P,
			visibleMedia: 1,
			maxPerMedia: 4,
			...overrides,
		});
	}

	test("a stream reserves 2 read-ahead + 8 decoder queue + 1 kept decoded frames, and its shown canvas", () => {
		expect(STREAM_DECODED_FRAMES).toBe(11);
		expect(STREAM_SHOWN_CANVASES).toBe(1);
	});

	test("1080p: 4 streams at 256 MB and 1.5 GB, 1 at the 64 MB floor; 4K at 256 MB: 1", () => {
		expect(cap({})).toBe(4);
		expect(cap({ budgetBytes: 1.5 * GiB })).toBe(4);
		expect(cap({ budgetBytes: 64 * MiB })).toBe(1);
		expect(cap({ decodedFrameBytes: DECODED_4K, drawnFrameBytes: DRAWN_4K })).toBe(1);
	});

	test("the budget is split between the visible media", () => {
		// 256 MB / 2 / (11 x 3.1 MB + 8.3 MB) = 3.2
		expect(cap({ visibleMedia: 2 })).toBe(3);
		expect(cap({ visibleMedia: 8 })).toBe(1);
	});

	test("two media at 320 MB: 3 streams each, not the 4 the decoded frames alone would allow", () => {
		// 320 MB / 2 = 167.8 MB per media; 11 x 3.1 MB = 34.2 MB decoded and
		// 8.3 MB shown per stream: 3.9 streams; decoded frames alone: 4.9.
		expect(cap({ budgetBytes: 320 * MiB, visibleMedia: 2 })).toBe(3);
	});

	test("at the 64 MB floor what a stream really holds: no kept frame, its canvas at the scale drawn", () => {
		const floor = { budgetBytes: 64 * MiB, keepsDecoded: false };
		// 2 x (8 queued + 2 read-ahead) x 3.1 MB + canvases at 1/4: 2 streams fit.
		expect(cap({ ...floor, shownScale: 0.25, mediaCanvases: 3 })).toBe(2);
		// Full-size canvases or a kept frame per stream: one.
		expect(cap({ ...floor, shownScale: 1, mediaCanvases: 3 })).toBe(1);
		expect(cap({ ...floor, shownScale: 0.25, mediaCanvases: 3, keepsDecoded: true })).toBe(1);
		// The free canvases of many clips take the room of the second stream.
		expect(cap({ ...floor, shownScale: 0.25, mediaCanvases: 13 })).toBe(1);
		// Two media at the floor: one each.
		expect(cap({ ...floor, shownScale: 0.25, mediaCanvases: 2, visibleMedia: 2 })).toBe(1);
	});

	test("never under 1 nor over the per-media limit; invalid inputs give 1", () => {
		expect(cap({ budgetBytes: 1.5 * GiB, maxPerMedia: 6 })).toBe(6);
		for (const budgetBytes of [Number.NaN, 0, -1]) expect(cap({ budgetBytes })).toBe(1);
		for (const decodedFrameBytes of [Number.NaN, 0, -1]) expect(cap({ decodedFrameBytes })).toBe(1);
		for (const drawnFrameBytes of [Number.NaN, 0, -1]) expect(cap({ drawnFrameBytes })).toBe(1);
		expect(cap({ maxPerMedia: Number.NaN })).toBe(1);
		// No visible media counted yet: as one.
		expect(cap({ visibleMedia: 0 })).toBe(4);
		expect(cap({ visibleMedia: Number.NaN })).toBe(4);
	});
});

describe("chooseStreamToRelease", () => {
	test("nothing while the streams fit in the total", () => {
		const streams = [{ mediaId: "a", pending: 0, lastUsed: 0 }];
		expect(
			chooseStreamToRelease({ streams, quotaByMedia: new Map([["a", 0]]), maxTotal: 1 }),
		).toBeNull();
	});

	test("over the total: the least recently used idle stream of a media over its quota", () => {
		const streams = [
			{ mediaId: "a", pending: 0, lastUsed: 100 },
			{ mediaId: "a", pending: 0, lastUsed: 50 },
			{ mediaId: "b", pending: 0, lastUsed: 10 },
		];
		const quotaByMedia = new Map([
			["a", 1],
			["b", 1],
		]);
		expect(chooseStreamToRelease({ streams, quotaByMedia, maxTotal: 2 })).toBe(1);
	});

	test("a busy stream is never evicted", () => {
		const streams = [
			{ mediaId: "a", pending: 1, lastUsed: 0 },
			{ mediaId: "a", pending: 2, lastUsed: 0 },
		];
		expect(
			chooseStreamToRelease({ streams, quotaByMedia: new Map([["a", 0]]), maxTotal: 1 }),
		).toBeNull();
	});

	test("one stream per visible media stays past the total (soft); a media no longer visible has none", () => {
		const streams = Array.from({ length: 9 }, (_, index) => ({
			mediaId: `m${index}`,
			pending: 0,
			lastUsed: index,
		}));
		const allVisible = new Map(streams.map((stream) => [stream.mediaId, 1]));
		expect(chooseStreamToRelease({ streams, quotaByMedia: allVisible, maxTotal: 8 })).toBeNull();
		const lastGone = new Map(allVisible);
		lastGone.delete("m8");
		expect(chooseStreamToRelease({ streams, quotaByMedia: lastGone, maxTotal: 8 })).toBe(8);
	});
});

describe("ownStreamFirst", () => {
	const SHOWN = { timestamp: 10, duration: 1 / 30, scale: 0.25 };

	function first(overrides: Partial<Parameters<typeof ownStreamFirst>[0]>): boolean {
		return ownStreamFirst({
			time: 10.1,
			scale: 0.25,
			maxStaleSeconds: 0.09,
			position: 10.05,
			shown: SHOWN,
			continueSeconds: 0.5,
			...overrides,
		});
	}

	test("a time the stream reaches by decoding forward goes to the stream", () => {
		expect(first({})).toBe(true);
		expect(first({ time: 10.55 })).toBe(true);
		// The frame it shows: a hit on the stream.
		expect(first({ time: 10.01 })).toBe(true);
	});

	test("before the frame it shows, or further than the window: the drawn-frame cache first", () => {
		expect(first({ time: 9.9 })).toBe(false);
		expect(first({ time: 10.56 })).toBe(false);
		expect(first({ position: Number.NaN, shown: null })).toBe(false);
	});

	test("an exact request bigger than the shown frame it needs would redraw it: the drawn-frame cache first", () => {
		expect(first({ time: 10.01, scale: 1, maxStaleSeconds: 0 })).toBe(false);
		// While playing the smaller frame is fine, and a later frame is drawn at the new size.
		expect(first({ time: 10.01, scale: 1, maxStaleSeconds: 0.09 })).toBe(true);
		expect(first({ time: 10.1, scale: 1, maxStaleSeconds: 0 })).toBe(true);
	});

	test("a stream with no frame yet goes by its newest request", () => {
		expect(first({ shown: null, position: 10, time: 10.2 })).toBe(true);
		expect(first({ shown: null, position: 10, time: 9.9 })).toBe(false);
	});
});
