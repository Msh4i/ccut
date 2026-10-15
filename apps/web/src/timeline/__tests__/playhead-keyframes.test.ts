import { describe, expect, test } from "bun:test";
import { resolveAnimationPathValueAtTime } from "@/animation";
import { isScalarChannel } from "@/animation/interpolation";
import { getChannel } from "@/animation/keyframes";
import { getSegmentEasingPatch } from "@/animation/segment-easing";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import { buildElementFromMedia } from "@/timeline/element-utils";
import {
	findAdjacentKeyframeTime,
	getPlayheadKeyframePaths,
	planPlayheadKeyframe,
} from "@/timeline/playhead-keyframes";
import { getSegmentPairRefs, planSegmentEasing } from "@/timeline/segment-easing-plan";
import type { TimelineElement } from "@/timeline/types";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const SECOND = TICKS_PER_SECOND;
const START = 2 * SECOND;

function clip({ type, animations }: { type: "video" | "image" | "audio"; animations?: ElementAnimations }): TimelineElement {
	return {
		id: type,
		...buildElementFromMedia({
			mediaId: "m",
			mediaType: type,
			name: type,
			duration: mediaTime({ ticks: 10 * SECOND }),
			startTime: mediaTime({ ticks: START }),
		}),
		animations,
	};
}

function key({ id, seconds, value }: { id: string; seconds: number; value: number }): ScalarAnimationKey {
	return { id, time: mediaTime({ ticks: seconds * SECOND }), value, segmentToNext: "linear", tangentMode: "flat" };
}

describe("keyframe at the playhead", () => {
	test("pictures key position, scale, rotate and opacity; sound keys volume; a video does not key its volume", () => {
		expect(getPlayheadKeyframePaths({ element: clip({ type: "image" }) })).toEqual([
			"transform.positionX",
			"transform.positionY",
			"transform.scaleX",
			"transform.scaleY",
			"transform.rotate",
			"opacity",
		]);
		expect(getPlayheadKeyframePaths({ element: clip({ type: "video" }) })).not.toContain("volume");
		expect(getPlayheadKeyframePaths({ element: clip({ type: "audio" }) })).toEqual(["volume"]);
	});

	test("with no key there it adds every property at its current value", () => {
		const element = clip({ type: "image", animations: { opacity: { keys: [key({ id: "a", seconds: 0, value: 0 }), key({ id: "b", seconds: 4, value: 1 })] } } });
		const plan = planPlayheadKeyframe({ element, playhead: START + 2 * SECOND });
		if (plan?.kind !== "add") throw new Error("expected add");
		expect(plan.keyframes.map((entry) => entry.propertyPath)).toHaveLength(6);
		const opacity = plan.keyframes.find((entry) => entry.propertyPath === "opacity");
		expect(opacity?.value).toBeCloseTo(0.5, 9);
		expect(plan.keyframes.find((entry) => entry.propertyPath === "transform.scaleX")?.value).toBe(1);
	});

	test("with a key there on any property it removes the keys that are there, and only those", () => {
		const element = clip({ type: "image", animations: {
			opacity: { keys: [key({ id: "o1", seconds: 0, value: 0 }), key({ id: "o2", seconds: 2, value: 1 })] },
			"transform.rotate": { keys: [key({ id: "r1", seconds: 1, value: 0 }), key({ id: "r2", seconds: 3, value: 10 })] },
		} });
		const plan = planPlayheadKeyframe({ element, playhead: START + 2 * SECOND });
		expect(plan).toEqual({ kind: "remove", keyframes: [{ propertyPath: "opacity", keyframeId: "o2" }] });
	});

	test("outside the clip there is nothing to do", () => {
		const element = clip({ type: "image" });
		expect(planPlayheadKeyframe({ element, playhead: START - 1 })).toBeNull();
		expect(planPlayheadKeyframe({ element, playhead: START + 10 * SECOND + 1 })).toBeNull();
		expect(planPlayheadKeyframe({ element, playhead: START })).not.toBeNull();
	});

	test("an audio clip adds a volume key at its current dB", () => {
		const plan = planPlayheadKeyframe({ element: clip({ type: "audio" }), playhead: START + SECOND });
		expect(plan).toEqual({ kind: "add", keyframes: [{ propertyPath: "volume", value: 0 }] });
	});
});

describe("previous and next keyframe", () => {
	const element = clip({ type: "video", animations: {
		opacity: { keys: [key({ id: "a", seconds: 1, value: 0 }), key({ id: "b", seconds: 5, value: 1 })] },
		"transform.rotate": { keys: [key({ id: "c", seconds: 3, value: 0 })] },
	} });
	const at = (seconds: number) => mediaTime({ ticks: START + seconds * SECOND });

	test("the closest key of any property after / before the playhead", () => {
		expect(findAdjacentKeyframeTime({ element, playhead: at(2), direction: "next" })).toBe(at(3));
		expect(findAdjacentKeyframeTime({ element, playhead: at(2), direction: "previous" })).toBe(at(1));
		expect(findAdjacentKeyframeTime({ element, playhead: at(3), direction: "next" })).toBe(at(5));
		expect(findAdjacentKeyframeTime({ element, playhead: at(3), direction: "previous" })).toBe(at(1));
	});

	test("null past the first and last key, and for a clip without keys", () => {
		expect(findAdjacentKeyframeTime({ element, playhead: at(1), direction: "previous" })).toBeNull();
		expect(findAdjacentKeyframeTime({ element, playhead: at(5), direction: "next" })).toBeNull();
		expect(findAdjacentKeyframeTime({ element: clip({ type: "video" }), playhead: at(1), direction: "next" })).toBeNull();
	});
});

describe("easing a diamond", () => {
	const element = clip({ type: "image", animations: { opacity: { keys: [key({ id: "a", seconds: 0, value: 0 }), key({ id: "b", seconds: 4, value: 1 }), key({ id: "c", seconds: 8, value: 0 })] } } });
	const ref = (keyframeId: string) => ({ trackId: "t", elementId: "image", propertyPath: "opacity", keyframeId });

	test("writes the left key's shape and the right key's incoming handle", () => {
		const entries = planSegmentEasing({ element, keyframes: [ref("a")], easing: "ease-in-out" });
		expect(entries.map((entry) => entry.keyframeId)).toEqual(["a", "b"]);
		expect(entries[0].patch.segmentToNext).toBe("bezier");
		expect(entries[0].patch.rightHandle).toBeTruthy();
		expect(entries[1].patch.leftHandle).toBeTruthy();
	});

	test("applied through the real curve update, the segment matches the easing", () => {
		const entries = planSegmentEasing({ element, keyframes: [ref("a")], easing: "ease-in" });
		const left = getChannel({ animations: element.animations, propertyPath: "opacity" });
		if (!left || !isScalarChannel(left)) throw new Error("no channel");
		const keys = left.keys.map((k) => {
			const patch = entries.find((entry) => entry.keyframeId === k.id)?.patch;
			return patch ? { ...k, segmentToNext: patch.segmentToNext ?? k.segmentToNext, rightHandle: patch.rightHandle ?? k.rightHandle, leftHandle: patch.leftHandle ?? k.leftHandle } : k;
		});
		const expected = getSegmentEasingPatch({ leftKey: left.keys[0], rightKey: left.keys[1], easing: "ease-in" });
		expect(keys[0].rightHandle).toEqual(expected?.rightHandle ?? undefined);
		const slow = resolveAnimationPathValueAtTime({ animations: { opacity: { keys } }, propertyPath: "opacity", localTime: SECOND, fallbackValue: 0 });
		expect(slow).toBeLessThan(0.25);
	});

	test("hold clears the handles and steps", () => {
		const [first] = planSegmentEasing({ element, keyframes: [ref("a")], easing: "hold" });
		expect(first.patch).toMatchObject({ segmentToNext: "step", rightHandle: null });
	});

	test("the last key of a channel has no segment", () => {
		expect(planSegmentEasing({ element, keyframes: [ref("c")], easing: "linear" })).toEqual([]);
	});

	test("a keyframe id the clip does not have is skipped", () => {
		expect(planSegmentEasing({ element, keyframes: [ref("missing")], easing: "linear" })).toEqual([]);
	});

	test("the pair for the curve editor is the key and the one after it", () => {
		expect(getSegmentPairRefs({ element, keyframes: [ref("b")] }).map((r) => r.keyframeId)).toEqual(["b", "c"]);
	});
});
