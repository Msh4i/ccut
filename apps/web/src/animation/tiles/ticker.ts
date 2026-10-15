export type FrameListener = (now: number) => void;

export interface FrameTicker {
	/** Calls `listener` once per display frame until the returned function is called. */
	subscribe: (listener: FrameListener) => () => void;
}

/**
 * One frame loop for every preview tile: a single requestAnimationFrame per
 * display frame however many tiles animate, and none at all while no tile
 * does (the last unsubscribe cancels the pending frame).
 */
export function createFrameTicker({
	requestFrame,
	cancelFrame,
}: {
	requestFrame: (callback: FrameListener) => number;
	cancelFrame: (handle: number) => void;
}): FrameTicker {
	const listeners = new Set<FrameListener>();
	let handle: number | null = null;

	const onFrame = (now: number) => {
		handle = null;
		if (listeners.size > 0) handle = requestFrame(onFrame);
		for (const listener of [...listeners]) {
			// A listener removed by an earlier one in this frame does not run.
			if (!listeners.has(listener)) continue;
			try {
				listener(now);
			} catch (error) {
				// Dropped, so a broken tile stops (and is reported once) instead
				// of failing on every frame; the other tiles keep running.
				listeners.delete(listener);
				console.error("An animation tile stopped after an error:", error);
			}
		}
		if (listeners.size === 0 && handle !== null) {
			cancelFrame(handle);
			handle = null;
		}
	};

	return {
		subscribe: (listener) => {
			listeners.add(listener);
			if (handle === null) handle = requestFrame(onFrame);
			return () => {
				if (!listeners.delete(listener)) return;
				if (listeners.size === 0 && handle !== null) {
					cancelFrame(handle);
					handle = null;
				}
			};
		},
	};
}

const NEVER_TICKS: FrameTicker = { subscribe: () => () => {} };
let sharedTicker: FrameTicker | null = null;

/** The ticker every tile shares. Without requestAnimationFrame (a server render) it never ticks. */
export function getTileTicker(): FrameTicker {
	if (typeof requestAnimationFrame !== "function") return NEVER_TICKS;
	sharedTicker ??= createFrameTicker({
		requestFrame: (callback) => requestAnimationFrame(callback),
		cancelFrame: (handle) => cancelAnimationFrame(handle),
	});
	return sharedTicker;
}
