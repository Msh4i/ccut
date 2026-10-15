import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Transform } from "@/rendering";
import { mediaTime } from "@/wasm";
import type { CameraPinController, CameraPinOutcome } from "../analysis-types";
import { CAMERA_PIN_MESSAGES, type CameraPinRecord } from "../pin-element";
import {
	CAMERA_PIN_NOT_READY_MESSAGE,
	registerCameraPinController,
	resetCameraPinStore,
	useCameraPinStore,
} from "../store";

function pinnedOutcome({ elementId }: { elementId: string }): CameraPinOutcome {
	return {
		status: "pinned",
		elementId,
		notices: [],
		lostFrame: null,
		cutTimes: [],
		mode: "scene",
		model: "S",
	};
}

function record({ elementId }: { elementId: string }): CameraPinRecord {
	return {
		elementId,
		trackId: "track-1",
		analysisId: "analysis-1",
		hostElementId: "host-1",
		mode: "scene",
		model: "S",
		range: { start: mediaTime({ ticks: 0 }), end: mediaTime({ ticks: 120_000 }) },
		host: {
			mediaId: "media-1",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120_000 }),
			trimStart: mediaTime({ ticks: 0 }),
			rate: 1,
		},
	};
}

function fakeController(): CameraPinController & {
	calls: string[];
	looks: unknown[];
} {
	const calls: string[] = [];
	const looks: unknown[] = [];
	return {
		calls,
		looks,
		async stick({ elementId, mode }) {
			calls.push(`stick:${elementId}:${mode ?? "auto"}`);
			return pinnedOutcome({ elementId });
		},
		async repin({ elementId, look }) {
			calls.push(`repin:${elementId}`);
			looks.push(look);
			return pinnedOutcome({ elementId });
		},
		cancel() {
			calls.push("cancel");
		},
	};
}

describe("useCameraPinStore", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	test("without an engine, stick says so and keeps the outcome", async () => {
		const outcome = await useCameraPinStore.getState().stick({ elementId: "e1" });
		expect(outcome).toMatchObject({
			status: "error",
			elementId: "e1",
			message: CAMERA_PIN_NOT_READY_MESSAGE,
		});
		expect(useCameraPinStore.getState().outcomes.e1).toEqual(outcome);
		expect(useCameraPinStore.getState().pins).toEqual({});
	});

	test("without an engine, repin says so too", async () => {
		const outcome = await useCameraPinStore.getState().repin({ elementId: "e1" });
		expect(outcome.status).toBe("error");
	});

	test("with an engine, stick and repin go through it and the outcome is kept", async () => {
		const engine = fakeController();
		registerCameraPinController(engine);
		const look: Transform = {
			scaleX: 1,
			scaleY: 1,
			position: { x: 1, y: 2 },
			rotate: 0,
		};

		const stuck = await useCameraPinStore
			.getState()
			.stick({ elementId: "e1", mode: "object" });
		const again = await useCameraPinStore.getState().repin({ elementId: "e1", look });

		expect(stuck.status).toBe("pinned");
		expect(again.status).toBe("pinned");
		expect(engine.calls).toEqual(["stick:e1:object", "repin:e1"]);
		expect(engine.looks).toEqual([look]);
		expect(useCameraPinStore.getState().outcomes.e1?.status).toBe("pinned");
	});

	test("unregistering the engine brings the not-ready answer back", async () => {
		registerCameraPinController(fakeController());
		registerCameraPinController(null);
		const outcome = await useCameraPinStore.getState().stick({ elementId: "e1" });
		expect(outcome.status).toBe("error");
	});

	test("cancel reaches the engine, and is harmless without one", () => {
		useCameraPinStore.getState().cancel();
		const engine = fakeController();
		registerCameraPinController(engine);
		useCameraPinStore.getState().cancel();
		expect(engine.calls).toEqual(["cancel"]);
	});

	test("recordOutcome keeps the outcome and, when given, the pin", () => {
		const { recordOutcome } = useCameraPinStore.getState();
		recordOutcome({
			outcome: pinnedOutcome({ elementId: "e1" }),
			pin: record({ elementId: "e1" }),
		});
		recordOutcome({
			outcome: { status: "no-keys", elementId: "e2", notices: ["no-texture"], lostFrame: null },
		});

		const state = useCameraPinStore.getState();
		expect(Object.keys(state.pins)).toEqual(["e1"]);
		expect(state.outcomes.e1?.status).toBe("pinned");
		expect(state.outcomes.e2?.status).toBe("no-keys");
	});

	test("forget drops the pin and the outcome of that element only", () => {
		const { recordOutcome, forget } = useCameraPinStore.getState();
		recordOutcome({
			outcome: pinnedOutcome({ elementId: "e1" }),
			pin: record({ elementId: "e1" }),
		});
		recordOutcome({
			outcome: pinnedOutcome({ elementId: "e2" }),
			pin: record({ elementId: "e2" }),
		});

		forget({ elementId: "e1" });

		const state = useCameraPinStore.getState();
		expect(Object.keys(state.pins)).toEqual(["e2"]);
		expect(Object.keys(state.outcomes)).toEqual(["e2"]);
	});

	test("unstick of an element that is not stuck is an error and changes nothing", () => {
		useCameraPinStore.getState().recordOutcome({
			outcome: pinnedOutcome({ elementId: "e2" }),
			pin: record({ elementId: "e2" }),
		});

		const result = useCameraPinStore.getState().unstick({ elementId: "e1" });

		expect(result.status).toBe("error");
		expect(Object.keys(useCameraPinStore.getState().pins)).toEqual(["e2"]);
	});

	test("setJob replaces the job", () => {
		useCameraPinStore
			.getState()
			.setJob({ state: "running", hostElementId: "host-1", progress: 0.4 });
		expect(useCameraPinStore.getState().job).toEqual({
			state: "running",
			hostElementId: "host-1",
			progress: 0.4,
		});
	});
});

describe("useCameraPinStore: which element's run is in flight (slice T4)", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	function deferredController() {
		const resolvers: Array<(outcome: CameraPinOutcome) => void> = [];
		const controller: CameraPinController = {
			stick: () => new Promise<CameraPinOutcome>((resolve) => resolvers.push(resolve)),
			repin: () => new Promise<CameraPinOutcome>((resolve) => resolvers.push(resolve)),
			cancel() {},
		};
		return { controller, resolvers };
	}

	test("starts out as nobody", () => {
		expect(useCameraPinStore.getState().stickingElementId).toBeNull();
	});

	test("is the element from the moment stick is called until it is answered", async () => {
		const { controller, resolvers } = deferredController();
		registerCameraPinController(controller);
		const pending = useCameraPinStore.getState().stick({ elementId: "e1" });
		expect(useCameraPinStore.getState().stickingElementId).toBe("e1");
		resolvers[0]?.(pinnedOutcome({ elementId: "e1" }));
		await pending;
		expect(useCameraPinStore.getState().stickingElementId).toBeNull();
	});

	test("repin counts too", async () => {
		const { controller, resolvers } = deferredController();
		registerCameraPinController(controller);
		const pending = useCameraPinStore.getState().repin({ elementId: "e2" });
		expect(useCameraPinStore.getState().stickingElementId).toBe("e2");
		resolvers[0]?.(pinnedOutcome({ elementId: "e2" }));
		await pending;
		expect(useCameraPinStore.getState().stickingElementId).toBeNull();
	});

	test("without an engine it is cleared again (the not-ready answer is immediate)", async () => {
		await useCameraPinStore.getState().stick({ elementId: "e1" });
		expect(useCameraPinStore.getState().stickingElementId).toBeNull();
	});

	test("a slower, older answer does not clear a newer element's run", async () => {
		const { controller, resolvers } = deferredController();
		registerCameraPinController(controller);
		const first = useCameraPinStore.getState().stick({ elementId: "e1" });
		const second = useCameraPinStore.getState().repin({ elementId: "e2" });
		expect(useCameraPinStore.getState().stickingElementId).toBe("e2");
		resolvers[0]?.(pinnedOutcome({ elementId: "e1" }));
		await first;
		expect(useCameraPinStore.getState().stickingElementId).toBe("e2");
		resolvers[1]?.(pinnedOutcome({ elementId: "e2" }));
		await second;
		expect(useCameraPinStore.getState().stickingElementId).toBeNull();
	});

	test("an engine that throws becomes an apply-failed outcome, not an unhandled rejection", async () => {
		const logged = spyOn(console, "error").mockImplementation(() => {});
		registerCameraPinController({
			async stick() {
				throw new Error("decoder crashed");
			},
			async repin() {
				throw new Error("decoder crashed");
			},
			cancel() {},
		});
		const outcome = await useCameraPinStore.getState().stick({ elementId: "e1" });
		expect(outcome).toMatchObject({
			status: "error",
			elementId: "e1",
			error: "apply-failed",
			// the notice is the app's sentence; the engine's raw message only goes to the log
			message: CAMERA_PIN_MESSAGES["apply-failed"],
		});
		expect(useCameraPinStore.getState().outcomes.e1).toEqual(outcome);
		expect(useCameraPinStore.getState().stickingElementId).toBeNull();
		expect(logged).toHaveBeenCalledTimes(1);
		expect(String(logged.mock.calls[0]?.[1])).toContain("decoder crashed");
		logged.mockRestore();
	});

	test("a busy refusal while a run is in flight is remembered for that run only, and forget drops it", () => {
		const store = () => useCameraPinStore.getState();
		store().setJob({ state: "running", hostElementId: "v", progress: 0 });
		useCameraPinStore.setState({ busyRefusedIds: { e1: true, e2: true } });
		store().forget({ elementId: "e2" });
		expect(store().busyRefusedIds).toEqual({ e1: true });
		store().setJob({ state: "running", hostElementId: "v", progress: 0.5 });
		expect(store().busyRefusedIds).toEqual({ e1: true });
		store().setJob({ state: "idle", hostElementId: null, progress: 0 });
		expect(store().busyRefusedIds).toEqual({});
	});

	test("the not-ready message is plain: it must not read as a placeholder", () => {
		expect(CAMERA_PIN_NOT_READY_MESSAGE).toBe(
			"Stick to scene needs an open project. Reopen the project and try again.",
		);
	});
});
