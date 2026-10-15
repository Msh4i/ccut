import type { MediaAsset } from "@/media/types";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import type { AudioElement, TimelineElement, TimelineTrack, VideoElement } from "@/timeline";
import {
	doesElementHaveEnabledAudio,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import { canElementHaveAudio } from "@/timeline/element-utils";

export interface BeatTarget {
	trackId: string;
	element: AudioElement | VideoElement;
	/** `null` for library sounds, and for uploads whose asset is gone. */
	mediaAsset: MediaAsset | null;
	/** Clips of the same source media share one analysis. */
	sourceKey: string;
}

/** Why the beat button is on, off, or unavailable for the current selection. */
export type BeatButtonState =
	| "ready"
	| "active"
	| "no-clip"
	| "separated-audio"
	| "no-audio";

/**
 * The selected clips that can carry beats: audio clips and videos whose own
 * audio is on. A video with separated audio is skipped, its extracted audio
 * clip holds the beats.
 */
export function getBeatSelection({
	selected,
	mediaAssets,
}: {
	selected: Array<{ track: TimelineTrack; element: TimelineElement }>;
	mediaAssets: MediaAsset[];
}): { targets: BeatTarget[]; state: BeatButtonState } {
	const targets: BeatTarget[] = [];
	let blocked: "separated-audio" | "no-audio" | null = null;
	for (const { track, element } of selected) {
		if (!canElementHaveAudio(element)) {
			continue;
		}
		const { mediaAsset, sourceKey } = resolveSource({ element, mediaAssets });
		if (!doesElementHaveEnabledAudio({ element, mediaAsset })) {
			if (element.type === "video" && isSourceAudioSeparated({ element })) {
				blocked = "separated-audio";
			} else {
				blocked ??= "no-audio";
			}
			continue;
		}
		targets.push({ trackId: track.id, element, mediaAsset, sourceKey });
	}

	if (targets.length === 0) {
		return { targets, state: blocked ?? "no-clip" };
	}
	return {
		targets,
		state: targets.every((target) => target.element.beats) ? "active" : "ready",
	};
}

/** True when `targets` all come from one source media (and there is at least one). */
export function isOneSource({ targets }: { targets: BeatTarget[] }): boolean {
	return targets.length > 0 && new Set(targets.map((target) => target.sourceKey)).size === 1;
}

function resolveSource({
	element,
	mediaAssets,
}: {
	element: AudioElement | VideoElement;
	mediaAssets: MediaAsset[];
}): Pick<BeatTarget, "mediaAsset" | "sourceKey"> {
	if (element.type === "audio" && element.sourceType === "library") {
		return {
			mediaAsset: null,
			sourceKey: buildWaveformSourceKey({ kind: "library", id: element.sourceUrl }),
		};
	}
	return {
		mediaAsset: mediaAssets.find((asset) => asset.id === element.mediaId) ?? null,
		sourceKey: buildWaveformSourceKey({ kind: "media", id: element.mediaId }),
	};
}
