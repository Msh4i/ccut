/** Resolves with the promise's value, or `{ timedOut: true }` after `ms`. */
export async function raceWithTimeout<T>({
	promise,
	ms,
}: {
	promise: Promise<T>;
	ms: number;
}): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), ms);
	});

	try {
		return await Promise.race([
			promise.then((value) => ({ timedOut: false as const, value })),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}
}
