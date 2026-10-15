/**
 * Bounds an await that has no deadline of its own (decoders, media elements,
 * animation frames) so a caller can carry on without it.
 */

export type TimerId = ReturnType<typeof setTimeout> | number;

export interface DeadlineTimers {
	setTimeout: ({ callback, ms }: { callback: () => void; ms: number }) => TimerId;
	clearTimeout: (id: TimerId) => void;
}

export const realTimers: DeadlineTimers = {
	setTimeout: ({ callback, ms }) => setTimeout(callback, ms),
	clearTimeout: (id) => clearTimeout(id),
};

export type DeadlineResult<T> =
	| { status: "ok"; value: T }
	| { status: "error"; error: unknown }
	| { status: "timeout"; ms: number };

/**
 * Never rejects. After a timeout the work keeps running; its late value goes
 * to `onLate` (so resources such as frames can be released) and a late error
 * is swallowed.
 */
export function withDeadline<T>({
	run,
	ms,
	timers = realTimers,
	onLate,
}: {
	run: () => Promise<T>;
	ms: number;
	timers?: DeadlineTimers;
	onLate?: (value: T) => void;
}): Promise<DeadlineResult<T>> {
	return new Promise((resolve) => {
		let done = false;
		const timer = timers.setTimeout({
			callback: () => {
				if (done) return;
				done = true;
				resolve({ status: "timeout", ms });
			},
			ms,
		});

		let work: Promise<T>;
		try {
			work = run();
		} catch (error) {
			work = Promise.reject(error);
		}

		work.then(
			(value) => {
				if (done) {
					onLate?.(value);
					return;
				}
				done = true;
				timers.clearTimeout(timer);
				resolve({ status: "ok", value });
			},
			(error: unknown) => {
				if (done) return;
				done = true;
				timers.clearTimeout(timer);
				resolve({ status: "error", error });
			},
		);
	});
}
