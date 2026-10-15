import { create } from "zustand";
import type { FeatureTracks } from "@/tracking/camera/types";
import type { Target } from "@/scene3d/types";
import type {
	CameraSolve,
	CameraTrackerData,
	CameraTrackerPhase,
	CameraTrackerSettings,
} from "./types";

/**
 * Session side of Track Camera: what the UI reads (phase, progress) and the
 * engine API it calls. The engine (`engine/`, workstream D) registers the
 * implementation with {@link registerCameraTrackerApi} at editor start and
 * reports its phase through {@link useCameraTrackerSession}; the UI
 * (workstream C) never runs analysis or writes the project itself.
 */

/** A tracked clip's stored data, decoded (cached by the engine per stored object). */
export interface DecodedCameraTracker {
	elementId: string;
	data: CameraTrackerData;
	tracks: FeatureTracks | null;
	solve: CameraSolve | null;
	/** Track ids the user deleted, as a set. */
	deleted: ReadonlySet<number>;
}

export type CameraTrackerRunOutcome =
	| { status: "solved"; elementId: string }
	| { status: "failed"; elementId: string; message: string }
	| { status: "cancelled"; elementId: string }
	| { status: "busy"; elementId: string; message: string };

export type CreatableLayerKind = "text" | "solid" | "null" | "image";

export interface CreateTrackedLayersArgs {
	/** The tracked video clip. */
	elementId: string;
	/** `null` = camera only (AE "Create Camera"). */
	kind: CreatableLayerKind | null;
	/** AE "Create Multiple ...": one layer per selected point, trimmed to each point's lifetime. */
	multiple: boolean;
	/** The target the layer goes on (single layer), in the solve's world. */
	target: Target | null;
	/** The selected points (multiple layers, and the plane of the target). */
	trackIds: readonly number[];
	/** Analysis frame the user is on (orientation of the created layer follows this camera). */
	frame: number;
	/** For `image`: the media asset to place. */
	mediaId?: string;
}

export type CreateTrackedLayersOutcome =
	| { status: "created"; elementIds: string[]; cameraElementId: string | null }
	| { status: "failed"; message: string };

export interface CameraTrackerApi {
	/** AE Track Camera / Analyze: analyse (or reuse the stored analysis) and solve. */
	trackCamera(args: { elementId: string }): Promise<CameraTrackerRunOutcome>;
	/** Solve again from the stored 2D tracks (settings changed, points deleted). */
	resolve(args: { elementId: string }): Promise<CameraTrackerRunOutcome>;
	/** Stop the running analysis or solve. */
	cancel(): void;
	/** Change effect controls (one undo step); marks the data stale when a re-solve/re-analysis is needed. */
	updateSettings(args: {
		elementId: string;
		patch: Partial<CameraTrackerSettings>;
	}): void;
	/** AE Delete Selected Points (one undo step). */
	deletePoints(args: { elementId: string; trackIds: readonly number[] }): void;
	/** AE Set Ground Plane and Origin (one undo step, nothing moves on screen). */
	setGroundPlane(args: { elementId: string; target: Target }): void;
	/** AE Create Text / Solid / Null [and Camera], Create Multiple ..., Create Camera (one undo step). */
	createLayers(args: CreateTrackedLayersArgs): CreateTrackedLayersOutcome;
	/** The clip's stored data decoded; `null` when it has none or it is unreadable. */
	decoded(args: { elementId: string }): DecodedCameraTracker | null;
}

let api: CameraTrackerApi | null = null;

/** The engine registers itself here; `null` unregisters (tests, hot reload). */
export function registerCameraTrackerApi(next: CameraTrackerApi | null): void {
	api = next;
}

export function getCameraTrackerApi(): CameraTrackerApi | null {
	return api;
}

export const CAMERA_TRACKER_NOT_READY_MESSAGE =
	"Track Camera needs an open project. Reopen the project and try again.";

export interface CameraTrackerSessionState {
	phase: CameraTrackerPhase;
	/** The last run's outcome per clip, for the banner and the tab. */
	outcomes: Readonly<Record<string, CameraTrackerRunOutcome>>;
	/** Engine only. */
	setPhase(phase: CameraTrackerPhase): void;
	/** Engine only. */
	recordOutcome(outcome: CameraTrackerRunOutcome): void;
	/** Engine/UI: forget a clip's outcome (clip deleted, data cleared). */
	forget(args: { elementId: string }): void;
}

export const useCameraTrackerSession = create<CameraTrackerSessionState>()(
	(set) => ({
		phase: { phase: "idle" },
		outcomes: {},
		setPhase: (phase) => set({ phase }),
		recordOutcome: (outcome) =>
			set((state) => ({
				outcomes: { ...state.outcomes, [outcome.elementId]: outcome },
			})),
		forget: ({ elementId }) =>
			set((state) => {
				if (!(elementId in state.outcomes)) return state;
				const { [elementId]: _removed, ...rest } = state.outcomes;
				return { outcomes: rest };
			}),
	}),
);
