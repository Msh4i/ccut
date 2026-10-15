/** Synthetic test signals (deterministic, no randomness). */

export function sine({
	frequency,
	amplitude,
	seconds,
	sampleRate,
	phase = 0,
}: {
	frequency: number;
	amplitude: number;
	seconds: number;
	sampleRate: number;
	phase?: number;
}): Float32Array {
	const length = Math.round(seconds * sampleRate);
	const out = new Float32Array(length);
	const step = (2 * Math.PI * frequency) / sampleRate;
	for (let i = 0; i < length; i++) {
		out[i] = amplitude * Math.sin(step * i + phase);
	}
	return out;
}

export function silence({
	seconds,
	sampleRate,
	level = 0,
}: {
	seconds: number;
	sampleRate: number;
	level?: number;
}): Float32Array {
	return new Float32Array(Math.round(seconds * sampleRate)).fill(level);
}

export function concat(parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function addConstant({
	signal,
	value,
}: {
	signal: Float32Array;
	value: number;
}): Float32Array {
	return signal.map((sample) => sample + value);
}

/** Pieces of `[kind, seconds]`: "tone" is a 440 Hz sine at amplitude 0.5. */
export function speechPattern({
	pieces,
	sampleRate,
}: {
	pieces: Array<["tone" | "quiet", number]>;
	sampleRate: number;
}): Float32Array {
	return concat(
		pieces.map(([kind, seconds]) =>
			kind === "tone"
				? sine({ frequency: 440, amplitude: 0.5, seconds, sampleRate })
				: silence({ seconds, sampleRate }),
		),
	);
}
