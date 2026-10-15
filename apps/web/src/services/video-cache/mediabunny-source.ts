import {
	ALL_FORMATS,
	BlobSource,
	EncodedPacketSink,
	Input,
	type Rotation,
	type VideoSample,
	VideoSampleSink,
} from "mediabunny";
import {
	DEFAULT_FRAME_BYTES,
	type DecodedFrame,
	type FrameIterator,
	type FrameSource,
} from "./frame-stream";
import { scaledFrameSize } from "./frame-scale";

/**
 * Opens a video file for the frame cache.
 *
 * Frames come from mediabunny's `VideoSampleSink` (its decoder reads a few
 * frames ahead by itself) and are drawn by the cache only when it shows them,
 * into OffscreenCanvases of the video's display size. This replaces
 * `CanvasSink`, which drew EVERY decoded frame into an HTMLCanvasElement (also
 * the ones playback skips) and made the compositor copy each shown frame into
 * a new OffscreenCanvas before the GPU upload.
 *
 * The drawing is the one `CanvasSink` did with `fit: "contain"` at the track's
 * own size: an opaque 2D context, the track's rotation, `drawWithFit`. A canvas
 * smaller than that (the preview while it plays, `frame-scale.ts`) gets the
 * same picture stretched over it with `fit: "fill"` and the high-quality
 * smoothing filter (an averaging one; the default bilinear aliases a frame
 * shrunk by more than 2).
 */
export async function openMediabunnySource({
	file,
	onCanvasLost,
}: {
	file: File;
	/** A canvas of the file lost its 2D context (its pixels are gone): see `watchContextLoss`. */
	onCanvasLost?: () => void;
}): Promise<FrameSource<OffscreenCanvas>> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) {
			throw new Error("No video track found");
		}
		if (!(await track.canDecode())) {
			throw new Error("Video codec not supported for decoding");
		}

		const samples = new VideoSampleSink(track);
		const packets = new EncodedPacketSink(track);
		const rotation = track.rotation;
		const quarterTurn = rotation % 180 !== 0;
		const width = quarterTurn ? track.squarePixelHeight : track.squarePixelWidth;
		const height = quarterTurn ? track.squarePixelWidth : track.squarePixelHeight;

		return {
			frameBytes: frameBytesOf({
				codedWidth: track.codedWidth,
				codedHeight: track.codedHeight,
				width,
				height,
			}),
			displaySize: { width, height },
			openIterator: ({ startTime }) =>
				wrapSamples({
					samples: samples.samples(startTime),
					rotation,
					display: { width, height },
				}),
			keyframeAtOrBefore: async ({ time }) => {
				const packet = await packets.getKeyPacket(time, { metadataOnly: true });
				return packet ? packet.timestamp : null;
			},
			createCanvas: ({ scale }) => {
				const canvas = createFrameCanvas(scaledFrameSize({ width, height, scale }));
				watchContextLoss({ canvas, onLost: onCanvasLost });
				return canvas;
			},
			destroyCanvas: ({ canvas }) => shrinkCanvas({ canvas }),
			dispose: () => input.dispose(),
		};
	} catch (error) {
		input.dispose();
		throw error;
	}
}

/**
 * Memory of one frame of the track. Decoded: coded size x 1.5 (8-bit 4:2:0,
 * what H.264/HEVC/VP9/AV1 decoders hand out for ordinary video; 10-bit or
 * 4:4:4 needs more, an underestimate there). Drawn: the canvas, RGBA.
 */
export function frameBytesOf({
	codedWidth,
	codedHeight,
	width,
	height,
}: {
	codedWidth: number;
	codedHeight: number;
	width: number;
	height: number;
}): { decoded: number; drawn: number } {
	const positive = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
	const decoded = positive(codedWidth) * positive(codedHeight) * 1.5;
	const drawn = positive(width) * positive(height) * 4;
	return {
		decoded: decoded > 0 ? decoded : DEFAULT_FRAME_BYTES.decoded,
		drawn: drawn > 0 ? drawn : DEFAULT_FRAME_BYTES.drawn,
	};
}

/**
 * Calls `onLost` each time `canvas` loses its 2D context (Chromium fires
 * `contextlost` on a canvas whose GPU-backed pixels were lost, a GPU process
 * restart for instance; whether it does so for an OffscreenCanvas in this
 * Electron is NOT verified). Its pixels are blank from then on.
 */
export function watchContextLoss({
	canvas,
	onLost,
}: {
	canvas: EventTarget;
	onLost: (() => void) | undefined;
}): void {
	if (!onLost) return;
	canvas.addEventListener("contextlost", () => onLost());
}

/**
 * Frees a canvas's backing at once: Chromium releases the buffer of a canvas
 * resized to 0 x 0, where a dropped canvas would hold it until the garbage
 * collector ran. Only for a canvas no render can still upload (the wgpu copy
 * of a canvas resized meanwhile fails validation).
 */
export function shrinkCanvas({ canvas }: { canvas: { width: number; height: number } }): void {
	canvas.width = 0;
	canvas.height = 0;
}

function createFrameCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas {
	if (typeof OffscreenCanvas === "undefined") {
		throw new Error("OffscreenCanvas is required to show video frames");
	}
	return new OffscreenCanvas(width, height);
}

function wrapSamples({
	samples,
	rotation,
	display,
}: {
	samples: AsyncGenerator<VideoSample, void, unknown>;
	rotation: Rotation;
	display: { width: number; height: number };
}): FrameIterator<OffscreenCanvas> {
	return {
		next: async () => {
			const result = await samples.next();
			if (result.done) {
				return { done: true, value: undefined };
			}
			return {
				done: false,
				value: wrapSample({ sample: result.value, rotation, display }),
			};
		},
		// mediabunny's iterator returns at once and ends a pending `next`.
		return: () => samples.return(undefined),
	};
}

/** How a frame is drawn into a canvas: at the display size as always, or shrunk onto a smaller one. */
export type FrameDrawPlan = { fit: "contain" } | { fit: "fill"; quality: "high" };

/**
 * The canvas decides: one of the display size is drawn exactly as before
 * (contain fit, the context left as it is); a smaller one gets the whole frame
 * stretched over it, so rounding the size to whole pixels cannot letterbox it.
 */
export function frameDrawPlan({
	canvas,
	display,
}: {
	canvas: { width: number; height: number };
	display: { width: number; height: number };
}): FrameDrawPlan {
	const native = canvas.width === display.width && canvas.height === display.height;
	return native ? { fit: "contain" } : { fit: "fill", quality: "high" };
}

/** What `wrapSample` uses of a mediabunny VideoSample. */
export type DrawableSample = Pick<
	VideoSample,
	"timestamp" | "duration" | "close" | "drawWithFit"
>;

export function wrapSample({
	sample,
	rotation,
	display,
}: {
	sample: DrawableSample;
	rotation: Rotation;
	display: { width: number; height: number };
}): DecodedFrame<OffscreenCanvas> {
	return {
		timestamp: sample.timestamp,
		duration: sample.duration,
		drawInto: (canvas) => {
			const context = canvas.getContext("2d", { alpha: false });
			if (!context) {
				throw new Error("Failed to get a 2d context for a video frame");
			}
			context.resetTransform();
			context.clearRect(0, 0, canvas.width, canvas.height);
			const plan = frameDrawPlan({ canvas, display });
			if (plan.fit === "fill") {
				context.imageSmoothingEnabled = true;
				context.imageSmoothingQuality = plan.quality;
			}
			sample.drawWithFit(context, { fit: plan.fit, rotation });
		},
		close: () => sample.close(),
	};
}
