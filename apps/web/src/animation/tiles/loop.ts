import type { PresetPhase } from "@/animation/presets";

/** How long a looping tile rests between two plays. */
export const TILE_REST_MS = 700;

function nonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Where a tile is `elapsedMs` after it started playing, as the playback
 * progress `tileFrameAt` takes. A loop plays the phase over `playMs`, then
 * rests `restMs` in the pose the clip rests in (the end of In, the start of
 * Out) and starts again. Played once, it is done at the end of the phase.
 * Broken inputs (0, negative, NaN, Infinity) never give NaN: a phase without
 * length shows the rest pose.
 */
export function tileProgressAt({
	elapsedMs,
	playMs,
	restMs,
	phase,
	repeat,
}: {
	elapsedMs: number;
	playMs: number;
	restMs: number;
	phase: PresetPhase;
	repeat: boolean;
}): { progress: number; isDone: boolean } {
	const restProgress = phase === "in" ? 1 : 0;
	const play = nonNegative(playMs);
	if (play === 0) return { progress: restProgress, isDone: !repeat };

	const elapsed = nonNegative(elapsedMs);
	if (!repeat) {
		return elapsed >= play
			? { progress: 1, isDone: true }
			: { progress: elapsed / play, isDone: false };
	}

	const timeInLoop = elapsed % (play + nonNegative(restMs));
	return {
		progress: timeInLoop < play ? timeInLoop / play : restProgress,
		isDone: false,
	};
}
