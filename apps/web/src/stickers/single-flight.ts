export interface SingleFlight {
	/**
	 * Runs `task` unless one is already running; then it does nothing and
	 * resolves to undefined. The lock is released when the task settles,
	 * including when it throws.
	 */
	run: <T>(task: () => Promise<T>) => Promise<T | undefined>;
	isRunning: () => boolean;
}

/**
 * Stops a handler from running twice at once (pressing Enter twice on a tile
 * while a slow sticker is still loading would add two elements).
 */
export function createSingleFlight(): SingleFlight {
	let running = false;

	return {
		run: async <T,>(task: () => Promise<T>) => {
			if (running) {
				return undefined;
			}
			running = true;
			try {
				return await task();
			} finally {
				running = false;
			}
		},
		isRunning: () => running,
	};
}
