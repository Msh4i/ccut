import { describe, expect, test } from "bun:test";
import { resolveAnimationPathValueAtTime } from "@/animation";
import { upsertPathKeyframe } from "@/animation/keyframes";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { buildElementFromMedia } from "@/timeline/element-utils";
import type { AudioCapableElement } from "@/timeline/audio-state";
import { getDbFromLinePos } from "@/timeline/audio-display";
import {
	buildEnvelopePolyline,
	getVolumeEnvelopePoints,
	pointFromPosition,
} from "@/timeline/volume-envelope";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const DURATION = 10 * TICKS_PER_SECOND;

function audio({ keys }: { keys?: Array<[number, number]> }): AudioCapableElement {
	const built = buildElementFromMedia({
		mediaId: "m",
		mediaType: "audio",
		name: "a",
		duration: mediaTime({ ticks: DURATION }),
		startTime: mediaTime({ ticks: 0 }),
	});
	if (built.type !== "audio") throw new Error("expected audio");
	return {
		id: "a",
		...built,
		animations: keys
			? {
					volume: {
						keys: keys.map(([seconds, db], index) => ({
							id: `k${index}`,
							time: mediaTime({ ticks: seconds * TICKS_PER_SECOND }),
							value: db,
							segmentToNext: "linear" as const,
							tangentMode: "flat" as const,
						})),
					},
				}
			: undefined,
	};
}

describe("volume envelope", () => {
	test("the points are the volume keys, in time order, placed across the clip", () => {
		const points = getVolumeEnvelopePoints({ element: audio({ keys: [[0, -60], [5, 0], [10, -6]] }) });
		expect(points.map((p) => [p.id, p.db, p.xPercent])).toEqual([
			["k0", -60, 0],
			["k1", 0, 50],
			["k2", -6, 100],
		]);
		expect(points[0].yPercent).toBeGreaterThan(points[1].yPercent);
	});

	test("a clip without volume keys has no points", () => {
		expect(getVolumeEnvelopePoints({ element: audio({}) })).toEqual([]);
	});

	test("a position over the clip is a time and a volume, held to the clip and the range", () => {
		const middle = pointFromPosition({ x: 0.5, y: 0.5, duration: DURATION });
		expect(middle.time).toBe(DURATION / 2);
		expect(middle.db).toBeCloseTo(getDbFromLinePos({ percent: 50 }), 9);
		expect(pointFromPosition({ x: -1, y: 0, duration: DURATION })).toEqual({ time: 0, db: 20 });
		const low = pointFromPosition({ x: 2, y: 5, duration: DURATION });
		expect(low.time).toBe(DURATION);
		expect(low.db).toBe(-60);
	});

	test("the drawn curve follows the keys: a linear fade in dB is a straight ramp between its ends", () => {
		const line = buildEnvelopePolyline({ element: audio({ keys: [[0, -60], [10, 0]] }), steps: 10 });
		expect(line).toHaveLength(11);
		expect(line[0][0]).toBe(0);
		expect(line[10][0]).toBe(100);
		expect(line[0][1]).toBeGreaterThan(line[10][1]);
		for (let index = 1; index < line.length; index++) {
			expect(line[index][1]).toBeLessThanOrEqual(line[index - 1][1]);
		}
	});

	test("with no keys the curve is the flat static volume", () => {
		const line = buildEnvelopePolyline({ element: audio({}), steps: 4 });
		expect(new Set(line.map(([, y]) => y)).size).toBe(1);
	});
});

describe("the writes the envelope editor makes", () => {
	function write({ element, time, value, keyframeId }: { element: AudioCapableElement; time: number; value: number; keyframeId?: string }) {
		const target = resolveAnimationTarget({ element, path: "volume" });
		if (!target) throw new Error("no volume target");
		return upsertPathKeyframe({
			animations: element.animations,
			propertyPath: "volume",
			time: mediaTime({ ticks: time }),
			value,
			keyframeId,
			channelLayout: target.channelLayout,
			coerceValue: target.coerceValue,
		});
	}

	test("dragging a point (same key id, new time and dB) moves that key and no other", () => {
		const element = audio({ keys: [[0, -60], [5, 0], [10, -6]] });
		const moved = write({ element, time: 7 * TICKS_PER_SECOND, value: -12, keyframeId: "k1" });
		const points = getVolumeEnvelopePoints({ element: { ...element, animations: moved } });
		expect(points.map((p) => [p.id, p.time / TICKS_PER_SECOND, p.db])).toEqual([
			["k0", 0, -60],
			["k1", 7, -12],
			["k2", 10, -6],
		]);
	});

	test("adding a point on the line at its own value leaves the sound unchanged", () => {
		const element = audio({ keys: [[0, -60], [10, 0]] });
		const time = 5 * TICKS_PER_SECOND;
		const before = resolveAnimationPathValueAtTime({ animations: element.animations, propertyPath: "volume", localTime: time, fallbackValue: 0 });
		const next = write({ element, time, value: before });
		expect(getVolumeEnvelopePoints({ element: { ...element, animations: next } })).toHaveLength(3);
		for (const seconds of [0, 2.5, 5, 7.5, 10]) {
			const localTime = seconds * TICKS_PER_SECOND;
			const a = resolveAnimationPathValueAtTime({ animations: element.animations, propertyPath: "volume", localTime, fallbackValue: 0 });
			const b = resolveAnimationPathValueAtTime({ animations: next, propertyPath: "volume", localTime, fallbackValue: 0 });
			expect(b).toBeCloseTo(a, 6);
		}
	});

	test("a first point on a clip with a static volume holds that volume the whole clip", () => {
		const element = audio({});
		const next = write({ element, time: 3 * TICKS_PER_SECOND, value: 0 });
		for (const seconds of [0, 3, 10]) {
			expect(resolveAnimationPathValueAtTime({ animations: next, propertyPath: "volume", localTime: seconds * TICKS_PER_SECOND, fallbackValue: -20 })).toBe(0);
		}
	});

	test("dragging a point onto another point's tick merges them: the dragged point stays, the other goes", () => {
		const element = audio({ keys: [[0, -60], [5, 0], [10, -6]] });
		const merged = write({ element, time: 10 * TICKS_PER_SECOND, value: -3, keyframeId: "k1" });
		const points = getVolumeEnvelopePoints({ element: { ...element, animations: merged } });
		expect(points.map((p) => [p.id, p.time / TICKS_PER_SECOND, p.db])).toEqual([
			["k0", 0, -60],
			["k1", 10, -3],
		]);
	});

	test("moving onto a free tick keeps every other point", () => {
		const element = audio({ keys: [[0, -60], [5, 0], [10, -6]] });
		const moved = write({ element, time: 9 * TICKS_PER_SECOND, value: 0, keyframeId: "k1" });
		expect(getVolumeEnvelopePoints({ element: { ...element, animations: moved } })).toHaveLength(3);
	});
});
