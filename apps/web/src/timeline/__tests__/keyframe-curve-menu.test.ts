import { describe, expect, test } from "bun:test";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import { describeKeyframeTargets } from "@/timeline/components/keyframe-curve-menu";
import {
	findCurveKeyframesAtTime,
	toSegmentStartKeyframes,
} from "@/timeline/keyframe-curve-targets";
import { planSegmentEasing } from "@/timeline/segment-easing-plan";
import { buildElementFromMedia } from "@/timeline/element-utils";
import type { TimelineElement } from "@/timeline/types";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const SECOND = TICKS_PER_SECOND;

function key({ id, seconds, value }: { id: string; seconds: number; value: number }): ScalarAnimationKey {
	return { id, time: mediaTime({ ticks: seconds * SECOND }), value, segmentToNext: "linear", tangentMode: "flat" };
}

const animations: ElementAnimations = {
	opacity: { keys: [key({ id: "o1", seconds: 0, value: 0 }), key({ id: "o2", seconds: 2, value: 1 }), key({ id: "o3", seconds: 4, value: 0 })] },
	"transform.rotate": { keys: [key({ id: "r1", seconds: 1, value: 0 }), key({ id: "r2", seconds: 3, value: 90 })] },
	"transform.positionX": { keys: [key({ id: "x1", seconds: 3, value: 0 })] },
};
const paths = Object.keys(animations);
const at = (seconds: number) =>
	findCurveKeyframesAtTime({ trackId: "t", elementId: "e", animations, paths, localTime: seconds * SECOND });
const ids = (refs: { keyframeId: string }[]) => refs.map((ref) => ref.keyframeId);

describe("which keyframes a right click at the playhead shapes", () => {
	test("the key at the playhead, else the key starting the segment the playhead is in", () => {
		expect(ids(at(2))).toEqual(["o2", "r1"]);
		expect(ids(at(0.5))).toEqual(["o1"]);
		expect(ids(at(3))).toEqual(["o2", "r2", "x1"]);
	});

	test("nothing outside every segment and away from every key", () => {
		expect(at(5)).toEqual([]);
	});

	test("the last key of a property stands for the segment arriving at it; a lone key stays as it is", () => {
		const refs = toSegmentStartKeyframes({ animations, keyframes: at(3) });
		expect(ids(refs)).toEqual(["o2", "r1", "x1"]);
		const last = toSegmentStartKeyframes({
			animations,
			keyframes: [{ trackId: "t", elementId: "e", propertyPath: "opacity", keyframeId: "o3" }, { trackId: "t", elementId: "e", propertyPath: "opacity", keyframeId: "o2" }],
		});
		expect(ids(last)).toEqual(["o2"]);
	});
});

describe("curve shapes from the menu", () => {
	const element: TimelineElement = {
		id: "e",
		...buildElementFromMedia({ mediaId: "m", mediaType: "image", name: "e", duration: mediaTime({ ticks: 10 * SECOND }), startTime: mediaTime({ ticks: 0 }) }),
		animations,
	};

	test("a preset curve (Pop) writes a bezier segment on both keys, one entry per key", () => {
		const entries = planSegmentEasing({
			element,
			keyframes: [{ trackId: "t", elementId: "e", propertyPath: "opacity", keyframeId: "o1" }],
			easing: [0.175, 0.885, 0.32, 1.275],
		});
		expect(entries.map((entry) => entry.keyframeId)).toEqual(["o1", "o2"]);
		expect(entries[0].patch.segmentToNext).toBe("bezier");
		expect(entries[0].patch.rightHandle).not.toBeNull();
		expect(entries[1].patch.leftHandle).not.toBeNull();
	});

	test("the header names one property, or counts several", () => {
		const ref = (propertyPath: string) => ({ trackId: "t", elementId: "e", propertyPath, keyframeId: "k" });
		expect(describeKeyframeTargets([ref("transform.positionX")])).toBe("Position X");
		expect(describeKeyframeTargets([ref("opacity")])).toBe("Opacity");
		expect(describeKeyframeTargets([ref("opacity"), ref("transform.rotate")])).toBe("2 properties");
	});
});
