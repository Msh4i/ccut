import type { TrackType } from "@/timeline";

export const TIMELINE_AUDIO_WAVEFORM_COLOR = "rgba(255, 255, 255, 0.7)";

// White ticks with a thin dark halo: readable on dark, light and purple clips.
// Brand lime is forbidden on light backgrounds, so it is not used here.
export const TIMELINE_BEAT_MARKER_COLOR = "#ffffff";
export const TIMELINE_BEAT_MARKER_HALO_COLOR = "rgba(0, 0, 0, 0.65)";
// Picked ticks: yellow with the same dark halo, distinct from white on any clip colour.
export const TIMELINE_BEAT_MARKER_PICKED_COLOR = "#facc15";

export const TIMELINE_TRACK_THEME: Record<
	TrackType,
	{
		elementClassName: string;
		waveformColor?: string;
	}
> = {
	video: { elementClassName: "transparent" },
	text: { elementClassName: "bg-[#5DBAA0]" },
	audio: {
		elementClassName: "bg-[#8F5DBA]",
		waveformColor: TIMELINE_AUDIO_WAVEFORM_COLOR,
	},
	graphic: { elementClassName: "bg-[#BA5D7A]" },
	effect: { elementClassName: "bg-[#5d93ba]" },
	camera: { elementClassName: "bg-[#7a7f8c]" },
} as const;

export const SELECTED_TRACK_ROW_CLASS = "bg-accent/50";
export const DEFAULT_TIMELINE_BOOKMARK_COLOR = "#009dff";

export function getTimelineElementClassName({
	type,
}: {
	type: TrackType;
}): string {
	return TIMELINE_TRACK_THEME[type].elementClassName.trim();
}
