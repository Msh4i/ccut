import { describe, expect, test } from "bun:test";
import { workSize } from "../frame-source";

describe("workSize maxWidth", () => {
	test("defaults to 480 and honours a wider limit, never upscaling", () => {
		expect(workSize({ width: 1920, height: 1080 })).toEqual({ width: 480, height: 270 });
		expect(workSize({ width: 1920, height: 1080, maxWidth: 960 })).toEqual({ width: 960, height: 540 });
		expect(workSize({ width: 640, height: 360, maxWidth: 960 })).toEqual({ width: 640, height: 360 });
	});
});
