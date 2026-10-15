import type { FrameRate } from "opencut-wasm";
import { frameRateToFloat, frameRatesEqual } from "@/fps/utils";
import { TICKS_PER_SECOND } from "@/wasm";
import { selectAudioCodec } from "./audio-codec";
import { pickAvcLevel } from "./avc-level";
import {
	AUDIO_BITRATE_CHOICES,
	CUSTOM_MBPS_LIMITS,
	computeVideoBitrate,
	defaultAudioBitrate,
	type QualityChoice,
} from "./bitrate";
import { EXPORT_FORMAT_VALUES, EXPORT_QUALITY_VALUES, type ExportFormat } from "./index";

/**
 * Export v2 settings (plan P3), pure. The render always happens at the
 * project's canvas size; a smaller output is drawn onto a scaled canvas.
 * Upscaling is out of scope (plan R5).
 */

export const SHORT_SIDE_STEPS = [2160, 1440, 1080, 720, 480] as const;
export type ShortSideStep = (typeof SHORT_SIDE_STEPS)[number];

export const FIXED_FPS_VALUES = [24, 25, 30, 50, 60] as const;
export type FixedFps = (typeof FIXED_FPS_VALUES)[number];

/** mediabunny's default is 5 s (plan P3). */
export const KEYFRAME_INTERVAL_SECONDS = 2;

export type ResolutionChoice = { kind: "project" } | { kind: "short-side"; shortSide: ShortSideStep };
export type FpsChoice = { kind: "project" } | { kind: "fixed"; fps: FixedFps };

export interface ExportSettings {
	container: ExportFormat;
	resolution: ResolutionChoice;
	fps: FpsChoice;
	quality: QualityChoice;
	includeAudio: boolean;
	/** bit/s, one of `AUDIO_BITRATE_CHOICES` for the container's codec. */
	audioBitrate: number;
}

/** What the settings need to know about the project. */
export interface ExportProject {
	/** Canvas size (the render size). */
	width: number;
	height: number;
	fps: FrameRate;
	durationSeconds: number;
}

export interface Size {
	width: number;
	height: number;
}

export function defaultExportSettings(): ExportSettings {
	return {
		container: "mp4",
		resolution: { kind: "project" },
		fps: { kind: "project" },
		quality: { kind: "preset", quality: "high" },
		includeAudio: true,
		audioBitrate: defaultAudioBitrate({ codec: "aac" }),
	};
}

const floorEven = (value: number) => Math.max(0, Math.floor(value / 2) * 2);

function shortSideOf({ width, height }: Size): number {
	return Math.min(width, height);
}

/**
 * Output size: even on both sides, never larger than the project. A
 * short-side step at or above the project's short side gives the project size.
 */
export function computeOutputSize({
	project,
	resolution,
}: {
	project: Size;
	resolution: ResolutionChoice;
}): Size {
	const projectShort = shortSideOf(project);
	if (resolution.kind === "project" || resolution.shortSide >= projectShort) {
		return { width: floorEven(project.width), height: floorEven(project.height) };
	}
	const scale = resolution.shortSide / projectShort;
	const nearestEvenAtMost = ({ value, limit }: { value: number; limit: number }) =>
		Math.min(floorEven(limit), Math.max(2, Math.round(value / 2) * 2));
	return {
		width: nearestEvenAtMost({ value: project.width * scale, limit: project.width }),
		height: nearestEvenAtMost({ value: project.height * scale, limit: project.height }),
	};
}

export function needsScaledCanvas({ render, output }: { render: Size; output: Size }): boolean {
	return render.width !== output.width || render.height !== output.height;
}

export interface ResolutionOption extends Size {
	choice: ResolutionChoice;
}

/** "Project" first, then each step smaller than the project's short side. */
export function resolutionChoices({ project }: { project: Size }): ResolutionOption[] {
	const options: ResolutionOption[] = [
		{ choice: { kind: "project" }, ...computeOutputSize({ project, resolution: { kind: "project" } }) },
	];
	for (const shortSide of SHORT_SIDE_STEPS) {
		if (shortSide >= shortSideOf(project)) continue;
		const choice: ResolutionChoice = { kind: "short-side", shortSide };
		options.push({ choice, ...computeOutputSize({ project, resolution: choice }) });
	}
	return options;
}

export function resolveFrameRate({ choice, projectFps }: { choice: FpsChoice; projectFps: FrameRate }): FrameRate {
	return choice.kind === "project" ? projectFps : { numerator: choice.fps, denominator: 1 };
}

function ticksPerFrameOf(rate: FrameRate): number {
	return (TICKS_PER_SECOND * rate.denominator) / rate.numerator;
}

export interface FpsOption {
	choice: FpsChoice;
	rate: FrameRate;
	fps: number;
	ticksPerFrame: number;
	/** Higher than the project's rate: the video repeats frames. */
	aboveProject: boolean;
}

/** "Project" first, then the fixed rates that differ from it. */
export function fpsChoices({ projectFps }: { projectFps: FrameRate }): FpsOption[] {
	const projectFloat = frameRateToFloat(projectFps);
	const options: FpsOption[] = [
		{
			choice: { kind: "project" },
			rate: projectFps,
			fps: projectFloat,
			ticksPerFrame: ticksPerFrameOf(projectFps),
			aboveProject: false,
		},
	];
	for (const fps of FIXED_FPS_VALUES) {
		const rate = { numerator: fps, denominator: 1 };
		if (frameRatesEqual({ a: rate, b: projectFps })) continue;
		options.push({
			choice: { kind: "fixed", fps },
			rate,
			fps,
			ticksPerFrame: ticksPerFrameOf(rate),
			aboveProject: fps > projectFloat,
		});
	}
	return options;
}

// ---------------------------------------------------------------- presets

export type ExportPresetId = "youtube-1080p" | "youtube-4k" | "small-file";

export interface ExportPreset {
	id: ExportPresetId;
	label: string;
}

const PRESETS: Record<ExportPresetId, ExportPreset & { shortSide: ShortSideStep; quality: QualityChoice }> = {
	"youtube-1080p": { id: "youtube-1080p", label: "YouTube 1080p", shortSide: 1080, quality: { kind: "preset", quality: "high" } },
	"youtube-4k": { id: "youtube-4k", label: "YouTube 4K", shortSide: 2160, quality: { kind: "preset", quality: "high" } },
	"small-file": { id: "small-file", label: "Small file", shortSide: 720, quality: { kind: "preset", quality: "low" } },
};

/** "YouTube 4K" only when the project's short side is at least 2160. */
export function exportPresetsFor({ project }: { project: Size }): ExportPreset[] {
	const ids: ExportPresetId[] =
		shortSideOf(project) >= 2160 ? ["youtube-1080p", "youtube-4k", "small-file"] : ["youtube-1080p", "small-file"];
	return ids.map((id) => ({ id, label: PRESETS[id].label }));
}

/**
 * Fills the fields a preset sets (MP4, resolution, project fps, quality, AAC
 * bitrate) and keeps `includeAudio`. It never starts an export.
 */
export function applyPreset({
	settings,
	presetId,
	project,
}: {
	settings: ExportSettings;
	presetId: ExportPresetId;
	project: Size;
}): ExportSettings {
	if (!exportPresetsFor({ project }).some((preset) => preset.id === presetId)) {
		throw new RangeError(`preset ${presetId} is not offered for a ${project.width}x${project.height} project`);
	}
	const preset = PRESETS[presetId];
	return {
		...settings,
		container: "mp4",
		resolution:
			preset.shortSide < shortSideOf(project) ? { kind: "short-side", shortSide: preset.shortSide } : { kind: "project" },
		fps: { kind: "project" },
		quality: preset.quality,
		audioBitrate: defaultAudioBitrate({ codec: "aac" }),
	};
}

// ---------------------------------------------------------------- validation

export type ExportSettingsField = keyof ExportSettings;

export interface ExportSettingsIssue {
	field: ExportSettingsField;
	code:
		| "invalid"
		| "upscale"
		| "too-small"
		| "no-avc-level"
		| "fractional-ticks"
		| "above-project"
		| "out-of-range";
	severity: "error" | "warning";
	message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOneOf<T>(list: readonly T[], value: unknown): value is T {
	return list.some((item) => item === value);
}

/**
 * Checks every field; `settings` may come from storage or the UI, so it is
 * not trusted to have the right shape. Errors block the export; warnings are
 * shown next to the field.
 */
export function validateExportSettings({
	settings,
	project,
}: {
	settings: unknown;
	project: ExportProject;
}): ExportSettingsIssue[] {
	const issues: ExportSettingsIssue[] = [];
	const error = ({ field, code, message }: Omit<ExportSettingsIssue, "severity">) =>
		issues.push({ field, code, message, severity: "error" });
	const value = isRecord(settings) ? settings : {};

	const container = isOneOf(EXPORT_FORMAT_VALUES, value.container) ? value.container : null;
	if (!container) error({ field: "container", code: "invalid", message: "Choose MP4 or WebM." });

	let resolution: ResolutionChoice | null = null;
	const rawResolution = value.resolution;
	if (isRecord(rawResolution) && rawResolution.kind === "project") {
		resolution = { kind: "project" };
	} else if (
		isRecord(rawResolution) &&
		rawResolution.kind === "short-side" &&
		isOneOf(SHORT_SIDE_STEPS, rawResolution.shortSide)
	) {
		resolution = { kind: "short-side", shortSide: rawResolution.shortSide };
		if (rawResolution.shortSide >= shortSideOf(project)) {
			error({ field: "resolution", code: "upscale", message: "Exports can only be smaller than the project canvas." });
			resolution = null;
		}
	} else {
		error({ field: "resolution", code: "invalid", message: "Choose a resolution from the list." });
	}

	let rate: FrameRate | null = null;
	const rawFps = value.fps;
	if (isRecord(rawFps) && rawFps.kind === "project") {
		rate = project.fps;
	} else if (isRecord(rawFps) && rawFps.kind === "fixed" && isOneOf(FIXED_FPS_VALUES, rawFps.fps)) {
		rate = { numerator: rawFps.fps, denominator: 1 };
	} else {
		error({ field: "fps", code: "invalid", message: "Choose a frame rate from the list." });
	}
	if (rate) {
		const ticks = ticksPerFrameOf(rate);
		if (!Number.isFinite(ticks) || !Number.isInteger(ticks)) {
			error({ field: "fps", code: "fractional-ticks", message: "This frame rate does not fit the timeline's time base." });
			rate = null;
		} else if (frameRateToFloat(rate) > frameRateToFloat(project.fps)) {
			issues.push({
				field: "fps",
				code: "above-project",
				severity: "warning",
				message: "Higher than the project's frame rate: frames will be repeated.",
			});
		}
	}

	let quality: QualityChoice | null = null;
	const rawQuality = value.quality;
	if (isRecord(rawQuality) && rawQuality.kind === "preset" && isOneOf(EXPORT_QUALITY_VALUES, rawQuality.quality)) {
		quality = { kind: "preset", quality: rawQuality.quality };
	} else if (isRecord(rawQuality) && rawQuality.kind === "custom" && typeof rawQuality.mbps === "number") {
		const { mbps } = rawQuality;
		if (Number.isFinite(mbps) && mbps >= CUSTOM_MBPS_LIMITS.min && mbps <= CUSTOM_MBPS_LIMITS.max) {
			quality = { kind: "custom", mbps };
		} else {
			error({
				field: "quality",
				code: "out-of-range",
				message: `Enter between ${CUSTOM_MBPS_LIMITS.min} and ${CUSTOM_MBPS_LIMITS.max} Mb/s.`,
			});
		}
	} else {
		error({ field: "quality", code: "invalid", message: "Choose a quality from the list." });
	}

	const includeAudio = typeof value.includeAudio === "boolean" ? value.includeAudio : null;
	if (includeAudio === null) error({ field: "includeAudio", code: "invalid", message: "Audio must be on or off." });
	if (container && includeAudio) {
		const codec = selectAudioCodec({ container, aacAvailable: true }) ?? "aac";
		if (!isOneOf(AUDIO_BITRATE_CHOICES[codec], value.audioBitrate)) {
			error({ field: "audioBitrate", code: "invalid", message: "Choose an audio bitrate from the list." });
		}
	}

	if (resolution) {
		const output = computeOutputSize({ project, resolution });
		if (output.width < 2 || output.height < 2) {
			error({ field: "resolution", code: "too-small", message: "The output would be smaller than 2x2 pixels." });
		} else if (container === "mp4" && rate && quality) {
			const fps = frameRateToFloat(rate);
			const bitrate = computeVideoBitrate({ ...output, fps, quality, codec: "avc" });
			if (!pickAvcLevel({ ...output, fps, bitrate })) {
				error({
					field: "resolution",
					code: "no-avc-level",
					message: "Too large for H.264 at this frame rate (above level 5.2). Pick a smaller size, a lower frame rate or WebM.",
				});
			}
		}
	}

	return issues;
}
