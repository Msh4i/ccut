import type { CameraTrackerRunOutcome } from "../session";
import {
	CAMERA_TRACKER_BANNERS,
	type CameraTrackerData,
	type CameraTrackerPhase,
} from "../types";

/**
 * AE's banners over the footage: blue "Analyzing in background (Step 1 of
 * 2)", orange "Solving camera (Step 2 of 2)", the failure message, and the
 * warning banner "Settings changed. Solve again." (unless Hide Warning
 * Banner).
 */
export type BannerModel =
	| {
			kind: "analyzing" | "solving";
			text: string;
			/** 0..100, whole numbers. */
			percent: number;
			elementId: string;
	  }
	| { kind: "failed"; text: string }
	| {
			kind: "stale";
			text: string;
			actionLabel: "Solve" | "Analyze";
			/** `resolve`: solve again from the stored tracks; `track`: analyze again (Detailed Analysis changed). */
			action: "resolve" | "track";
	  };

/** The clip whose data the banner may describe: the selected tracked clip with its Tracking tab open. */
export interface BannerSubject {
	elementId: string;
	data: CameraTrackerData | null;
	outcome?: CameraTrackerRunOutcome;
}

export function progressPercent(progress: number): number {
	if (!Number.isFinite(progress)) return 0;
	return Math.min(100, Math.max(0, Math.round(progress * 100)));
}

/** The stale prompt of stored data, or `null` when it matches its settings. */
export function staleAction(
	data: CameraTrackerData,
): { actionLabel: "Solve" | "Analyze"; action: "resolve" | "track" } | null {
	if (data.stale === "analysis") return { actionLabel: "Analyze", action: "track" };
	if (data.stale === "solve") return { actionLabel: "Solve", action: "resolve" };
	return null;
}

/** The failure to report for a clip: the stored one, else the last run's failed or busy message. */
export function failureText({
	data,
	outcome,
}: {
	data: CameraTrackerData | null;
	outcome?: CameraTrackerRunOutcome;
}): string | null {
	if (data?.failure) return data.failure.message;
	if (outcome?.status === "failed" || outcome?.status === "busy") {
		return outcome.message;
	}
	return null;
}

/**
 * A running job is shown whatever is selected (the job is global and the
 * editor stays usable); otherwise the active clip's stale prompt, then its
 * failure. A stale prompt wins over an older failure: the settings changed
 * since that run.
 */
export function buildBanner({
	phase,
	active,
}: {
	phase: CameraTrackerPhase;
	active: BannerSubject | null;
}): BannerModel | null {
	if (phase.phase === "analyzing" || phase.phase === "solving") {
		return {
			kind: phase.phase,
			text: CAMERA_TRACKER_BANNERS[phase.phase],
			percent: progressPercent(phase.progress),
			elementId: phase.elementId,
		};
	}
	if (!active) return null;
	const { data, outcome } = active;
	if (data && !data.settings.hideWarningBanner) {
		const stale = staleAction(data);
		if (stale) return { kind: "stale", text: CAMERA_TRACKER_BANNERS.stale, ...stale };
	}
	const failure = failureText({ data, outcome });
	return failure ? { kind: "failed", text: failure } : null;
}

/** What the polite live region says: the phase or message, never the percent (no announcement per step). */
export function bannerAnnouncement(banner: BannerModel | null): string {
	return banner ? banner.text : "";
}
