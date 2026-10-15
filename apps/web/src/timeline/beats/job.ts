import { getClipsSourceRangeSeconds } from "./resolve";
import { abortable, isAbortError } from "@/services/beat-detection/abort";
import type { MediaTime } from "@/wasm";
import {
	summarizeBeatRun,
	type BeatFailureReason,
	type BeatSourceOutcome,
} from "./run-summary";
import type { StemStage } from "./stem-samples";
import type { BeatTarget } from "./targets";

export type SourceAnalysis =
	| { ok: true; beats: MediaTime[]; /** Absent for hits: they have no tempo. */ bpm?: number }
	| { ok: false; reason: BeatFailureReason };

export type BeatJobStatus =
	| { phase: "reading" | "repairing"; source: number; sources: number }
	| { phase: "installing" | "separating"; source: number; sources: number; percent: number }
	| { phase: "detecting"; source: number; sources: number; percent: number };

export type BeatJobUpdate = {
	trackId: string;
	elementId: string;
	beats: MediaTime[];
};

export type BeatJobResult =
	| { kind: "done"; summary: ReturnType<typeof summarizeBeatRun> }
	| { kind: "cancelled" }
	| { kind: "stale" };

/**
 * Analyses each distinct source of `targets` in turn, then hands every clip's
 * beats to `commit` in one call (one undo step). Cancelling returns at once
 * and commits nothing, even when the decode underneath cannot be interrupted.
 * A source that fails is reported, it does not stop the others. An error from
 * `commit` itself is not swallowed.
 */
export async function runBeatJob({
	targets,
	signal,
	analyse,
	onStatus,
	isCurrent,
	exists,
	commit,
}: {
	targets: BeatTarget[];
	signal: AbortSignal;
	analyse: (args: {
		target: BeatTarget;
		/** The source seconds all clips of this media play: only this part needs separating. */
		sourceRange: { startSeconds: number; endSeconds: number };
		signal: AbortSignal;
		onProgress: (fraction: number) => void;
		/** Preparing the audio (installing the separator, reading, separating) before detecting. */
		onStage: (stage: StemStage) => void;
	}) => Promise<SourceAnalysis>;
	onStatus: (status: BeatJobStatus) => void;
	/** False when the project changed since the job started. */
	isCurrent: () => boolean;
	/** False when the clip was deleted or moved to another track meanwhile. */
	exists: (clip: { trackId: string; elementId: string }) => boolean;
	commit: (updates: BeatJobUpdate[]) => void;
}): Promise<BeatJobResult> {
	const clipsBySource = new Map<string, BeatTarget[]>();
	for (const target of targets) {
		clipsBySource.set(target.sourceKey, [
			...(clipsBySource.get(target.sourceKey) ?? []),
			target,
		]);
	}

	try {
		const results: Array<{ clips: BeatTarget[]; analysis: SourceAnalysis }> = [];
		for (const clips of clipsBySource.values()) {
			signal.throwIfAborted();
			const position = { source: results.length + 1, sources: clipsBySource.size };
			onStatus({ phase: "reading", ...position });

			let lastPercent = -1;
			let analysis: SourceAnalysis;
			try {
				analysis = await abortable({
					promise: analyse({
						target: clips[0],
						sourceRange: getClipsSourceRangeSeconds({
							elements: clips.map((clip) => clip.element),
						}),
						signal,
						onProgress: (fraction) => {
							const percent = Math.floor(fraction * 100);
							if (signal.aborted || percent === lastPercent) return;
							lastPercent = percent;
							onStatus({ phase: "detecting", ...position, percent });
						},
						onStage: (stage) => {
							if (signal.aborted) return;
							onStatus(
								stage.kind === "reading" || stage.kind === "repairing"
									? { phase: stage.kind, ...position }
									: { phase: stage.kind, ...position, percent: stage.percent },
							);
						},
					}),
					signal,
				});
			} catch (error) {
				if (isAbortError(error)) throw error;
				console.error("Beat detection failed:", error);
				analysis = { ok: false, reason: "failed" };
			}
			results.push({ clips, analysis });
		}

		if (!isCurrent()) {
			return { kind: "stale" };
		}
		signal.throwIfAborted();

		// Clips can be deleted or moved while the audio is being analysed: only
		// the ones still in place get beats and count towards the result.
		const remaining = results
			.map(({ clips, analysis }) => ({
				clips: clips.filter((clip) =>
					exists({ trackId: clip.trackId, elementId: clip.element.id }),
				),
				analysis,
			}))
			.filter(({ clips }) => clips.length > 0);
		if (remaining.length === 0) {
			return { kind: "stale" };
		}

		const updates = remaining.flatMap(({ clips, analysis }) =>
			analysis.ok
				? clips.map((clip) => ({
						trackId: clip.trackId,
						elementId: clip.element.id,
						beats: analysis.beats,
					}))
				: [],
		);
		if (updates.length > 0) {
			commit(updates);
		}

		return {
			kind: "done",
			summary: summarizeBeatRun({
				sources: remaining.map(({ clips, analysis }): BeatSourceOutcome =>
					analysis.ok
						? {
								ok: true,
								beatCount: analysis.beats.length,
								bpm: analysis.bpm,
								clipCount: clips.length,
							}
						: { ok: false, reason: analysis.reason, clipCount: clips.length },
				),
			}),
		};
	} catch (error) {
		if (isAbortError(error)) {
			return { kind: "cancelled" };
		}
		throw error;
	}
}
