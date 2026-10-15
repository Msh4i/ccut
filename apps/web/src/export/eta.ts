/** Speed is measured over the last few seconds, so a slow or fast stretch shows soon (frames slower than that: the last two). */
export const ETA_WINDOW_SECONDS = 3;
/** Before this many frames and seconds the speed says nothing yet ("estimating"). */
export const ETA_MIN_FRAMES = 30;
export const ETA_MIN_SECONDS = 2;

type Sample = { ms: number; frames: number };

/**
 * Time left of an export from the frames encoded so far. `update` returns the
 * seconds left, or null while there is nothing honest to show: too early, no
 * progress in the window, or nonsense input. `now` is injected for tests.
 */
export function createEtaEstimator({ now = () => performance.now() }: { now?: () => number } = {}) {
	const samples: Sample[] = [];
	let startMs: number | null = null;

	return {
		update({ framesDone, frameCount }: { framesDone: number; frameCount: number }): number | null {
			if (!Number.isFinite(framesDone) || !Number.isFinite(frameCount) || framesDone < 0 || frameCount <= 0) {
				return null;
			}
			const ms = now();
			startMs ??= ms;
			if (framesDone >= frameCount) return 0;

			samples.push({ ms, frames: framesDone });
			const windowStart = ms - ETA_WINDOW_SECONDS * 1000;
			// Keep one sample at or before the window start, so the window is fully covered.
			while (samples.length > 2 && samples[1].ms <= windowStart) samples.shift();

			if (framesDone < ETA_MIN_FRAMES || ms - startMs < ETA_MIN_SECONDS * 1000) return null;
			// The window is the span from the sample at its start to now. When frames are so slow that
			// the window holds fewer than two samples, that span is meaningless (it would reach back
			// further than twice the window): the last two samples are the speed then.
			const first = ms - samples[0].ms > ETA_WINDOW_SECONDS * 2 * 1000 ? samples[samples.length - 2] : samples[0];
			const seconds = (ms - first.ms) / 1000;
			const frames = framesDone - first.frames;
			if (seconds <= 0 || frames <= 0) return null;
			return (frameCount - framesDone) / (frames / seconds);
		},
	};
}
