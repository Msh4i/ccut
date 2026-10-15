import { beforeEach, describe, expect, test } from "bun:test";
import { useCameraPointsStore } from "../points-store";

describe("track points UI state", () => {
	beforeEach(() => useCameraPointsStore.getState().clear());

	test("selecting sets the clip and the ids; a new selection drops a dragged target centre", () => {
		const store = useCameraPointsStore.getState();
		store.select({ elementId: "v", selection: [1, 2, 3] });
		store.moveTarget({ center: [1, 2, 3] });
		expect(useCameraPointsStore.getState()).toMatchObject({ elementId: "v", selection: [1, 2, 3], centerOverride: [1, 2, 3] });
		store.select({ elementId: "v", selection: [1, 2] });
		expect(useCameraPointsStore.getState().centerOverride).toBeNull();
	});

	test("the same selection again keeps the dragged centre", () => {
		const store = useCameraPointsStore.getState();
		store.select({ elementId: "v", selection: [4, 5] });
		store.moveTarget({ center: [9, 9, 9] });
		store.select({ elementId: "v", selection: [4, 5] });
		expect(useCameraPointsStore.getState().centerOverride).toEqual([9, 9, 9]);
	});

	test("selectionFor ignores another clip's selection", () => {
		const store = useCameraPointsStore.getState();
		store.select({ elementId: "v", selection: [7] });
		expect(useCameraPointsStore.getState().selectionFor({ elementId: "v" })).toEqual([7]);
		expect(useCameraPointsStore.getState().selectionFor({ elementId: "w" })).toEqual([]);
	});

	test("resetTargetCenter keeps the selection and drops the dragged centre", () => {
		const store = useCameraPointsStore.getState();
		store.select({ elementId: "v", selection: [3] });
		store.moveTarget({ center: [1, 1, 1] });
		store.resetTargetCenter();
		expect(useCameraPointsStore.getState()).toMatchObject({ selection: [3], centerOverride: null });
	});

	test("clear forgets everything", () => {
		const store = useCameraPointsStore.getState();
		store.select({ elementId: "v", selection: [7] });
		store.clear();
		expect(useCameraPointsStore.getState()).toMatchObject({ elementId: null, selection: [], centerOverride: null });
	});
});
