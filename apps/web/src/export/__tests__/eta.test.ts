import { describe, expect, test } from "bun:test";
import { ETA_MIN_FRAMES, ETA_MIN_SECONDS, ETA_WINDOW_SECONDS, createEtaEstimator } from "../eta";

function clock() {
	let ms = 0;
	return {
		now: () => ms,
		advance: (seconds: number) => {
			ms += seconds * 1000;
		},
	};
}

describe("createEtaEstimator", () => {
	test("stays silent until both 30 frames and 2 seconds have passed", () => {
		expect(ETA_MIN_FRAMES).toBe(30);
		expect(ETA_MIN_SECONDS).toBe(2);
		const time = clock();
		const eta = createEtaEstimator({ now: time.now });
		expect(eta.update({ framesDone: 0, frameCount: 300 })).toBeNull();
		// 100 frames in 1 s: enough frames, not enough time.
		time.advance(1);
		expect(eta.update({ framesDone: 100, frameCount: 300 })).toBeNull();
		time.advance(1);
		expect(eta.update({ framesDone: 200, frameCount: 300 })).toBeCloseTo(1, 6);

		// 2 s but only 20 frames: not enough frames.
		const slow = createEtaEstimator({ now: time.now });
		slow.update({ framesDone: 0, frameCount: 1000 });
		time.advance(3);
		expect(slow.update({ framesDone: 20, frameCount: 1000 })).toBeNull();
	});

	test("steady 30 frames per second: remaining frames / 30", () => {
		const time = clock();
		const eta = createEtaEstimator({ now: time.now });
		eta.update({ framesDone: 0, frameCount: 900 });
		let last: number | null = null;
		for (let second = 1; second <= 10; second++) {
			time.advance(1);
			last = eta.update({ framesDone: second * 30, frameCount: 900 });
		}
		expect(last).toBeCloseTo((900 - 300) / 30, 6);
	});

	test("follows the recent speed (last ~3 s), not the average since the start", () => {
		expect(ETA_WINDOW_SECONDS).toBe(3);
		const time = clock();
		const eta = createEtaEstimator({ now: time.now });
		eta.update({ framesDone: 0, frameCount: 10_000 });
		let frames = 0;
		for (let second = 0; second < 10; second++) {
			time.advance(1);
			frames += 100; // fast start
			eta.update({ framesDone: frames, frameCount: 10_000 });
		}
		let last: number | null = null;
		for (let second = 0; second < 5; second++) {
			time.advance(1);
			frames += 10; // then 10 frames per second
			last = eta.update({ framesDone: frames, frameCount: 10_000 });
		}
		expect(last).toBeCloseTo((10_000 - frames) / 10, 6);
	});

	test("no progress in the window, or the end reached: no number to show", () => {
		const time = clock();
		const eta = createEtaEstimator({ now: time.now });
		eta.update({ framesDone: 0, frameCount: 100 });
		time.advance(2);
		expect(eta.update({ framesDone: 50, frameCount: 100 })).toBeCloseTo(2, 6);
		time.advance(4);
		expect(eta.update({ framesDone: 50, frameCount: 100 })).toBeNull(); // stalled for longer than the window
		time.advance(1);
		expect(eta.update({ framesDone: 100, frameCount: 100 })).toBe(0);
	});

	test("frames slower than the window (here 8 s each) still get an estimate, from the last two samples", () => {
		const time = clock();
		const eta = createEtaEstimator({ now: time.now });
		eta.update({ framesDone: 0, frameCount: 100 });
		let last: number | null = null;
		for (let frame = 1; frame <= 40; frame++) {
			time.advance(8); // longer than twice the 3 s window: the window never holds two samples
			last = eta.update({ framesDone: frame, frameCount: 100 });
			if (frame < 30) expect(last).toBeNull(); // the 30-frame rule still holds
		}
		expect(last).toBeCloseTo((100 - 40) * 8, 6);
	});

	test("one long frame after fast ones: the estimate follows the last two samples, not nothing and not the old speed", () => {
		const time = clock();
		const eta = createEtaEstimator({ now: time.now });
		eta.update({ framesDone: 0, frameCount: 1000 });
		let frames = 0;
		for (let second = 0; second < 40; second++) {
			time.advance(1);
			frames += 1;
			eta.update({ framesDone: frames, frameCount: 1000 });
		}
		time.advance(10); // one frame that took 10 s
		frames += 1;
		expect(eta.update({ framesDone: frames, frameCount: 1000 })).toBeCloseTo((1000 - frames) * 10, 6);
		time.advance(1);
		frames += 1;
		// Now the window (3 s) holds the 10 s frame's end and this one: back to following recent speed.
		expect(eta.update({ framesDone: frames, frameCount: 1000 })).toBeCloseTo((1000 - frames) * 1, 6);
	});

	test("slow frames keep the other protections: a repeated frame count gives no number, never NaN or negative", () => {
		const time = clock();
		const eta = createEtaEstimator({ now: time.now });
		eta.update({ framesDone: 0, frameCount: 100 });
		for (let frame = 1; frame <= 35; frame++) {
			time.advance(9);
			eta.update({ framesDone: frame, frameCount: 100 });
		}
		time.advance(9);
		expect(eta.update({ framesDone: 35, frameCount: 100 })).toBeNull(); // no progress since the previous sample
		time.advance(9);
		const next = eta.update({ framesDone: 36, frameCount: 100 });
		expect(next === null || (Number.isFinite(next) && next >= 0)).toBe(true);
		expect(eta.update({ framesDone: Number.NaN, frameCount: 100 })).toBeNull();
		time.advance(0); // the same instant twice: no division by zero
		expect(eta.update({ framesDone: 37, frameCount: 100 })).toBeNull();
	});

	test("never negative, never NaN, whatever comes in", () => {
		const time = clock();
		const eta = createEtaEstimator({ now: time.now });
		const inputs = [
			{ framesDone: 0, frameCount: 0 },
			{ framesDone: 40, frameCount: 30 },
			{ framesDone: Number.NaN, frameCount: 100 },
			{ framesDone: 60, frameCount: 100 },
		];
		for (const input of inputs) {
			time.advance(1);
			const value = eta.update(input);
			expect(value === null || (Number.isFinite(value) && value >= 0)).toBe(true);
		}
	});
});
