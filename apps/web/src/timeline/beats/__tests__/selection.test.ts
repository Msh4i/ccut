import { describe, expect, test } from "bun:test";
import { mediaTime, type MediaTime } from "@/wasm";
import {
	clearBeatSelection,
	dropPicked,
	editPickedBeats,
	keepPicked,
	pickBeat,
	pickBeatOnClip,
	useBeatSelectionStore,
	type BeatSelection,
} from "../selection";

const visible = [100, 200, 300, 400, 500, 600];
const base = { trackId: "t1", elementId: "e1", visible };

const pick = ({
	current,
	tick,
	mode = "replace",
	elementId = "e1",
}: {
	current: BeatSelection | null;
	tick: number;
	mode?: "replace" | "toggle" | "range";
	elementId?: string;
}) => pickBeat({ ...base, elementId, current, tick, mode });

const ticksOf = (selection: BeatSelection | null) => [...(selection?.ticks ?? [])].sort((a, b) => a - b);

describe("pickBeat", () => {
	test("a plain click picks that beat only", () => {
		const first = pick({ current: null, tick: 200 });
		expect(ticksOf(first)).toEqual([200]);
		expect(ticksOf(pick({ current: first, tick: 400 }))).toEqual([400]);
	});

	test("clicking the one picked beat again drops it", () => {
		const first = pick({ current: null, tick: 200 });
		expect(pick({ current: first, tick: 200 })).toBeNull();
	});

	test("a plain click on one of several picked beats keeps just that one", () => {
		const several = pick({ current: pick({ current: null, tick: 100 }), tick: 300, mode: "toggle" });
		expect(ticksOf(pick({ current: several, tick: 300 }))).toEqual([300]);
	});

	test("toggle adds beats and takes them out again", () => {
		let selection = pick({ current: null, tick: 100 });
		selection = pick({ current: selection, tick: 300, mode: "toggle" });
		selection = pick({ current: selection, tick: 500, mode: "toggle" });
		expect(ticksOf(selection)).toEqual([100, 300, 500]);
		selection = pick({ current: selection, tick: 300, mode: "toggle" });
		expect(ticksOf(selection)).toEqual([100, 500]);
	});

	test("toggling the last picked beat off leaves no selection", () => {
		const selection = pick({ current: null, tick: 100 });
		expect(pick({ current: selection, tick: 100, mode: "toggle" })).toBeNull();
	});

	test("toggle on an empty selection starts one", () => {
		expect(ticksOf(pick({ current: null, tick: 400, mode: "toggle" }))).toEqual([400]);
	});

	test("range picks everything between the anchor and the click, both ends included", () => {
		const anchor = pick({ current: null, tick: 200 });
		expect(ticksOf(pick({ current: anchor, tick: 500, mode: "range" }))).toEqual([200, 300, 400, 500]);
	});

	test("range works backwards and keeps its anchor for the next range", () => {
		const anchor = pick({ current: null, tick: 500 });
		const back = pick({ current: anchor, tick: 200, mode: "range" });
		expect(ticksOf(back)).toEqual([200, 300, 400, 500]);
		expect(back?.anchor).toBe(500);
		expect(ticksOf(pick({ current: back, tick: 600, mode: "range" }))).toEqual([500, 600]);
	});

	test("range without an anchor is a plain pick", () => {
		expect(ticksOf(pick({ current: null, tick: 300, mode: "range" }))).toEqual([300]);
	});

	test("a pick on another clip starts over instead of mixing beats of two clips", () => {
		const onFirst = pick({ current: null, tick: 200 });
		const onSecond = pick({ current: onFirst, tick: 200, mode: "toggle", elementId: "e2" });
		expect(onSecond?.elementId).toBe("e2");
		expect(ticksOf(onSecond)).toEqual([200]);
	});

	test("never changes the selection it was given", () => {
		const first = pick({ current: null, tick: 200 });
		pick({ current: first, tick: 400, mode: "toggle" });
		expect(ticksOf(first)).toEqual([200]);
	});
});

const beats = (values: number[]): MediaTime[] => values.map((ticks) => mediaTime({ ticks }));

describe("keepPicked and dropPicked", () => {
	test("keep leaves only the picked beats, in order", () => {
		expect(keepPicked({ beats: beats([100, 200, 300, 400]), ticks: new Set([400, 200]) })).toEqual(beats([200, 400]));
	});

	test("drop removes the picked beats and keeps the rest", () => {
		expect(dropPicked({ beats: beats([100, 200, 300, 400]), ticks: new Set([400, 200]) })).toEqual(beats([100, 300]));
	});

	test("picked values that are not stored beats are ignored", () => {
		expect(keepPicked({ beats: beats([100, 200]), ticks: new Set([999]) })).toEqual([]);
		expect(dropPicked({ beats: beats([100, 200]), ticks: new Set([999]) })).toEqual(beats([100, 200]));
	});

	test("never changes the stored array", () => {
		const stored = beats([100, 200, 300]);
		dropPicked({ beats: stored, ticks: new Set([200]) });
		keepPicked({ beats: stored, ticks: new Set([200]) });
		expect(stored).toEqual(beats([100, 200, 300]));
	});
});

describe("the selection store", () => {
	test("picks accumulate through the store and clear in one call", () => {
		clearBeatSelection();
		pickBeatOnClip({ ...base, tick: 100, mode: "replace" });
		pickBeatOnClip({ ...base, tick: 400, mode: "toggle" });
		expect(ticksOf(useBeatSelectionStore.getState().selection)).toEqual([100, 400]);
		clearBeatSelection();
		expect(useBeatSelectionStore.getState().selection).toBeNull();
	});
});

describe("editPickedBeats", () => {
	const stored = beats([100, 200, 300, 400, 500]);
	const edit = ({ ticks, keep, visible = [100, 200, 300, 400, 500] }: { ticks: number[]; keep: boolean; visible?: number[] }) =>
		editPickedBeats({ beats: stored, visible, ticks: new Set(ticks), keep });

	test("keep writes the picked beats only", () => {
		expect(edit({ ticks: [200, 400], keep: true })).toEqual({ beats: beats([200, 400]) });
	});

	test("delete writes everything but the picked beats", () => {
		expect(edit({ ticks: [200, 400], keep: false })).toEqual({ beats: beats([100, 300, 500]) });
	});

	test("deleting every beat leaves the clip with none (undefined), not an empty list", () => {
		expect(edit({ ticks: [100, 200, 300, 400, 500], keep: false })).toEqual({ beats: undefined });
	});

	test("picked beats that are no longer stored change nothing: the clip is left alone", () => {
		expect(edit({ ticks: [999], keep: true })).toBeNull();
		expect(edit({ ticks: [999], keep: false })).toBeNull();
		expect(edit({ ticks: [], keep: true })).toBeNull();
	});

	test("a pick hidden by a trim since is ignored", () => {
		expect(edit({ ticks: [100, 300], keep: false, visible: [200, 300, 400] })).toEqual({
			beats: beats([100, 200, 400, 500]),
		});
		expect(edit({ ticks: [100], keep: true, visible: [200, 300, 400] })).toBeNull();
	});

	test("keep leaves the beats outside the visible window alone", () => {
		// Window 200-400: keeping 300 drops 200 and 400, but not the hidden 100 and 500.
		expect(edit({ ticks: [300], keep: true, visible: [200, 300, 400] })).toEqual({
			beats: beats([100, 300, 500]),
		});
	});
});
