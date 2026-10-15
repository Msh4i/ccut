import type { Channel } from "./client";

/**
 * Starts a decode worker and wraps it as a `Channel`. The only place a Worker
 * is constructed for decoding; it is called only when a stream needs a worker
 * (`DecodeWorkerPool`), never at import and never with the lever off.
 *
 * The `new Worker(new URL(...))` form is what the bundler recognises (as in
 * beat-detection/service.ts and transcription/service.ts); the app's CSP
 * already allows `worker-src 'self' blob:` for every ccut:// response.
 */
export function spawnDecodeWorker(): Channel {
	const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
	return {
		post: ({ message, transfer = [] }) => {
			worker.postMessage(message, { transfer: transfer.filter(isTransferable) });
		},
		onMessage: (handler) => {
			worker.addEventListener("message", (event) => handler(event.data));
		},
		onFailure: (handler) => {
			worker.addEventListener("error", (event) => handler(event.message || "worker error"));
			worker.addEventListener("messageerror", () => handler("a message could not be read"));
		},
		terminate: () => worker.terminate(),
	};
}

/** What a transfer list may hold: a picture or a VideoFrame (never a File: that is copied by reference). */
export function isTransferable(value: object): value is ImageBitmap | VideoFrame {
	return (
		(typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) ||
		(typeof VideoFrame !== "undefined" && value instanceof VideoFrame)
	);
}
