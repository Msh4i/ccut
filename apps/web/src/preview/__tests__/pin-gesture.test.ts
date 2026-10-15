/**
 * The decisions of dragging, scaling and turning a stuck element (slice T4,
 * plan section c "Surukleme/tutamac"): the five pin channels are lifted for the
 * gesture so the element follows the cursor, and on release it is stuck again.
 */
import { describe, expect, test } from "bun:test";
import { hasKeyframesForPath } from "@/animation";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import { mediaTimeFromSeconds } from "@/wasm";
import { PIN_PROPERTY_PATHS, planPinGesture, planPinRelease, withoutPinChannels } from "../controllers/pin-gesture";

function key({ id, seconds, value }: { id: string; seconds: number; value: number }): ScalarAnimationKey {
	return {
		id,
		time: mediaTimeFromSeconds({ seconds }),
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

const PIN_ANIMATIONS: ElementAnimations = {
	"transform.positionX": { keys: [key({ id: "x0", seconds: 0, value: 0 }), key({ id: "x1", seconds: 1, value: 40 })] },
	"transform.positionY": { keys: [key({ id: "y0", seconds: 0, value: 0 }), key({ id: "y1", seconds: 1, value: -8 })] },
	"transform.scaleX": { keys: [key({ id: "sx0", seconds: 0, value: 1 }), key({ id: "sx1", seconds: 1, value: 1.2 })] },
	"transform.scaleY": { keys: [key({ id: "sy0", seconds: 0, value: 1 }), key({ id: "sy1", seconds: 1, value: 1.2 })] },
	"transform.rotate": { keys: [key({ id: "r0", seconds: 0, value: 0 }), key({ id: "r1", seconds: 1, value: 5 })] },
	opacity: { keys: [key({ id: "o0", seconds: 0, value: 1 }), key({ id: "o1", seconds: 1, value: 0.5 })] },
};

describe("withoutPinChannels", () => {
	test("the pin writes exactly these five channels", () => {
		expect([...PIN_PROPERTY_PATHS].sort()).toEqual([
			"transform.positionX",
			"transform.positionY",
			"transform.rotate",
			"transform.scaleX",
			"transform.scaleY",
		]);
	});

	test("lifts all five and leaves every other channel alone", () => {
		const result = withoutPinChannels({ animations: PIN_ANIMATIONS });
		for (const propertyPath of PIN_PROPERTY_PATHS) {
			expect(hasKeyframesForPath({ animations: result, propertyPath })).toBe(false);
		}
		expect(hasKeyframesForPath({ animations: result, propertyPath: "opacity" })).toBe(true);
		expect(result?.opacity).toEqual(PIN_ANIMATIONS.opacity);
	});

	test("does not touch the animations it was given", () => {
		const before = JSON.stringify(PIN_ANIMATIONS);
		withoutPinChannels({ animations: PIN_ANIMATIONS });
		expect(JSON.stringify(PIN_ANIMATIONS)).toBe(before);
	});

	test("an element with no animations stays without", () => {
		expect(withoutPinChannels({ animations: undefined })).toBeUndefined();
	});
});

describe("planPinGesture", () => {
	test("a stuck element gets its channels lifted for the gesture", () => {
		const plan = planPinGesture({ animations: PIN_ANIMATIONS, isPinned: true });
		expect(plan.isPinned).toBe(true);
		expect(hasKeyframesForPath({ animations: plan.animationsWithoutPin, propertyPath: "transform.scaleX" })).toBe(false);
	});

	test("an element that is not stuck is not touched: its animations come back as they are", () => {
		const plan = planPinGesture({ animations: PIN_ANIMATIONS, isPinned: false });
		expect(plan.isPinned).toBe(false);
		expect(plan.animationsWithoutPin).toBe(PIN_ANIMATIONS);
	});
});

describe("planPinRelease (what to do when the pointer comes up)", () => {
	test("nothing stuck among the dragged: commit as always", () => {
		expect(planPinRelease({ total: 1, pinned: 0 })).toBe("commit");
		expect(planPinRelease({ total: 3, pinned: 0 })).toBe("commit");
	});

	test("everything dragged is stuck: drop the preview, stick again (one undo step)", () => {
		expect(planPinRelease({ total: 1, pinned: 1 })).toBe("repin");
		expect(planPinRelease({ total: 2, pinned: 2 })).toBe("repin");
	});

	test("a mix: put the stuck ones back, commit the rest, then stick the stuck ones again", () => {
		expect(planPinRelease({ total: 3, pinned: 1 })).toBe("restore-commit-repin");
	});
});
