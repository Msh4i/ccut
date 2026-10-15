import type { VideoCodec } from "mediabunny";
import { realTimers, withDeadline, type DeadlineTimers } from "./deadline";

/**
 * Import-time probe of a video file. The metadata (duration, size, fps, audio)
 * is required; the decodability check and the thumbnail are optional and run
 * on a decoder (WebCodecs), which can be slow, fail, or never answer. Neither
 * stage may hold the import forever.
 */

export const VIDEO_PROBE_LIMITS = {
	/**
	 * Container parsing only; a timeout here is reported as an error. Generous on purpose: a huge
	 * file without an index (fragmented MP4, MKV without cues) or one on a network drive can
	 * legitimately need a minute or more, and it used to import fine. 120 s separates "slow" from "hung".
	 */
	metadataMs: 120_000,
	/** Decodability check + first-frame decode; on timeout the import goes on without a thumbnail. */
	previewMs: 8_000,
} as const;

/** The parts of a mediabunny `InputVideoTrack` the probe uses. */
export interface ProbeVideoTrack {
	displayWidth: number;
	displayHeight: number;
	codec: VideoCodec | null;
	canDecode: () => Promise<boolean>;
	computePacketStats: (
		targetPacketCount: number,
	) => Promise<{ averagePacketRate: number }>;
}

/** The parts of a mediabunny `Input` the probe uses. */
export interface ProbeInput<Track extends ProbeVideoTrack> {
	computeDuration: () => Promise<number>;
	getPrimaryVideoTrack: () => Promise<Track | null>;
	getPrimaryAudioTrack: () => Promise<unknown>;
	dispose: () => void;
}

export type VideoPreviewIssue = "timeout" | "error";

export type VideoFileData = {
	duration: number;
	width: number;
	height: number;
	fps: number;
	hasAudio: boolean;
	codec: VideoCodec | null;
	/** `null` when the check did not answer in time. */
	canDecode: boolean | null;
	thumbnailUrl: string | null;
	/** Why there is no thumbnail although the codec was not known to be undecodable. */
	previewIssue: VideoPreviewIssue | null;
};

const PACKET_STATS_SAMPLE = 100;

export async function probeVideo<Track extends ProbeVideoTrack>({
	input,
	decodeThumbnail,
	timers = realTimers,
	limits = VIDEO_PROBE_LIMITS,
}: {
	input: ProbeInput<Track>;
	decodeThumbnail: ({ track }: { track: Track }) => Promise<string | null>;
	timers?: DeadlineTimers;
	limits?: { metadataMs: number; previewMs: number };
}): Promise<VideoFileData> {
	try {
		const metadata = await withDeadline({
			run: async () => {
				const duration = await input.computeDuration();
				const track = await input.getPrimaryVideoTrack();
				if (!track) {
					throw new Error("No video track found in the file");
				}
				const packetStats = await track.computePacketStats(PACKET_STATS_SAMPLE);
				const audioTrack = await input.getPrimaryAudioTrack();
				return {
					duration,
					track,
					fps: packetStats.averagePacketRate,
					hasAudio: audioTrack !== null,
				};
			},
			ms: limits.metadataMs,
			timers,
		});
		if (metadata.status === "timeout") {
			throw new Error(
				`Timed out reading the video's metadata after ${Math.round(limits.metadataMs / 1000)} s`,
			);
		}
		if (metadata.status === "error") {
			throw metadata.error;
		}
		const { duration, track, fps, hasAudio } = metadata.value;

		let canDecode: boolean | null = null;
		const preview = await withDeadline({
			run: async () => {
				canDecode = await track.canDecode();
				return canDecode ? decodeThumbnail({ track }) : null;
			},
			ms: limits.previewMs,
			timers,
		});

		return {
			duration,
			width: track.displayWidth,
			height: track.displayHeight,
			fps,
			hasAudio,
			codec: track.codec,
			canDecode,
			thumbnailUrl: preview.status === "ok" ? preview.value : null,
			previewIssue: preview.status === "ok" ? null : preview.status,
		};
	} finally {
		input.dispose();
	}
}
