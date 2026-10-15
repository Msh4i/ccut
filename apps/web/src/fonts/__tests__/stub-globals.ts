/** Installs globals for one test and returns a function that puts the originals back. */
export function stubGlobals({
	stubs,
}: {
	stubs: Record<string, unknown>;
}): () => void {
	const originals = Object.keys(stubs).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	Object.assign(globalThis, stubs);

	return () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}
