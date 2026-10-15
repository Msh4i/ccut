import { videoCache } from "@/services/video-cache/service";
import { letterboxLayout } from "./matte-math";
import type { CutoutDeps } from "./run-cutout";

/** Frames larger than this (pixels wide) are requested smaller: the model sees 320 pixels anyway. */
const MAX_REQUEST_WIDTH = 640;

/** Draws the clip's frames, one at a time, letterboxed into the model's square. */
export function createFrameGrabber({
	mediaId,
	file,
	streamKey,
	mediaWidth,
	mediaHeight,
}: {
	mediaId: string;
	file: File;
	streamKey: string;
	mediaWidth: number;
	mediaHeight: number;
}): CutoutDeps["grab"] {
	let canvas: OffscreenCanvas | null = null;
	return async ({ sourceSeconds, size }) => {
		canvas ??= new OffscreenCanvas(size, size);
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) throw new Error("No 2D canvas for the cutout.");
		const lease = videoCache.beginRender();
		try {
			const frame = await videoCache.getFrameAt({
				mediaId,
				file,
				time: sourceSeconds,
				streamKey,
				scale: Math.min(1, MAX_REQUEST_WIDTH / Math.max(1, mediaWidth)),
				lease,
			});
			if (!frame) throw new Error("The video frame could not be read.");
			const box = letterboxLayout({ width: mediaWidth, height: mediaHeight, size });
			ctx.fillStyle = "#000";
			ctx.fillRect(0, 0, size, size);
			ctx.drawImage(frame.canvas, box.x, box.y, box.width, box.height);
			return ctx.getImageData(0, 0, size, size).data;
		} finally {
			videoCache.endRender({ lease });
		}
	};
}
