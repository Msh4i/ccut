/**
 * A virtual clock for the playback simulation: timers fire in virtual time,
 * and every promise reaction runs before the clock moves on.
 */

type ScheduledEvent = { at: number; order: number; run: () => void };

/** Lets every queued promise reaction run (a macrotask runs after all of them). */
export function drainMicrotasks(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

export class VirtualClock {
	now = 0;
	private events: ScheduledEvent[] = [];
	private order = 0;

	at({ time, run }: { time: number; run: () => void }): void {
		this.order += 1;
		this.events.push({ at: Math.max(time, this.now), order: this.order, run });
	}

	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.at({ time: this.now + ms, run: resolve });
		});
	}

	pending(): number {
		return this.events.length;
	}

	/**
	 * Runs events in time order up to `time` (ms). `maxEvents` bounds the run.
	 * `observe` is called after every event, once the promise reactions it
	 * started have run (a sample of the state between two events).
	 */
	async runUntil({
		time,
		maxEvents,
		observe,
	}: {
		time: number;
		maxEvents: number;
		observe?: () => void;
	}): Promise<void> {
		for (let step = 0; step < maxEvents; step++) {
			await drainMicrotasks();
			observe?.();
			let nextIndex = -1;
			for (let index = 0; index < this.events.length; index++) {
				const candidate = this.events[index];
				const best = nextIndex >= 0 ? this.events[nextIndex] : null;
				if (
					!best ||
					candidate.at < best.at ||
					(candidate.at === best.at && candidate.order < best.order)
				) {
					nextIndex = index;
				}
			}
			const next = nextIndex >= 0 ? this.events[nextIndex] : null;
			if (!next || next.at > time) {
				this.now = time;
				await drainMicrotasks();
				return;
			}
			this.events.splice(nextIndex, 1);
			this.now = next.at;
			next.run();
		}
		throw new Error(`simulation did not reach ${time} ms within ${maxEvents} events`);
	}
}
