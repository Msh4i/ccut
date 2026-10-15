import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { GrayFrame } from "./types";

/** Tracking runs on a frame at most this wide, the original is never needed. */
const MAX_WORK_WIDTH = 480;

/**
 * Working frame size: at most `maxWidth` (default `MAX_WORK_WIDTH`) wide,
 * aspect ratio kept, never upscaled.
 */
export function workSize({
	width,
	height,
	maxWidth = MAX_WORK_WIDTH,
}: {
	width: number;
	height: number;
	maxWidth?: number;
}): { width: number; height: number } {
	const workWidth = Math.max(1, Math.min(Math.floor(maxWidth), width));
	return {
		width: workWidth,
		height: Math.max(1, Math.round((workWidth * height) / width)),
	};
}

/**
 * Rec. 601 luma of RGBA pixels into `out`, one byte per pixel, as many as
 * `out` holds. The weights add up to 256, so a gray pixel comes out unchanged.
 */
export function lumaFromRgba({
	rgba,
	out,
}: {
	rgba: ArrayLike<number>;
	out: Uint8Array;
}): void {
	for (let i = 0, j = 0; i < out.length; i++, j += 4) {
		out[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
	}
}

/**
 * Decodes `file` at the given source times (seconds, ascending) into small
 * gray frames, one per time, a time without a frame repeating the previous
 * one. Owns its own `Input`, so it never disturbs the preview's video cache,
 * and releases it when the consumer stops or finishes, or when `signal`
 * aborts: that disposes the input at once, so a read that is stuck on it
 * rejects instead of keeping the generator (and the file) alive for good.
 * Every yielded frame is the same object: it is only valid until the next one
 * is requested.
 */
export async function* decodeGrayFrames({
	file,
	sourceTimes,
	signal,
	maxWidth,
}: {
	file: File;
	sourceTimes: Iterable<number>;
	signal?: AbortSignal;
	/** Widest working frame (default 480 px). */
	maxWidth?: number;
}): AsyncGenerator<GrayFrame, void, undefined> {
	if (signal?.aborted) return;
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});
	const disposeOnAbort = () => input.dispose();
	signal?.addEventListener("abort", disposeOnAbort, { once: true });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) {
			throw new Error("No video track found");
		}
		if (!(await track.canDecode())) {
			throw new Error("Video codec not supported for decoding");
		}

		const { width, height } = workSize({
			width: track.displayWidth,
			height: track.displayHeight,
			maxWidth,
		});
		const context = new OffscreenCanvas(width, height).getContext("2d", {
			willReadFrequently: true,
		});
		if (!context) {
			throw new Error("2D canvas is not available");
		}

		const frame: GrayFrame = {
			w: width,
			h: height,
			data: new Uint8Array(width * height),
		};
		let hasFrame = false;
		for await (const sample of new VideoSampleSink(track).samplesAtTimestamps(
			sourceTimes,
		)) {
			if (sample) {
				try {
					sample.draw(context, 0, 0, width, height);
				} finally {
					sample.close();
				}
				lumaFromRgba({
					rgba: context.getImageData(0, 0, width, height).data,
					out: frame.data,
				});
				hasFrame = true;
			} else if (!hasFrame) {
				throw new Error("The video has no frame at the tracking start");
			}
			yield frame;
		}
	} finally {
		signal?.removeEventListener("abort", disposeOnAbort);
		input.dispose();
	}
}
