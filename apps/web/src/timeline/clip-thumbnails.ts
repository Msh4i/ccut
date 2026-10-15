import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";

const TILE_WIDTH = 320;
// Same source second, same picture: a tenth of a second is finer than anyone can see in a tile.
const KEY_STEPS_PER_SECOND = 10;

type DecodeClipFrame = (args: {
	file: File;
	seconds: number;
}) => Promise<string | null>;

/**
 * One small picture per (video file, source second), decoded one at a time and
 * remembered. A failed decode is remembered too (null), so a file that cannot
 * be read is not retried for every redraw.
 */
export function createClipThumbnailCache({
	decode,
}: {
	decode: DecodeClipFrame;
}) {
	const cache = new Map<string, Promise<string | null>>();
	let queue: Promise<unknown> = Promise.resolve();

	return function getClipThumbnail({
		assetId,
		file,
		seconds,
	}: {
		assetId: string;
		file: File;
		seconds: number;
	}): Promise<string | null> {
		const key = `${assetId}:${Math.round(seconds * KEY_STEPS_PER_SECOND)}`;
		let pending = cache.get(key);
		if (!pending) {
			const next = queue.then(() =>
				decode({ file, seconds }).catch(() => null),
			);
			queue = next;
			pending = next;
			cache.set(key, pending);
		}
		return pending;
	};
}

async function decodeClipFrame({
	file,
	seconds,
}: {
	file: File;
	seconds: number;
}): Promise<string | null> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) return null;
		const frame = await new VideoSampleSink(track).getSample(seconds);
		if (!frame) return null;
		try {
			const height = Math.max(
				1,
				Math.round((TILE_WIDTH * track.displayHeight) / track.displayWidth),
			);
			const canvas = document.createElement("canvas");
			canvas.width = TILE_WIDTH;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (!context) return null;
			frame.draw(context, 0, 0, TILE_WIDTH, height);
			return canvas.toDataURL("image/jpeg", 0.7);
		} finally {
			frame.close();
		}
	} finally {
		input.dispose();
	}
}

export const getClipThumbnail = createClipThumbnailCache({
	decode: decodeClipFrame,
});
