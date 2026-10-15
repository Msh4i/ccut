import type { FeatureTracks } from "./types";

/**
 * The buffers to list when posting `tracks` to a Worker (or back) so they move
 * instead of being copied: `postMessage(tracks, collectTransferables({ tracks }))`.
 * Each buffer is listed once however many arrays are views of it (listing one
 * twice throws), and a shared buffer is left out, as it is shared and not moved.
 *
 * The source is emptied by the transfer: every array of `tracks` and every view
 * made from one (like `homographyAt` gives of a solution's maps) has length 0
 * afterwards. Take a copy first if it is still needed.
 */
export function collectTransferables({ tracks }: { tracks: FeatureTracks }): ArrayBuffer[] {
	const arrays = [
		tracks.trackStart,
		tracks.trackLen,
		tracks.trackOffset,
		tracks.xy,
		tracks.liveOffsets,
		tracks.liveIds,
		tracks.stats.lostFraction,
	];
	const buffers: ArrayBuffer[] = [];
	for (const array of arrays) {
		const buffer = array.buffer;
		if (buffer instanceof ArrayBuffer && !buffers.includes(buffer)) buffers.push(buffer);
	}
	return buffers;
}
