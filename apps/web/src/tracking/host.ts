import { getElementLocalTime } from "@/animation";
import { applyPresetsAtTime } from "@/animation/presets";
import {
	getVisualElementBounds,
	type ElementBounds,
} from "@/preview/element-bounds";
import { buildTransformFromParams } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { clampRetimeRate } from "@/retime/rate";
import type { SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import { mediaTimeToSeconds, TICKS_PER_SECOND } from "@/wasm";

/** What a track needs to know about the video clip it was taken from. */
export type HostTimingClip = Pick<
	VideoElement,
	"mediaId" | "startTime" | "duration" | "trimStart" | "retime"
>;

/** Plus what is needed to place its picture on the canvas. */
export type HostBoundsClip = HostTimingClip &
	Pick<VideoElement, "params" | "animations" | "presetAnimations">;

/** The clip's playback rate, as the renderer clamps it. */
export function hostRate({ host }: { host: HostTimingClip }): number {
	return clampRetimeRate({ rate: host.retime?.rate ?? 1 });
}

/**
 * Where in the source media (seconds) the first sample of a track taken
 * `clipStartSec` into the clip lands.
 */
export function trackedSourceStart({
	host,
	clipStartSec,
}: {
	host: HostTimingClip;
	clipStartSec: number;
}): number {
	return (
		mediaTimeToSeconds({ time: host.trimStart }) +
		clipStartSec * hostRate({ host })
	);
}

/** The element with this id wherever it lives now, and the track it is on. */
export function findElementInTracks({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): { trackId: string; element: TimelineElement } | null {
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements) {
			if (element.id === elementId) {
				return { trackId: track.id, element };
			}
		}
	}
	return null;
}

/**
 * Where a video clip's picture sits on the canvas at a timeline time
 * (seconds): its own transform and keyframes, then its In/Out preset, the same
 * way the renderer lays them out.
 */
export function buildHostBoundsAt({
	host,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	host: HostBoundsClip;
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
}): (seconds: number) => ElementBounds {
	const baseTransform = buildTransformFromParams({ params: host.params });
	const containScale = Math.min(
		canvasWidth / sourceWidth,
		canvasHeight / sourceHeight,
	);
	const fittedWidth = sourceWidth * containScale;
	const fittedHeight = sourceHeight * containScale;
	return (seconds) => {
		const localTime = getElementLocalTime({
			timelineTime: seconds * TICKS_PER_SECOND,
			elementStartTime: host.startTime,
			elementDuration: host.duration,
		});
		const { transform } = applyPresetsAtTime({
			presetAnimations: host.presetAnimations,
			localTime,
			duration: host.duration,
			canvasWidth,
			canvasHeight,
			transform: resolveTransformAtTime({
				baseTransform,
				animations: host.animations,
				localTime,
			}),
			opacity: 1,
			rect: {
				left: -fittedWidth / 2,
				top: -fittedHeight / 2,
				width: fittedWidth,
				height: fittedHeight,
			},
		});
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth,
			sourceHeight,
			transform,
		});
	};
}
