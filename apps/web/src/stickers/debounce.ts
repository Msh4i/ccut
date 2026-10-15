export interface Debouncer<Args extends unknown[]> {
	/** Schedules `callback` with these arguments, replacing any call still waiting. */
	call: (...args: Args) => void;
	/** Drops the call that is waiting (the panel was closed). */
	cancel: () => void;
	/** Runs the waiting call now, if there is one. */
	flush: () => void;
}

/**
 * Runs `callback` once the calls have been quiet for `delayMs`. Typing in the
 * picker's search box calls it on every key; the search runs after the pause.
 */
export function createDebouncer<Args extends unknown[]>({
	callback,
	delayMs,
}: {
	callback: (...args: Args) => void;
	delayMs: number;
}): Debouncer<Args> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingArgs: Args | null = null;

	const clear = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pendingArgs = null;
	};

	return {
		call: (...args) => {
			if (timer !== null) {
				clearTimeout(timer);
			}
			pendingArgs = args;
			timer = setTimeout(() => {
				const run = pendingArgs;
				clear();
				if (run) callback(...run);
			}, delayMs);
		},
		cancel: clear,
		flush: () => {
			const run = pendingArgs;
			clear();
			if (run) callback(...run);
		},
	};
}
