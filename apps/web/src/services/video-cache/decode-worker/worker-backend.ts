import {
	ALL_FORMATS,
	BlobSource,
	Input,
	type VideoSample,
	VideoSampleSink,
} from "mediabunny";
import { frameBytesOf } from "../mediabunny-source";
import type { WorkerBackend } from "./core";
import { createCanvasCache, renderPicture } from "./render-picture";

/**
 * A file opened in a decode worker: the same mediabunny Input, track checks and
 * sample sink as `openMediabunnySource` on the main thread, with the picture
 * made by `renderPicture`. Runs only inside the worker (`worker.ts`); not
 * unit-tested (it needs a real file and WebCodecs): the real window checks it.
 */
export async function openMediabunnyBackend({
	file,
}: {
	file: object;
}): Promise<WorkerBackend<VideoSample>> {
	if (!(file instanceof Blob)) throw new Error("The decode worker was not given a file");
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error("No video track found");
		if (!(await track.canDecode())) throw new Error("Video codec not supported for decoding");
		const sink = new VideoSampleSink(track);
		const rotation = track.rotation;
		const quarterTurn = rotation % 180 !== 0;
		const width = quarterTurn ? track.squarePixelHeight : track.squarePixelWidth;
		const height = quarterTurn ? track.squarePixelWidth : track.squarePixelHeight;
		const display = { width, height };
		const canvases = createCanvasCache({
			create: (size) => new OffscreenCanvas(size.width, size.height),
		});
		return {
			displaySize: display,
			frameBytes: frameBytesOf({
				codedWidth: track.codedWidth,
				codedHeight: track.codedHeight,
				width,
				height,
			}),
			rotation,
			samples: ({ startTime }) => {
				const samples = sink.samples(startTime);
				return {
					next: () => samples.next(),
					// mediabunny's iterator returns at once and ends a pending `next`.
					return: () => samples.return(undefined),
				};
			},
			render: ({ sample, scale }) =>
				renderPicture({ sample, scale, display, rotation, canvasFor: canvases.canvasFor }),
			dispose: () => {
				canvases.clear();
				input.dispose();
			},
		};
	} catch (error) {
		input.dispose();
		throw error;
	}
}
