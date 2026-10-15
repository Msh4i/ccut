import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DECODER_LIMITS,
	chooseWithKeyframe,
	frameCovers,
	frameStaleness,
	planForwardJump,
	readAheadFrameCount,
} from "../frame-policy";

describe("readAheadFrameCount", () => {
	test("sizes the read-ahead in seconds: a quarter second is 8 frames at 30 fps", () => {
		expect(
			readAheadFrameCount({ seconds: 0.25, frameDuration: 1 / 30, min: 2, max: 12 }),
		).toBe(8);
	});

	test("the same seconds give fewer frames at a lower frame rate", () => {
		expect(
			readAheadFrameCount({ seconds: 0.25, frameDuration: 1 / 24, min: 2, max: 12 }),
		).toBe(6);
	});

	test("is bounded above (decoded frames hold decoder memory)", () => {
		expect(
			readAheadFrameCount({ seconds: 0.25, frameDuration: 1 / 120, min: 2, max: 8 }),
		).toBe(8);
	});

	test("is bounded below", () => {
		expect(
			readAheadFrameCount({ seconds: 0.25, frameDuration: 1, min: 2, max: 8 }),
		).toBe(2);
	});

	test("an unknown frame duration falls back to 30 fps", () => {
		for (const frameDuration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				readAheadFrameCount({ seconds: 0.25, frameDuration, min: 2, max: 12 }),
			).toBe(8);
		}
	});
});

describe("frameCovers", () => {
	const frame = { timestamp: 1, duration: 0.5 };

	test("covers its own span, start inclusive, end exclusive", () => {
		expect(frameCovers({ frame, time: 1, nextTimestamp: undefined })).toBe(true);
		expect(frameCovers({ frame, time: 1.49, nextTimestamp: undefined })).toBe(true);
		expect(frameCovers({ frame, time: 1.5, nextTimestamp: undefined })).toBe(false);
		expect(frameCovers({ frame, time: 0.99, nextTimestamp: undefined })).toBe(false);
	});

	test("a gap before the next frame still belongs to this frame", () => {
		expect(frameCovers({ frame, time: 1.7, nextTimestamp: 1.8 })).toBe(true);
		expect(frameCovers({ frame, time: 1.8, nextTimestamp: 1.8 })).toBe(false);
	});

	test("a next frame that starts early does not shorten the span", () => {
		expect(frameCovers({ frame, time: 1.45, nextTimestamp: 1.4 })).toBe(true);
	});
});

describe("frameStaleness", () => {
	test("is zero while the frame covers the time and grows after its end", () => {
		const frame = { timestamp: 2, duration: 0.1 };
		expect(frameStaleness({ frame, time: 2.05 })).toBe(0);
		expect(frameStaleness({ frame, time: 2 })).toBe(0);
		expect(frameStaleness({ frame, time: 2.35 })).toBeCloseTo(0.25, 9);
	});
});

describe("planForwardJump", () => {
	const limits = DEFAULT_DECODER_LIMITS;

	test("a small forward jump keeps the running decoder", () => {
		expect(planForwardJump({ target: 10.2, frontier: 10, limits })).toBe("advance");
		expect(
			planForwardJump({ target: 10 + limits.alwaysAdvanceSeconds, frontier: 10, limits }),
		).toBe("advance");
	});

	test("a jump beyond the bounded window restarts without asking for key frames", () => {
		expect(
			planForwardJump({
				target: 10 + limits.maxAdvanceSeconds + 0.01,
				frontier: 10,
				limits,
			}),
		).toBe("restart");
	});

	test("in between, the key frame position decides", () => {
		expect(
			planForwardJump({ target: 10 + limits.alwaysAdvanceSeconds + 0.01, frontier: 10, limits }),
		).toBe("ask-keyframe");
		expect(
			planForwardJump({ target: 10 + limits.maxAdvanceSeconds, frontier: 10, limits }),
		).toBe("ask-keyframe");
	});

	test("a target the decoder already passed is not a forward jump", () => {
		expect(planForwardJump({ target: 9, frontier: 10, limits })).toBe("advance");
	});

	test("the defaults keep the old two-second window inside the bounded one", () => {
		expect(limits.alwaysAdvanceSeconds).toBeLessThan(limits.maxAdvanceSeconds);
		expect(limits.maxAdvanceSeconds).toBeGreaterThanOrEqual(2);
		expect(limits.maxAdvanceSeconds).toBeLessThanOrEqual(5);
	});
});

describe("chooseWithKeyframe", () => {
	const limits = {
		alwaysAdvanceSeconds: 0.5,
		maxAdvanceSeconds: 3,
		restartCostSeconds: 0.25,
	};

	test("restarts when a key frame close before the target saves decoding", () => {
		// advance decodes 2 s; a restart decodes 0.5 s plus its start-up cost
		expect(
			chooseWithKeyframe({ target: 12, frontier: 10, keyframe: 11.5, limits }),
		).toBe("restart");
	});

	test("advances when the key frame is at or before the decoder position", () => {
		expect(
			chooseWithKeyframe({ target: 12, frontier: 10, keyframe: 9, limits }),
		).toBe("advance");
		expect(
			chooseWithKeyframe({ target: 12, frontier: 10, keyframe: 10, limits }),
		).toBe("advance");
	});

	test("the start-up cost tips a close call towards advancing", () => {
		// advance 1 s; restart 0.8 s + 0.25 s
		expect(
			chooseWithKeyframe({ target: 11, frontier: 10, keyframe: 10.2, limits }),
		).toBe("advance");
		// advance 1 s; restart 0.7 s + 0.25 s
		expect(
			chooseWithKeyframe({ target: 11, frontier: 10, keyframe: 10.3, limits }),
		).toBe("restart");
	});

	test("an unknown key frame keeps the decoder inside the bounded window", () => {
		expect(
			chooseWithKeyframe({ target: 12, frontier: 10, keyframe: null, limits }),
		).toBe("advance");
	});
});
