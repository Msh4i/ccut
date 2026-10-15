/**
 * Pre-roll across clip boundaries. A new clip's first picture needs its decoder to run from the
 * previous key frame up to the clip's start; with a key frame every ~6 s that is up to 360 frames
 * (1.4 s at 4 ms per frame), so it must start BEFORE the playhead reaches the boundary. This
 * picks the clips to open ahead: the ones that start within the horizon, nearest first.
 */
export type UpcomingClip = {
	/** The timeline element id (its stream's owner key). */
	key: string;
	mediaId: string;
	/** Timeline second at which the clip starts. */
	start: number;
	/** Second of the source media of the clip's first frame. */
	sourceStart: number;
};

export const PREROLL = { horizonSeconds: 5, maxClips: 4 } as const;

export function planPreroll({
	clips,
	time,
	horizonSeconds = PREROLL.horizonSeconds,
	maxClips = PREROLL.maxClips,
}: {
	clips: readonly UpcomingClip[];
	time: number;
	horizonSeconds?: number;
	maxClips?: number;
}): UpcomingClip[] {
	return clips
		.filter((clip) => clip.start > time && clip.start <= time + horizonSeconds)
		.sort((a, b) => a.start - b.start)
		.slice(0, maxClips);
}
