import type { FrameRate } from "opencut-wasm";
import { frameRateToFloat } from "@/fps/utils";
import { realTimers, withDeadline, type DeadlineTimers } from "@/media/deadline";
import { selectAudioCodec, type AudioCodecChoice } from "./audio-codec";
import { avcCodecString, pickAvcLevel } from "./avc-level";
import {
	computeVideoBitrate,
	estimateFileBytes,
	type FileSizeEstimate,
	type VideoCodecChoice,
} from "./bitrate";
import type { ExportFormat } from "./index";
import {
	KEYFRAME_INTERVAL_SECONDS,
	computeOutputSize,
	fpsChoices,
	needsScaledCanvas,
	resolutionChoices,
	resolveFrameRate,
	validateExportSettings,
	type ExportProject,
	type ExportSettings,
	type ExportSettingsIssue,
	type Size,
} from "./settings";

/**
 * Which export settings this machine can encode (plan P3 "Yoklama") and the
 * resolved plan. The WebCodecs answer is injected: the wiring passes
 * `VideoEncoder.isConfigSupported`, tests pass a fake.
 */

export type HardwareAcceleration = "no-preference" | "prefer-software";

/** Tried in this order; the first `true` wins. */
export const HARDWARE_ACCELERATION_CHAIN: readonly HardwareAcceleration[] = ["no-preference", "prefer-software"];

/** One `isConfigSupported` call may not hold the dialog longer than this. */
export const ENCODER_PROBE_TIMEOUT_MS = 5_000;

export interface EncoderQuery {
	codec: VideoCodecChoice;
	/**
	 * Full codec string for H.264 (`avc1.64xxyy` from the level). `null` for
	 * VP9: the wiring builds it (mediabunny derives the VP9 string itself).
	 */
	codecString: string | null;
	width: number;
	height: number;
	framerate: number;
	/** The "high" preset's bitrate for this size and rate. */
	bitrate: number;
	hardwareAcceleration: HardwareAcceleration;
}

export type IsEncoderConfigSupported = (query: EncoderQuery) => Promise<boolean>;

export interface VideoCapability {
	supported: boolean;
	hardwareAcceleration: HardwareAcceleration | null;
	/** Why it is not supported, ready to show. */
	reason: string | null;
}

export interface ExportCapabilities {
	video: Record<string, VideoCapability>;
	/** The wasm AAC encoder loaded (plan P1). */
	aacAvailable: boolean;
	/** WebCodecs can encode Opus. */
	opusAvailable: boolean;
}

const CODEC_LABEL: Record<VideoCodecChoice, string> = { avc: "H.264", vp9: "VP9" };
const CONTAINER_CODEC: Record<ExportFormat, VideoCodecChoice> = { mp4: "avc", webm: "vp9" };

const fpsLabel = (fps: number) => (Number.isInteger(fps) ? String(fps) : fps.toFixed(2));

export function capabilityKey({
	codec,
	width,
	height,
	fps,
}: {
	codec: VideoCodecChoice;
	width: number;
	height: number;
	fps: number;
}): string {
	return `${codec}:${width}x${height}@${fpsLabel(fps)}`;
}

async function probeOne({
	codec,
	size,
	fps,
	isConfigSupported,
	timers,
}: {
	codec: VideoCodecChoice;
	size: Size;
	fps: number;
	isConfigSupported: IsEncoderConfigSupported;
	timers: DeadlineTimers;
}): Promise<VideoCapability> {
	const bitrate = computeVideoBitrate({ ...size, fps, quality: { kind: "preset", quality: "high" }, codec });
	let codecString: string | null = null;
	if (codec === "avc") {
		const level = pickAvcLevel({ ...size, fps, bitrate });
		if (!level) {
			return {
				supported: false,
				hardwareAcceleration: null,
				reason: `${size.width}x${size.height} at ${fpsLabel(fps)} fps is above H.264 level 5.2.`,
			};
		}
		codecString = avcCodecString({ level });
	}

	const problems: string[] = [];
	for (const hardwareAcceleration of HARDWARE_ACCELERATION_CHAIN) {
		const answer = await withDeadline({
			run: () =>
				isConfigSupported({ codec, codecString, ...size, framerate: fps, bitrate, hardwareAcceleration }),
			ms: ENCODER_PROBE_TIMEOUT_MS,
			timers,
		});
		if (answer.status === "ok" && answer.value === true) {
			return { supported: true, hardwareAcceleration, reason: null };
		}
		if (answer.status === "error") {
			problems.push(answer.error instanceof Error ? answer.error.message : String(answer.error));
		} else if (answer.status === "timeout") {
			problems.push(`the encoder check did not answer within ${ENCODER_PROBE_TIMEOUT_MS / 1000} s`);
		}
	}
	const base = `This computer cannot encode ${CODEC_LABEL[codec]} at ${size.width}x${size.height}, ${fpsLabel(fps)} fps.`;
	return {
		supported: false,
		hardwareAcceleration: null,
		reason: problems.length > 0 ? `${base} (${[...new Set(problems)].join("; ")})` : base,
	};
}

/** Probes every size x rate x codec the settings can offer, one call at a time. */
export async function probeCapabilities({
	project,
	isConfigSupported,
	aacAvailable,
	opusAvailable,
	codecs = ["avc", "vp9"],
	timers = realTimers,
}: {
	project: ExportProject;
	isConfigSupported: IsEncoderConfigSupported;
	aacAvailable: boolean;
	opusAvailable: boolean;
	codecs?: readonly VideoCodecChoice[];
	timers?: DeadlineTimers;
}): Promise<ExportCapabilities> {
	const video: Record<string, VideoCapability> = {};
	for (const codec of codecs) {
		for (const size of resolutionChoices({ project })) {
			for (const { fps } of fpsChoices({ projectFps: project.fps })) {
				video[capabilityKey({ codec, width: size.width, height: size.height, fps })] = await probeOne({
					codec,
					size: { width: size.width, height: size.height },
					fps,
					isConfigSupported,
					timers,
				});
			}
		}
	}
	return { video, aacAvailable, opusAvailable };
}

export interface ExportPlan {
	container: ExportFormat;
	/** The project canvas size: what the compositor renders. */
	render: Size;
	/** Even, <= render. */
	output: Size;
	/** `output` differs from `render`: draw each frame onto a scaled 2D canvas. */
	scaledCanvas: boolean;
	fps: FrameRate;
	video: {
		codec: VideoCodecChoice;
		/** `null` for VP9 (see `EncoderQuery.codecString`). */
		fullCodecString: string | null;
		bitrate: number;
		hardwareAcceleration: HardwareAcceleration;
		keyFrameIntervalSec: number;
	};
	audio: null | { codec: AudioCodecChoice; bitrate: number; backend: "wasm" | "webcodecs" };
	estimate: FileSizeEstimate;
}

export interface PlanIssue {
	field: ExportSettingsIssue["field"];
	code: ExportSettingsIssue["code"] | "unsupported" | "not-probed" | "aac-unavailable" | "opus-unavailable";
	severity: "error" | "warning";
	message: string;
}

export type PlanResult =
	| { ok: true; plan: ExportPlan; warnings: PlanIssue[] }
	| { ok: false; issues: PlanIssue[] };

export function resolvePlan({
	settings,
	project,
	capabilities,
}: {
	settings: ExportSettings;
	project: ExportProject;
	capabilities: ExportCapabilities;
}): PlanResult {
	const validation: PlanIssue[] = validateExportSettings({ settings, project });
	const errors = validation.filter((issue) => issue.severity === "error");
	if (errors.length > 0) return { ok: false, issues: errors };
	const warnings = validation.filter((issue) => issue.severity === "warning");

	const codec = CONTAINER_CODEC[settings.container];
	const output = computeOutputSize({ project, resolution: settings.resolution });
	const rate = resolveFrameRate({ choice: settings.fps, projectFps: project.fps });
	const fps = frameRateToFloat(rate);
	const capability = capabilities.video[capabilityKey({ codec, ...output, fps })];
	if (!capability) {
		return {
			ok: false,
			issues: [
				{
					field: "resolution",
					code: "not-probed",
					severity: "error",
					message: "This combination was not checked with the encoder yet.",
				},
			],
		};
	}
	if (!capability.supported || !capability.hardwareAcceleration) {
		return {
			ok: false,
			issues: [
				{
					field: "resolution",
					code: "unsupported",
					severity: "error",
					message: capability.reason ?? "Not supported on this computer.",
				},
			],
		};
	}

	const bitrate = computeVideoBitrate({ ...output, fps, quality: settings.quality, codec });
	let fullCodecString: string | null = null;
	if (codec === "avc") {
		const level = pickAvcLevel({ ...output, fps, bitrate });
		// validateExportSettings already refused sizes without a level.
		if (!level) throw new Error("no H.264 level for a validated plan");
		fullCodecString = avcCodecString({ level });
	}

	let audio: ExportPlan["audio"] = null;
	if (settings.includeAudio) {
		const audioCodec = selectAudioCodec({ container: settings.container, aacAvailable: capabilities.aacAvailable });
		if (audioCodec === "aac") {
			audio = { codec: "aac", bitrate: settings.audioBitrate, backend: "wasm" };
		} else if (audioCodec === "opus" && capabilities.opusAvailable) {
			audio = { codec: "opus", bitrate: settings.audioBitrate, backend: "webcodecs" };
		} else {
			warnings.push(
				audioCodec === null
					? {
							field: "includeAudio",
							code: "aac-unavailable",
							severity: "warning",
							message: "The AAC encoder is not available: this MP4 will have no audio. Use WebM for audio.",
						}
					: {
							field: "includeAudio",
							code: "opus-unavailable",
							severity: "warning",
							message: "This computer cannot encode Opus: this WebM will have no audio.",
						},
			);
		}
	}

	return {
		ok: true,
		warnings,
		plan: {
			container: settings.container,
			render: { width: project.width, height: project.height },
			output,
			scaledCanvas: needsScaledCanvas({ render: { width: project.width, height: project.height }, output }),
			fps: rate,
			video: {
				codec,
				fullCodecString,
				bitrate,
				hardwareAcceleration: capability.hardwareAcceleration,
				keyFrameIntervalSec: KEYFRAME_INTERVAL_SECONDS,
			},
			audio,
			estimate: estimateFileBytes({
				videoBitrate: bitrate,
				audioBitrate: audio?.bitrate ?? null,
				durationSeconds: project.durationSeconds,
			}),
		},
	};
}
