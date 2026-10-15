export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Settles with `promise`, or rejects with the signal's `AbortError` the moment
 * it aborts. The promise itself keeps running; its late result is ignored.
 */
export function abortable<T>({
	promise,
	signal,
}: {
	promise: Promise<T>;
	signal: AbortSignal;
}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			// `promise` may reject later: attach a handler so it is not unhandled.
			promise.catch(() => {});
			reject(signal.reason);
			return;
		}
		const handleAbort = () => reject(signal.reason);
		signal.addEventListener("abort", handleAbort, { once: true });
		promise
			.finally(() => signal.removeEventListener("abort", handleAbort))
			.then(resolve, reject);
	});
}
