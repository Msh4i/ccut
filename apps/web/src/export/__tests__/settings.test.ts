import { describe, expect, test } from "bun:test";
import {
	KEYFRAME_INTERVAL_SECONDS,
	applyPreset,
	computeOutputSize,
	defaultExportSettings,
	exportPresetsFor,
	fpsChoices,
	needsScaledCanvas,
	resolutionChoices,
	resolveFrameRate,
	validateExportSettings,
	type ExportProject,
	type ExportSettings,
} from "../settings";

function project(overrides: Partial<ExportProject> = {}): ExportProject {
	return {
		width: 1920,
		height: 1080,
		fps: { numerator: 30, denominator: 1 },
		durationSeconds: 60,
		...overrides,
	};
}

const shortSide = (value: 2160 | 1440 | 1080 | 720 | 480) => ({ kind: "short-side", shortSide: value }) as const;

describe("computeOutputSize", () => {
	test("project size stays as it is when it is even", () => {
		expect(computeOutputSize({ project: project(), resolution: { kind: "project" } })).toEqual({ width: 1920, height: 1080 });
	});

	test("an odd project size is made even by going down, never up", () => {
		expect(computeOutputSize({ project: project({ width: 1081, height: 607 }), resolution: { kind: "project" } })).toEqual({
			width: 1080,
			height: 606,
		});
	});

	test("short-side steps keep the aspect ratio, landscape and portrait", () => {
		expect(computeOutputSize({ project: project(), resolution: shortSide(720) })).toEqual({ width: 1280, height: 720 });
		expect(computeOutputSize({ project: project({ width: 1080, height: 1920 }), resolution: shortSide(720) })).toEqual({
			width: 720,
			height: 1280,
		});
		expect(computeOutputSize({ project: project({ width: 3840, height: 2160 }), resolution: shortSide(1440) })).toEqual({
			width: 2560,
			height: 1440,
		});
	});

	test("a scaled odd project is even on both sides", () => {
		const size = computeOutputSize({ project: project({ width: 1081, height: 607 }), resolution: shortSide(480) });
		expect(size.width % 2).toBe(0);
		expect(size.height % 2).toBe(0);
		expect(size).toEqual({ width: 854, height: 480 });
	});

	test("never scales up: a step at or above the project's short side gives the project size", () => {
		expect(computeOutputSize({ project: project(), resolution: shortSide(2160) })).toEqual({ width: 1920, height: 1080 });
		expect(computeOutputSize({ project: project(), resolution: shortSide(1080) })).toEqual({ width: 1920, height: 1080 });
	});

	test("every step on every common canvas is even, inside the canvas, and keeps the ratio within a pixel", () => {
		const canvases = [
			[1920, 1080],
			[1080, 1920],
			[1080, 1080],
			[3840, 2160],
			[2560, 1080],
			[1081, 607],
			[1440, 1080],
		] as const;
		for (const [width, height] of canvases) {
			for (const step of [2160, 1440, 1080, 720, 480] as const) {
				const size = computeOutputSize({ project: project({ width, height }), resolution: shortSide(step) });
				expect(size.width % 2).toBe(0);
				expect(size.height % 2).toBe(0);
				expect(size.width).toBeLessThanOrEqual(width);
				expect(size.height).toBeLessThanOrEqual(height);
				expect(Math.abs(size.width / size.height - width / height) * size.height).toBeLessThanOrEqual(2);
			}
		}
	});
});

describe("resolutionChoices / needsScaledCanvas", () => {
	test("project first, then only steps smaller than the project's short side", () => {
		const choices = resolutionChoices({ project: project() });
		expect(choices.map((choice) => choice.choice)).toEqual([{ kind: "project" }, shortSide(720), shortSide(480)]);
		expect(choices[1]).toMatchObject({ width: 1280, height: 720 });
		expect(resolutionChoices({ project: project({ width: 3840, height: 2160 }) }).length).toBe(5);
		expect(resolutionChoices({ project: project({ width: 640, height: 360 }) }).length).toBe(1);
	});

	test("a scaled canvas is needed only when the output differs from the render size", () => {
		expect(needsScaledCanvas({ render: { width: 1920, height: 1080 }, output: { width: 1920, height: 1080 } })).toBe(false);
		expect(needsScaledCanvas({ render: { width: 1920, height: 1080 }, output: { width: 1280, height: 720 } })).toBe(true);
		expect(needsScaledCanvas({ render: { width: 1081, height: 607 }, output: { width: 1080, height: 606 } })).toBe(true);
	});
});

describe("fpsChoices / resolveFrameRate", () => {
	test("project first, the fixed rates after it, without a duplicate of the project's rate", () => {
		const choices = fpsChoices({ projectFps: { numerator: 30, denominator: 1 } });
		expect(choices.map((choice) => choice.fps)).toEqual([30, 24, 25, 50, 60]);
		expect(choices[0].choice).toEqual({ kind: "project" });
	});

	test("rates above the project's are flagged (they repeat frames)", () => {
		const choices = fpsChoices({ projectFps: { numerator: 30, denominator: 1 } });
		expect(choices.filter((choice) => choice.aboveProject).map((choice) => choice.fps)).toEqual([50, 60]);
	});

	test("NTSC project rates stay exact and keep 30 as its own choice", () => {
		const choices = fpsChoices({ projectFps: { numerator: 30_000, denominator: 1_001 } });
		expect(choices[0].rate).toEqual({ numerator: 30_000, denominator: 1_001 });
		expect(choices.map((choice) => choice.fps).includes(30)).toBe(true);
	});

	test("every offered rate has a whole number of ticks per frame", () => {
		for (const choice of fpsChoices({ projectFps: { numerator: 24_000, denominator: 1_001 } })) {
			expect(choice.ticksPerFrame).toBe(Math.round(choice.ticksPerFrame));
		}
		const sixty = fpsChoices({ projectFps: { numerator: 25, denominator: 1 } }).find((choice) => choice.fps === 60);
		expect(sixty?.ticksPerFrame).toBe(2000);
	});

	test("resolveFrameRate", () => {
		const projectFps = { numerator: 25, denominator: 1 };
		expect(resolveFrameRate({ choice: { kind: "project" }, projectFps })).toEqual(projectFps);
		expect(resolveFrameRate({ choice: { kind: "fixed", fps: 60 }, projectFps })).toEqual({ numerator: 60, denominator: 1 });
	});
});

describe("presets", () => {
	test("1080p project: YouTube 1080p and Small file, no 4K", () => {
		expect(exportPresetsFor({ project: project() }).map((preset) => preset.id)).toEqual(["youtube-1080p", "small-file"]);
	});

	test("YouTube 4K appears only for a project whose short side is >= 2160", () => {
		expect(exportPresetsFor({ project: project({ width: 3840, height: 2160 }) }).map((preset) => preset.id)).toEqual([
			"youtube-1080p",
			"youtube-4k",
			"small-file",
		]);
		expect(exportPresetsFor({ project: project({ width: 3840, height: 2158 }) }).map((preset) => preset.id)).not.toContain(
			"youtube-4k",
		);
	});

	test("a preset only fills fields and never scales up", () => {
		const settings: ExportSettings = { ...defaultExportSettings(), container: "webm", includeAudio: false };
		const youtube = applyPreset({ settings, presetId: "youtube-1080p", project: project({ width: 3840, height: 2160 }) });
		expect(youtube).toEqual({
			container: "mp4",
			resolution: shortSide(1080),
			fps: { kind: "project" },
			quality: { kind: "preset", quality: "high" },
			includeAudio: false,
			audioBitrate: 192_000,
		});
		// 9:16 1080x1920: its short side is 1080, so "YouTube 1080p" is the project size.
		expect(applyPreset({ settings, presetId: "youtube-1080p", project: project({ width: 1080, height: 1920 }) }).resolution).toEqual({
			kind: "project",
		});
		const small = applyPreset({ settings, presetId: "small-file", project: project() });
		expect(small.resolution).toEqual(shortSide(720));
		expect(small.quality).toEqual({ kind: "preset", quality: "low" });
		expect(applyPreset({ settings, presetId: "small-file", project: project({ width: 640, height: 360 }) }).resolution).toEqual({
			kind: "project",
		});
	});

	test("YouTube 4K on a project that is not 4K is refused", () => {
		expect(() => applyPreset({ settings: defaultExportSettings(), presetId: "youtube-4k", project: project() })).toThrow(RangeError);
	});

	test("every preset's result passes validation", () => {
		for (const canvas of [project(), project({ width: 3840, height: 2160 }), project({ width: 1080, height: 1920 })]) {
			for (const preset of exportPresetsFor({ project: canvas })) {
				const settings = applyPreset({ settings: defaultExportSettings(), presetId: preset.id, project: canvas });
				expect(validateExportSettings({ settings, project: canvas }).filter((issue) => issue.severity === "error")).toEqual([]);
			}
		}
	});
});

describe("validateExportSettings", () => {
	const errorsOn = ({ settings, canvas }: { settings: unknown; canvas: ExportProject }) =>
		validateExportSettings({ settings, project: canvas })
			.filter((issue) => issue.severity === "error")
			.map((issue) => `${issue.field}:${issue.code}`);
	const errorsOf = (settings: unknown) => errorsOn({ settings, canvas: project() });

	test("the defaults are valid and use a 2 s key frame interval", () => {
		expect(errorsOf(defaultExportSettings())).toEqual([]);
		expect(KEYFRAME_INTERVAL_SECONDS).toBe(2);
	});

	test("container", () => {
		const settings = { ...defaultExportSettings(), container: "mov" };
		expect(errorsOf(settings)).toContain("container:invalid");
	});

	test("resolution: unknown step, and a step that would scale up", () => {
		expect(errorsOf({ ...defaultExportSettings(), resolution: { kind: "short-side", shortSide: 900 } })).toContain(
			"resolution:invalid",
		);
		expect(errorsOf({ ...defaultExportSettings(), resolution: shortSide(1440) })).toContain("resolution:upscale");
		expect(errorsOf({ ...defaultExportSettings(), resolution: shortSide(1080) })).toContain("resolution:upscale");
	});

	test("resolution: too small after making it even", () => {
		expect(errorsOn({ settings: defaultExportSettings(), canvas: project({ width: 1, height: 1 }) })).toContain("resolution:too-small");
	});

	test("fps: unknown fixed rate, and a project rate with fractional ticks per frame", () => {
		expect(errorsOf({ ...defaultExportSettings(), fps: { kind: "fixed", fps: 48 } })).toContain("fps:invalid");
		expect(errorsOn({ settings: defaultExportSettings(), canvas: project({ fps: { numerator: 7, denominator: 1 } }) })).toContain("fps:fractional-ticks");
	});

	test("fps above the project's is a warning, not an error", () => {
		const issues = validateExportSettings({ settings: { ...defaultExportSettings(), fps: { kind: "fixed", fps: 60 } }, project: project() });
		expect(issues).toEqual([expect.objectContaining({ field: "fps", code: "above-project", severity: "warning" })]);
	});

	test("quality: unknown preset, custom out of range or not a number", () => {
		expect(errorsOf({ ...defaultExportSettings(), quality: { kind: "preset", quality: "ultra" } })).toContain(
			"quality:invalid",
		);
		for (const mbps of [0.49, 300.01, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(errorsOf({ ...defaultExportSettings(), quality: { kind: "custom", mbps } })).toContain("quality:out-of-range");
		}
		for (const mbps of [0.5, 12, 300]) {
			expect(errorsOf({ ...defaultExportSettings(), quality: { kind: "custom", mbps } })).toEqual([]);
		}
	});

	test("audio bitrate must belong to the container's codec, unless audio is off", () => {
		expect(errorsOf({ ...defaultExportSettings(), container: "webm" })).toContain("audioBitrate:invalid");
		expect(errorsOf({ ...defaultExportSettings(), container: "webm", audioBitrate: 128_000 })).toEqual([]);
		expect(errorsOf({ ...defaultExportSettings(), audioBitrate: 100_000 })).toContain("audioBitrate:invalid");
		expect(errorsOf({ ...defaultExportSettings(), audioBitrate: 100_000, includeAudio: false })).toEqual([]);
	});

	test("an MP4 too large for H.264 level 5.2 is refused (8K, 4K at 120)", () => {
		expect(errorsOn({ settings: defaultExportSettings(), canvas: project({ width: 7680, height: 4320 }) })).toContain("resolution:no-avc-level");
		expect(errorsOn({ settings: defaultExportSettings(), canvas: project({ width: 3840, height: 2160, fps: { numerator: 120, denominator: 1 } }) })).toContain(
			"resolution:no-avc-level",
		);
		// WebM (VP9) has no H.264 level.
		expect(
			errorsOn({ settings: { ...defaultExportSettings(), container: "webm", audioBitrate: 128_000 }, canvas: project({ width: 7680, height: 4320 }) }),
		).toEqual([]);
	});

	test("includeAudio must be a boolean", () => {
		expect(errorsOf({ ...defaultExportSettings(), includeAudio: "yes" })).toContain("includeAudio:invalid");
	});
});
