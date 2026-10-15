import { VideoSample } from "mediabunny";
import { playbackLevers } from "@/services/playback-levers/store";
import { wrapSample } from "../mediabunny-source";
import { createDecodeClient, DEFAULT_CLIENT_TIMEOUTS } from "./client";
import { type DecodeWorkers, createDecodeWorkers } from "./decode-workers";
import { spawnDecodeWorker } from "./spawn";

type AppCanvas = OffscreenCanvas | ImageBitmap;

/**
 * The decode workers of the app: switched by the "Decode in workers" lever
 * (Settings > Performance), read when a stream opens. Nothing here runs at
 * import: the pool, and with it the first Worker, starts when a preview stream
 * of a file needs one.
 */
export function createAppDecodeWorkers(): DecodeWorkers<AppCanvas> {
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	let nextTimer = 1;
	return createDecodeWorkers<AppCanvas>({
		isOn: () => playbackLevers().decodeWorker,
		hardwareConcurrency: () =>
			typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
		createClient: () =>
			createDecodeClient({
				channel: spawnDecodeWorker(),
				clock: {
					setTimer: ({ run, ms }) => {
						const id = nextTimer;
						nextTimer += 1;
						timers.set(
							id,
							setTimeout(() => {
								timers.delete(id);
								run();
							}, ms),
						);
						return id;
					},
					clearTimer: (handle) => {
						if (typeof handle !== "number") return;
						clearTimeout(timers.get(handle));
						timers.delete(handle);
					},
				},
				ops: { discard: (image) => closePicture(image.kind === "bitmap" ? image.bitmap : image.frame) },
				timeouts: DEFAULT_CLIENT_TIMEOUTS,
			}),
		adapters: {
			imageOf: (bitmap) => (bitmap instanceof ImageBitmap ? bitmap : null),
			sampleOf: ({ frame, rotation, display }) => {
				if (!(frame instanceof VideoFrame)) return null;
				try {
					return wrapSample({ sample: new VideoSample(frame), rotation, display });
				} catch (error) {
					frame.close();
					throw error;
				}
			},
			ops: { discard: (image) => closePicture(image.kind === "bitmap" ? image.bitmap : image.frame) },
		},
		closeImage: (image) => closePicture(image),
	});
}

function closePicture(picture: object): void {
	if (picture instanceof ImageBitmap || picture instanceof VideoFrame) picture.close();
}
