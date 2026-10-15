import { realTimers, withDeadline, type DeadlineTimers } from "./deadline";

/**
 * Animation frames do not run while the window is hidden (minimised,
 * backgrounded, occluded), so a bare double `requestAnimationFrame` can hold
 * an import forever. The paint is only a courtesy for the loading toast.
 */
export const NEXT_PAINT_FALLBACK_MS = 250;

export async function waitForNextPaint({
	requestFrame = (callback) => {
		requestAnimationFrame(() => callback());
	},
	timers = realTimers,
}: {
	requestFrame?: (callback: () => void) => void;
	timers?: DeadlineTimers;
} = {}): Promise<void> {
	await withDeadline({
		run: () =>
			new Promise<void>((resolve) => {
				requestFrame(() => requestFrame(() => resolve()));
			}),
		ms: NEXT_PAINT_FALLBACK_MS,
		timers,
	});
}
