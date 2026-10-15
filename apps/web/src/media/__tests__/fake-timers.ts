import type { DeadlineTimers } from "../deadline";

/** A manual clock: timers only fire when the test calls `advance`. */
export function createFakeTimers(): DeadlineTimers & {
	advance: (ms: number) => void;
	pending: () => number;
} {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();

	return {
		setTimeout: ({ callback, ms }) => {
			const id = nextId++;
			timers.set(id, { at: now + Math.max(0, ms), fn: callback });
			return id;
		},
		clearTimeout: (id) => {
			if (typeof id === "number") timers.delete(id);
		},
		advance: (ms) => {
			now += ms;
			const due = [...timers.entries()]
				.filter(([, timer]) => timer.at <= now)
				.sort((a, b) => a[1].at - b[1].at);
			for (const [id, timer] of due) {
				if (typeof id === "number") timers.delete(id);
				timer.fn();
			}
		},
		pending: () => timers.size,
	};
}

/** Lets queued promise reactions run. */
export async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 50; i++) {
		await Promise.resolve();
	}
}
