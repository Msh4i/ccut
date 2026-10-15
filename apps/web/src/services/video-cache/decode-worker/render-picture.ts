import { scaledFrameSize } from "../frame-scale";
import { type DrawableSample, wrapSample } from "../mediabunny-source";
import type { WireImage, WireRotation, WireVideoFrame } from "./protocol";

/** What the worker draws and transfers of a decoded sample. */
export type RenderableSample = DrawableSample & {
	/** mediabunny's `toVideoFrame()`: a VideoFrame, to be closed by whoever ends up with it. */
	toVideoFrame: () => WireVideoFrame;
};

/**
 * The picture of a decoded sample, made in the worker.
 *
 * Below full size: the sample is drawn into an OffscreenCanvas of the scaled
 * size by the SAME code the main thread draws a preview frame with
 * (`wrapSample`: fill fit, high smoothing, the track's rotation), and its pixels
 * leave as an ImageBitmap (`transferToImageBitmap`, which also empties the
 * canvas for the next one).
 *
 * At full size: a VideoFrame of the sample, transferred; the main thread draws
 * it with `wrapSample` too (paused frames come from today's drawing code).
 */
export function renderPicture({
	sample,
	scale,
	display,
	rotation,
	canvasFor,
}: {
	sample: RenderableSample;
	scale: number;
	display: { width: number; height: number };
	rotation: WireRotation;
	/** The worker's canvas of a size (kept between pictures). */
	canvasFor: ({ width, height }: { width: number; height: number }) => OffscreenCanvas;
}): { image: WireImage; transfer: object[] } {
	if (scale >= 1) {
		const frame = sample.toVideoFrame();
		return { image: { kind: "frame", frame }, transfer: [frame] };
	}
	const canvas = canvasFor(scaledFrameSize({ ...display, scale }));
	wrapSample({ sample, rotation, display }).drawInto(canvas);
	const bitmap = canvas.transferToImageBitmap();
	return { image: { kind: "bitmap", bitmap }, transfer: [bitmap] };
}

/**
 * The worker's canvases: one per picture size, the most recent few (a playback
 * that crosses a size uses two); the others are released at once (width and
 * height 0 free a canvas's backing in Chromium).
 */
export function createCanvasCache({
	create,
	max = 2,
}: {
	create: ({ width, height }: { width: number; height: number }) => OffscreenCanvas;
	max?: number;
}): {
	canvasFor: ({ width, height }: { width: number; height: number }) => OffscreenCanvas;
	clear: () => void;
	size: () => number;
} {
	const canvases = new Map<string, OffscreenCanvas>();
	const free = (canvas: OffscreenCanvas) => {
		canvas.width = 0;
		canvas.height = 0;
	};
	return {
		canvasFor: ({ width, height }) => {
			const key = `${width}x${height}`;
			const existing = canvases.get(key);
			if (existing) {
				// Most recent last.
				canvases.delete(key);
				canvases.set(key, existing);
				return existing;
			}
			const canvas = create({ width, height });
			canvases.set(key, canvas);
			for (const [oldKey, old] of canvases) {
				if (canvases.size <= max) break;
				canvases.delete(oldKey);
				free(old);
			}
			return canvas;
		},
		clear: () => {
			for (const canvas of canvases.values()) free(canvas);
			canvases.clear();
		},
		size: () => canvases.size,
	};
}
