/**
 * Experimental playback levers (docs/ccut/playback-p5-design.md section 1),
 * all off by default. Pure helpers; the persisted store is `store.ts`.
 *
 * - decodeWorker: decode the preview's video in Web Workers (lever a). Clips
 *   move at their next preview request; a worker failure turns it off for the session.
 * - bitmapUpload: ImageBitmap upload into one reused texture per layer (lever b, preview only).
 * - displayResolution: the preview compositor draws at display size while
 *   playing or scrubbing (lever c).
 *
 * Export, snapshot and thumbnails never take a lever path whatever these say.
 */
export type PlaybackLevers = {
	decodeWorker: boolean;
	bitmapUpload: boolean;
	displayResolution: boolean;
};

export const LEVER_KEYS = ["decodeWorker", "bitmapUpload", "displayResolution"] as const;

export type LeverKey = (typeof LEVER_KEYS)[number];

export const DEFAULT_PLAYBACK_LEVERS: PlaybackLevers = {
	decodeWorker: false,
	bitmapUpload: false,
	displayResolution: false,
};

export const LEVER_OPTIONS: ReadonlyArray<{
	key: LeverKey;
	label: string;
	description: string;
}> = [
	{
		key: "decodeWorker",
		label: "Decode in workers",
		description:
			"The preview decodes video in background threads (the main thread stays freer). Clips move to workers at their next preview request; if a worker fails the preview goes back to normal decoding until the app restarts. Export and snapshots always decode normally.",
	},
	{
		key: "bitmapUpload",
		label: "Reuse layer textures",
		description:
			"In the preview (playing, scrubbing or paused), a layer's picture is copied into the layer's existing GPU texture instead of a new one. Exports, snapshots and thumbnails are unchanged. Nothing in the app produces an ImageBitmap yet (it needs the decode-worker lever), so today this reuses textures of canvas pictures only.",
	},
	{
		key: "displayResolution",
		label: "Preview at display size",
		description:
			"While playing or scrubbing, the preview is composited at about its size on screen. Paused frames and exports stay full size.",
	},
];

/**
 * Stored levers -> levers: anything that is not exactly `true` or `false`
 * (a missing field, a value from a newer or hand-edited app) is off.
 */
export function parseLevers(value: unknown): PlaybackLevers {
	if (typeof value !== "object" || value === null) return { ...DEFAULT_PLAYBACK_LEVERS };
	const read = (key: LeverKey): boolean => Reflect.get(value, key) === true;
	return {
		decodeWorker: read("decodeWorker"),
		bitmapUpload: read("bitmapUpload"),
		displayResolution: read("displayResolution"),
	};
}

/** zustand persist `merge`: the stored levers go through parseLevers. */
export function mergePersistedLevers<TState extends { levers: PlaybackLevers }>({
	persisted,
	current,
}: {
	persisted: unknown;
	current: TState;
}): TState {
	const stored =
		typeof persisted === "object" && persisted !== null
			? Reflect.get(persisted, "levers")
			: undefined;
	return { ...current, levers: parseLevers(stored) };
}
