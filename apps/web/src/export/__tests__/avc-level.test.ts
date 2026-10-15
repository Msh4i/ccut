import { describe, expect, test } from "bun:test";
import { AVC_LEVELS, avcCodecString, avcHighMaxBitrate, pickAvcLevel, type AvcLevel } from "../avc-level";

const MBPS = 1_000_000;

function levelNamed(name: string): AvcLevel {
	const level = AVC_LEVELS.find((candidate) => candidate.name === name);
	if (!level) throw new Error(`no level ${name}`);
	return level;
}

describe("pickAvcLevel (H.264 Annex A, Table A-1, High profile)", () => {
	test("the plan's reference cases", () => {
		expect(pickAvcLevel({ width: 1920, height: 1080, fps: 30, bitrate: 8 * MBPS })?.name).toBe("4");
		expect(pickAvcLevel({ width: 1920, height: 1080, fps: 60, bitrate: 14 * MBPS })?.name).toBe("4.2");
		expect(pickAvcLevel({ width: 2560, height: 1440, fps: 60, bitrate: 20 * MBPS })?.name).toBe("5.1");
		expect(pickAvcLevel({ width: 3840, height: 2160, fps: 30, bitrate: 32 * MBPS })?.name).toBe("5.1");
		expect(pickAvcLevel({ width: 3840, height: 2160, fps: 60, bitrate: 54 * MBPS })?.name).toBe("5.2");
	});

	test("portrait has the same macroblock count as landscape", () => {
		expect(pickAvcLevel({ width: 1080, height: 1920, fps: 30, bitrate: 8 * MBPS })?.name).toBe("4");
	});

	test("small sizes get small levels", () => {
		expect(pickAvcLevel({ width: 1280, height: 720, fps: 30, bitrate: 3 * MBPS })?.name).toBe("3.1");
		expect(pickAvcLevel({ width: 640, height: 480, fps: 30, bitrate: 1.5 * MBPS })?.name).toBe("3");
		// 854x480 is 54 x 30 MBs: 48 600 MB/s at 30 fps is over level 3 (40 500).
		expect(pickAvcLevel({ width: 854, height: 480, fps: 30, bitrate: 1.5 * MBPS })?.name).toBe("3.1");
	});

	test("a bitrate over a level's limit moves one level up", () => {
		// Level 4: MaxBR 20 000 kbit/s x 1.25 for High = 25 Mb/s.
		expect(avcHighMaxBitrate({ level: levelNamed("4") })).toBe(25 * MBPS);
		expect(pickAvcLevel({ width: 1920, height: 1080, fps: 30, bitrate: 25 * MBPS })?.name).toBe("4");
		expect(pickAvcLevel({ width: 1920, height: 1080, fps: 30, bitrate: 25 * MBPS + 1 })?.name).toBe("4.1");
	});

	test("partial macroblocks count as whole ones", () => {
		// 1928 px = 120.5 -> 121 MBs, 1080 = 67.5 -> 68: 8228 > 8192 (level 4 MaxFS).
		expect(pickAvcLevel({ width: 1928, height: 1080, fps: 30, bitrate: MBPS })?.name).toBe("4.2");
	});

	test("an edge in MaxMBPS: 1080p at 30 fits 4, at 30.2 it does not", () => {
		expect(pickAvcLevel({ width: 1920, height: 1080, fps: 30.1, bitrate: MBPS })?.name).toBe("4");
		expect(pickAvcLevel({ width: 1920, height: 1080, fps: 30.2, bitrate: MBPS })?.name).toBe("4.2");
	});

	test("a very thin frame is limited by the frame-width rule, not by the area", () => {
		// 4112 px wide = 257 MBs: over sqrt(8 * 8192) = 256 (levels 4, 4.1) even
		// though the area is tiny; level 4.2 allows sqrt(8 * 8704) = 263.
		expect(pickAvcLevel({ width: 4096, height: 16, fps: 30, bitrate: MBPS })?.name).toBe("4");
		expect(pickAvcLevel({ width: 4112, height: 16, fps: 30, bitrate: MBPS })?.name).toBe("4.2");
	});

	test("8K, or a bitrate over level 5.2, is not supported (null)", () => {
		expect(pickAvcLevel({ width: 7680, height: 4320, fps: 30, bitrate: 100 * MBPS })).toBeNull();
		expect(pickAvcLevel({ width: 3840, height: 2160, fps: 120, bitrate: 50 * MBPS })).toBeNull();
		expect(pickAvcLevel({ width: 1920, height: 1080, fps: 30, bitrate: 301 * MBPS })).toBeNull();
	});

	test("rejects non-positive or non-finite input", () => {
		expect(() => pickAvcLevel({ width: 0, height: 1080, fps: 30, bitrate: MBPS })).toThrow(RangeError);
		expect(() => pickAvcLevel({ width: 1920, height: 1080, fps: Number.NaN, bitrate: MBPS })).toThrow(RangeError);
	});
});

describe("avcCodecString", () => {
	test("High profile, no constraint flags, level_idc = level x 10 in hex", () => {
		const byName = levelNamed;
		expect(avcCodecString({ level: byName("4") })).toBe("avc1.640028");
		expect(avcCodecString({ level: byName("4.2") })).toBe("avc1.64002a");
		expect(avcCodecString({ level: byName("5.1") })).toBe("avc1.640033");
		expect(avcCodecString({ level: byName("5.2") })).toBe("avc1.640034");
		expect(avcCodecString({ level: byName("3") })).toBe("avc1.64001e");
	});
});
