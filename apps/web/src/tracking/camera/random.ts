/**
 * Seeded randomness for the solver's RANSAC draws and for the synthetic
 * sequences. The same seed always gives the same stream, on every machine.
 */

/** mulberry32: uniform values in [0, 1). */
export function createRng({ seed }: { seed: number }): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Standard normal sample (Box-Muller, one value per call). */
export function gaussianSample({ random }: { random: () => number }): number {
	let u = random();
	// log(0) would be -Infinity; a stream that keeps returning 0 gets the smallest positive number
	for (let attempt = 0; attempt < 8 && u === 0; attempt++) u = random();
	if (u === 0) u = Number.MIN_VALUE;
	const v = random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
