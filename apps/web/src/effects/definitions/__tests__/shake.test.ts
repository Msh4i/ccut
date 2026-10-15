import { describe, expect, test } from "bun:test";
import { computeShakeOffsetPx, shakeEffectDefinition } from "../shake";

// durationSeconds: 0 disables the start-of-effect ramp (see rampInFactor in
// shake.ts), so these tests see the raw, unramped waveform unless they are
// specifically testing the ramp.
const NO_RAMP = 0;

describe("computeShakeOffsetPx", () => {
	test("zero intensity never moves the frame", () => {
		for (const t of [0, 0.1, 1, 3.7, 10]) {
			const offset = computeShakeOffsetPx({
				intensity: 0,
				speed: 1,
				localTimeSeconds: t,
				durationSeconds: NO_RAMP,
				referenceSize: 1080,
			});
			expect(offset.x).toBeCloseTo(0, 10);
			expect(offset.y).toBeCloseTo(0, 10);
		}
	});

	test("same inputs always produce the same offset (preview must match export)", () => {
		const args = {
			intensity: 65,
			speed: 1.4,
			localTimeSeconds: 2.345,
			durationSeconds: NO_RAMP,
			referenceSize: 1080,
		};
		expect(computeShakeOffsetPx(args)).toEqual(computeShakeOffsetPx(args));
	});

	test("offset is non-zero and keeps changing over time at full intensity", () => {
		const referenceSize = 1080;
		const samples = [0.1, 0.2, 0.35, 0.5, 0.8, 1.3].map((t) =>
			computeShakeOffsetPx({
				intensity: 100,
				speed: 1,
				localTimeSeconds: t,
				durationSeconds: NO_RAMP,
				referenceSize,
			}),
		);
		for (const offset of samples) {
			expect(Math.hypot(offset.x, offset.y)).toBeGreaterThan(1);
		}
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).not.toEqual(samples[i - 1]);
		}
	});

	test("offset stays within the amplitude budget for the reference size", () => {
		const referenceSize = 1080;
		for (let t = 0; t < 5; t += 0.05) {
			const offset = computeShakeOffsetPx({
				intensity: 100,
				speed: 1,
				localTimeSeconds: t,
				durationSeconds: NO_RAMP,
				referenceSize,
			});
			// 0.03 fraction, two weighted sine terms summing to at most 1.0 in magnitude
			const maxAmplitude = 0.03 * referenceSize;
			expect(Math.abs(offset.x)).toBeLessThanOrEqual(maxAmplitude + 1e-9);
			expect(Math.abs(offset.y)).toBeLessThanOrEqual(maxAmplitude + 1e-9);
		}
	});

	test("higher speed moves through the same waveform faster", () => {
		const slow = computeShakeOffsetPx({
			intensity: 50,
			speed: 1,
			localTimeSeconds: 1,
			durationSeconds: NO_RAMP,
			referenceSize: 1080,
		});
		const fast = computeShakeOffsetPx({
			intensity: 50,
			speed: 2,
			localTimeSeconds: 0.5,
			durationSeconds: NO_RAMP,
			referenceSize: 1080,
		});
		expect(fast).toEqual(slow);
	});

	test("ramps in from exactly zero instead of jumping at the first frame", () => {
		const durationSeconds = 2;
		const atStart = computeShakeOffsetPx({
			intensity: 100,
			speed: 1,
			localTimeSeconds: 0,
			durationSeconds,
			referenceSize: 1080,
		});
		expect(atStart.x).toBe(0);
		expect(atStart.y).toBe(0);

		// Well past the 0.15s ramp window, the full (unramped) waveform applies.
		const afterRamp = computeShakeOffsetPx({
			intensity: 100,
			speed: 1,
			localTimeSeconds: 0.5,
			durationSeconds,
			referenceSize: 1080,
		});
		const unramped = computeShakeOffsetPx({
			intensity: 100,
			speed: 1,
			localTimeSeconds: 0.5,
			durationSeconds: NO_RAMP,
			referenceSize: 1080,
		});
		expect(afterRamp).toEqual(unramped);
	});

	test("no slider position lets 24fps export sample either axis down to a near-freeze", () => {
		// Regression test for the round18 code review: at the old frequency
		// constants, speed=2 at 24fps put the x term's frequency at exactly
		// 12 Hz (= 24fps Nyquist), aliasing just that axis to near-zero
		// motion — a sharp trough on one axis at one particular slider
		// position, invisible if you only look at combined x/y motion
		// because the other axis kept moving. So this measures x and y
		// deltas separately. A slower speed is expected to produce smaller
		// per-frame steps than a faster one (it moves through the same
		// waveform more slowly), so the signal to check for is a dip
		// relative to neighbouring speeds, not an absolute floor.
		const referenceSize = 1080;
		const fps = 24;
		const frameCount = 192; // 8 seconds, past the ramp window
		// Integer-indexed, not accumulated, so it lands on exact values —
		// 0.15 .. 2.10, a little past SPEED_MIN/SPEED_MAX on both ends so
		// the dip check below has real neighbours even right at the slider's
		// own boundaries (0.25 and 2.00 land on interior samples, not the
		// first/last one).
		const speeds: number[] = [];
		for (let i = 0; i <= 39; i++) {
			speeds.push(Math.round((0.15 + i * 0.05) * 100) / 100);
		}

		function meanAbsDeltaPerAxis(speed: number): { x: number; y: number } {
			let totalDeltaX = 0;
			let totalDeltaY = 0;
			let previous = computeShakeOffsetPx({
				intensity: 100,
				speed,
				localTimeSeconds: 0,
				durationSeconds: NO_RAMP,
				referenceSize,
			});
			for (let frame = 1; frame <= frameCount; frame++) {
				const current = computeShakeOffsetPx({
					intensity: 100,
					speed,
					localTimeSeconds: frame / fps,
					durationSeconds: NO_RAMP,
					referenceSize,
				});
				totalDeltaX += Math.abs(current.x - previous.x);
				totalDeltaY += Math.abs(current.y - previous.y);
				previous = current;
			}
			return { x: totalDeltaX / frameCount, y: totalDeltaY / frameCount };
		}

		const perAxis = speeds.map(meanAbsDeltaPerAxis);
		const xs = perAxis.map((d) => d.x);
		const ys = perAxis.map((d) => d.y);

		for (const axisDeltas of [xs, ys]) {
			// Every speed should still move visibly on this axis (sanity
			// floor, far below any of the sampled means).
			for (const meanDelta of axisDeltas) {
				expect(meanDelta).toBeGreaterThan(0.3);
			}
			// No speed dips to less than a third of both its neighbours on
			// this axis — that shape is what aliasing near Nyquist looks
			// like (see H2 in the round18 review for the worked numbers).
			for (let i = 1; i < axisDeltas.length - 1; i++) {
				const neighbourFloor =
					(1 / 3) * Math.min(axisDeltas[i - 1], axisDeltas[i + 1]);
				expect(axisDeltas[i]).toBeGreaterThan(neighbourFloor);
			}
		}
	});
});

describe("shakeEffectDefinition", () => {
	test("produces a single pass whose u_offset matches computeShakeOffsetPx exactly", () => {
		const uniformsFn = shakeEffectDefinition.renderer.passes[0].uniforms;
		const uniforms = uniformsFn({
			effectParams: { intensity: 50, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.25,
			durationSeconds: 2,
		});
		expect(Object.keys(uniforms)).toEqual(["u_offset"]);
		const expected = computeShakeOffsetPx({
			intensity: 50,
			speed: 1,
			localTimeSeconds: 0.25,
			durationSeconds: 2,
			referenceSize: 1080,
		});
		expect(uniforms.u_offset).toEqual([expected.x, expected.y]);
	});

	test("missing params fall back to the documented defaults", () => {
		const uniformsFn = shakeEffectDefinition.renderer.passes[0].uniforms;
		const withDefaults = uniformsFn({
			effectParams: {},
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.25,
			durationSeconds: 2,
		});
		const withExplicitDefaults = uniformsFn({
			effectParams: { intensity: 50, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.25,
			durationSeconds: 2,
		});
		expect(withDefaults).toEqual(withExplicitDefaults);
	});

	test("a non-finite or out-of-range param is clamped, not passed through as NaN", () => {
		const uniformsFn = shakeEffectDefinition.renderer.passes[0].uniforms;
		const withGarbage = uniformsFn({
			effectParams: { intensity: Number.NaN, speed: 999 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.25,
			durationSeconds: 2,
		});
		const offset = withGarbage.u_offset;
		if (!Array.isArray(offset)) throw new Error("u_offset must be an array");
		for (const value of offset) {
			expect(Number.isFinite(value)).toBe(true);
		}
		// speed=999 must clamp to SPEED_MAX (2), not run away
		const clamped = uniformsFn({
			effectParams: { intensity: 50, speed: 2 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.25,
			durationSeconds: 2,
		});
		const garbageSpeedOnly = uniformsFn({
			effectParams: { intensity: 50, speed: 999 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.25,
			durationSeconds: 2,
		});
		expect(garbageSpeedOnly).toEqual(clamped);
	});
});
