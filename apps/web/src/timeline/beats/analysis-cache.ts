/**
 * One analysis per source media, so re-running on a cleared or duplicated clip
 * is instant. Failures are dropped so they can be retried. Analyses that a
 * cancelled job left running (a browser decode cannot be interrupted) are
 * tracked so the caller can wait for them instead of starting a second
 * decode of the same file.
 */
export function createAnalysisCache<T extends { ok: boolean }>() {
	const entries = new Map<string, Promise<T>>();
	const abandoned = new Set<Promise<T>>();

	return {
		run({
			key,
			signal,
			start,
		}: {
			key: string;
			signal: AbortSignal;
			start: () => Promise<T>;
		}): Promise<T> {
			const cached = entries.get(key);
			if (cached) {
				return cached;
			}

			let settled = false;
			const pending = start().then(
				(analysis) => {
					settled = true;
					if (!analysis.ok) entries.delete(key);
					return analysis;
				},
				(error) => {
					settled = true;
					entries.delete(key);
					throw error;
				},
			);
			entries.set(key, pending);

			// A cancelled job must not hand its unfinished analysis to the next job.
			signal.addEventListener(
				"abort",
				() => {
					if (settled) return;
					if (entries.get(key) === pending) entries.delete(key);
					abandoned.add(pending);
					const forget = () => abandoned.delete(pending);
					pending.then(forget, forget);
				},
				{ once: true },
			);
			return pending;
		},

		/** Settles once everything a cancelled job left running has finished. */
		async idle(): Promise<void> {
			await Promise.allSettled([...abandoned]);
		},
	};
}
