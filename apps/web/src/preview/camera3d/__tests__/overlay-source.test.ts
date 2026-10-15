import { describe, expect, test } from "bun:test";
import { CAMERA_TRACKER_OVERLAY_SOURCE } from "../overlay-source";

describe("Track Camera's preview overlay source", () => {
	test("one viewport-wide instance above the transform handles that lets pointer events through", () => {
		expect(CAMERA_TRACKER_OVERLAY_SOURCE.definitions).toEqual([]);
		expect(CAMERA_TRACKER_OVERLAY_SOURCE.instances).toHaveLength(1);
		const [instance] = CAMERA_TRACKER_OVERLAY_SOURCE.instances;
		expect(instance.id).toBe("camera-tracker");
		expect(instance.mount).toEqual({ kind: "viewport" });
		expect(instance.plane).toBe("over-interaction");
		expect(instance.pointerEvents).toBe("none");
	});
});
