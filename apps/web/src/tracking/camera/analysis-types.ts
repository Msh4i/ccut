import type { Transform } from "@/rendering";
import type { PinFailure, PinModeChoice } from "./pin-element";
import type { CameraNoticeKind, PinMode, PinModel } from "./types";

/**
 * The contract between the engine (slice T2: analysis job, Worker, cache,
 * orchestration) and the UI (slice T4: "Stick to scene" section, preview chip).
 * Types only: the UI reads `useCameraPinStore` (store.ts) and calls its actions;
 * the engine registers a {@link CameraPinController} that does the real work.
 */

/** The one analysis run that can be in flight. They are expensive, so one at a time. */
export interface CameraAnalysisJob {
	state: "idle" | "running";
	/** The video clip being analysed, or null when idle. */
	hostElementId: string | null;
	/** 0..1 of the frames this run will read. */
	progress: number;
}

export const IDLE_CAMERA_JOB: CameraAnalysisJob = {
	state: "idle",
	hostElementId: null,
	progress: 0,
};

/** What a stick (or re-stick) came to, for the section and the chip to show. */
export type CameraPinOutcome =
	| {
			status: "pinned";
			elementId: string;
			/** Kinds only: a cut's time is `cutTimes`, a loss's frame `lostFrame`. */
			notices: CameraNoticeKind[];
			/** The analysis frame tracking was first lost at (nearest the pin), when it was. */
			lostFrame: number | null;
			/** Timeline seconds of the scene cuts that end the pin. */
			cutTimes: number[];
			mode: PinMode;
			model: PinModel;
	  }
	/** The analysis says there is nothing to stick to (no texture, no motion): no keys were written. */
	| {
			status: "no-keys";
			elementId: string;
			notices: CameraNoticeKind[];
			lostFrame: number | null;
	  }
	/** The user cancelled the analysis; the element is untouched. */
	| { status: "cancelled"; elementId: string }
	| (PinFailure & { elementId: string });

/** What the engine provides. The UI never calls the analysis directly. */
export interface CameraPinController {
	/** Stick an element to the scene: find the video under it, analyse it (or reuse a cached analysis), solve, write the keys. */
	stick(args: { elementId: string; mode?: PinModeChoice }): Promise<CameraPinOutcome>;
	/**
	 * Re-solve a stuck element from the SAME analysis (instant) after the user moved,
	 * scaled or rotated it. `look` is its transform as the user left it.
	 */
	repin(args: { elementId: string; look?: Transform }): Promise<CameraPinOutcome>;
	/** Stop the running analysis, if any. */
	cancel(): void;
}
