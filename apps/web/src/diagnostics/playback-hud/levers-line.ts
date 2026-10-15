import type { PlaybackLevers } from "@/services/playback-levers/levers";

/**
 * The playback HUD's levers line (pure; `recorder.ts` shows it in the overlay
 * and the dump). The display-size, bitmap and decode-worker levers have numbers; each says
 * `n/a` until it has some.
 */
export type HudWorkerStats = {
	/** Workers running now, and the most the pool starts. */
	live: number;
	cap: number;
	/** Streams that moved back to the main thread after a worker failed. */
	fallbacks: number;
	/** A worker failed: the lever is off for the rest of the session. */
	tripped: boolean;
};

export type HudDisplaySize = {
	/** Size of the compositor frame of the last preview draw (device pixels). */
	width: number;
	height: number;
	/** Its share of the project size (1: full size). */
	scale: number;
};

/** Texture uploads of the bitmap lever since start (compositor `getUploadStats`). */
export type HudBitmapStats = {
	/** Uploads copied into the layer's existing texture. */
	reused: number;
	/** Uploads that created a texture. */
	created: number;
	/** Sources copied through a staging canvas first. */
	staging: number;
};

function formatScale(scale: number): string {
	return Number.isFinite(scale) ? String(Number(scale.toFixed(3))) : "-";
}

function formatWorker({
	on,
	workers,
}: {
	on: boolean;
	workers: HudWorkerStats | null | undefined;
}): string {
	if (!on) return "worker off";
	if (!workers) return "worker on n/a";
	if (workers.tripped) return `worker tripped fallbacks ${workers.fallbacks}`;
	return `worker on ${workers.live}/${workers.cap} fallbacks ${workers.fallbacks}`;
}

export function formatLeversLine({
	levers,
	display,
	bitmap,
	workers,
}: {
	levers: PlaybackLevers;
	/** The last preview draw; null before the first one. */
	display: HudDisplaySize | null;
	/** The compositor's upload counters; null before the first preview draw. */
	bitmap: HudBitmapStats | null;
	/** The decode workers' numbers; none (null): the lever has nothing to show. */
	workers?: HudWorkerStats | null;
}): string {
	const worker = formatWorker({ on: levers.decodeWorker, workers });
	const bitmapPart = !levers.bitmapUpload
		? "bitmap off"
		: bitmap === null
			? "bitmap on n/a"
			: `bitmap on reused ${bitmap.reused} created ${bitmap.created} staging ${bitmap.staging}`;
	const size =
		display === null
			? "n/a"
			: `${display.width}x${display.height} (x${formatScale(display.scale)})`;
	const displayPart = levers.displayResolution ? `display on ${size}` : "display off";
	return `levers: ${worker} | ${bitmapPart} | ${displayPart}`;
}
