/** How long a failed export waits for `Output.cancel()` before it gives up and reports the real error. */
const CANCEL_TIMEOUT_MS = 3000;

/**
 * Cancels a mediabunny `Output` after a failure and never throws: the error
 * that made the export fail is what the user has to see, not a second one from
 * the clean-up. A cancel that fails, or that does not finish in `timeoutMs`
 * (mediabunny 1.41.0 can wait for an encoder call that never returns), is
 * reported with `console.warn` as a possible leaked encoder worker.
 */
export async function cancelOutputQuietly({
	output,
	timeoutMs = CANCEL_TIMEOUT_MS,
	startTimeout = ({ ms, onTimeout }) => {
		const handle = setTimeout(onTimeout, ms);
		return () => clearTimeout(handle);
	},
	warn = (...args) => console.warn(...args),
}: {
	output: { cancel: () => Promise<unknown> };
	timeoutMs?: number;
	startTimeout?: (args: { ms: number; onTimeout: () => void }) => () => void;
	warn?: (...args: unknown[]) => void;
}): Promise<void> {
	let stopTimer: () => void = () => {};
	const timedOut = new Promise<"timeout">((resolve) => {
		stopTimer = startTimeout({ ms: timeoutMs, onTimeout: () => resolve("timeout") });
	});
	const cancelled = (async () => {
		try {
			await output.cancel();
		} catch (error) {
			warn("output.cancel failed (possible leaked encoder worker)", error);
		}
		return "done" as const;
	})();

	try {
		if ((await Promise.race([cancelled, timedOut])) === "timeout") {
			warn(`output.cancel did not finish within ${timeoutMs} ms (possible leaked encoder worker)`);
		}
	} finally {
		stopTimer();
	}
}
