/**
 * Shared by every time-based effect definition in this folder. Parameter
 * clamping is identical across all of them; the Nyquist guard enforces the
 * same anti-aliasing discipline that round18's code review caught missing
 * from Shake (see shake.ts for the full writeup) — any effect whose
 * uniforms oscillate with time must keep its worst-case frequency under the
 * slowest export frame rate's Nyquist limit at every point in its Speed
 * range, or the Speed slider stops visibly doing anything at some
 * positions.
 */

export function parseClampedNumberParam({
	effectParams,
	key,
	fallback,
	min,
	max,
}: {
	effectParams: Record<string, unknown>;
	key: string;
	fallback: number;
	min: number;
	max: number;
}): number {
	const raw = effectParams[key];
	const value =
		typeof raw === "number" && Number.isFinite(raw)
			? raw
			: Number.parseFloat(String(raw));
	const resolved = Number.isFinite(value) ? value : fallback;
	return Math.min(Math.max(resolved, min), max);
}

// Not a hard floor: the project rate comes from the first inserted video with
// no minimum (a 15 fps screen recording makes a 15 fps project and export),
// and below 24 fps the fastest Speed settings of the oscillating effects can
// alias. Open item: give effects the project fps and cap their speed by it.
const SLOWEST_SUPPORTED_EXPORT_FPS = 24;

/**
 * Throws at module load if `worstCaseHz` would alias when sampled at the
 * slowest export frame rate this project supports (with the margin baked
 * into `marginFactor` below Nyquist, not just under it — round18's review
 * showed motion visibly weakens well before the exact Nyquist point).
 */
export function assertNyquistSafe({
	effectName,
	worstCaseHz,
	marginFactor = 0.8,
}: {
	effectName: string;
	worstCaseHz: number;
	marginFactor?: number;
}): void {
	const nyquistHz = SLOWEST_SUPPORTED_EXPORT_FPS / 2;
	if (worstCaseHz > nyquistHz * marginFactor) {
		throw new Error(
			`${effectName} effect: worst-case frequency ${worstCaseHz}Hz is too close to the ` +
				`${SLOWEST_SUPPORTED_EXPORT_FPS}fps Nyquist limit (${nyquistHz}Hz) — Speed would stop ` +
				`visibly doing anything at some slider positions`,
		);
	}
}
