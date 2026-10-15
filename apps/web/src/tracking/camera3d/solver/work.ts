/**
 * Time slicing for the solver, which runs on the main thread: `checkpoint`
 * is called often from the solver's loops and hands the thread back to the
 * UI (`yieldToUi`) once a slice of work time is used up, and stops the
 * solve when the signal is aborted.
 */

/** Work time between two yields, ms (the brief asks for "about every 30 ms"). */
export const SLICE_MS = 24;

/** Thrown out of a checkpoint when the solve was cancelled; caught by `solveCamera`. */
export class SolveCancelled extends Error {
	constructor() {
		super("camera solve cancelled");
		this.name = "SolveCancelled";
	}
}

export interface Work {
	/** Yields to the UI when the slice is used up; throws {@link SolveCancelled} once aborted. */
	checkpoint(): Promise<void>;
	/** Reports overall progress 0..1 (never goes backwards). */
	progress(fraction: number): void;
	/** Number of yields so far (diagnostics). */
	readonly yields: number;
}

export function createWork({
	yieldToUi,
	now,
	signal,
	onProgress,
	sliceMs = SLICE_MS,
}: {
	yieldToUi: () => Promise<void>;
	now: () => number;
	signal?: AbortSignal;
	onProgress?: (fraction: number) => void;
	sliceMs?: number;
}): Work {
	let sliceStart = now();
	let yields = 0;
	let reported = -1;
	return {
		async checkpoint() {
			if (signal?.aborted) throw new SolveCancelled();
			if (now() - sliceStart < sliceMs) return;
			await yieldToUi();
			yields++;
			sliceStart = now();
			if (signal?.aborted) throw new SolveCancelled();
		},
		progress(fraction) {
			const clamped = Math.max(0, Math.min(1, fraction));
			if (clamped > reported) {
				reported = clamped;
				onProgress?.(clamped);
			}
		},
		get yields() {
			return yields;
		},
	};
}
