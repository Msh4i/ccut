import { createDecodeWorkerCore } from "./core";
import { openMediabunnyBackend } from "./worker-backend";

/**
 * Entry of a decode worker (module worker, bundled like the beat-detection and
 * transcription workers: `new Worker(new URL("./worker.ts", import.meta.url))`
 * in `spawn.ts`). All logic is in `core.ts`; this only connects it to
 * mediabunny and to `postMessage`.
 */
const core = createDecodeWorkerCore({
	post: ({ message, transfer }) => {
		self.postMessage(message, { transfer: transfer.filter(isTransferable) });
	},
	openBackend: ({ file }) => openMediabunnyBackend({ file }),
});

self.addEventListener("message", (event: MessageEvent<unknown>) => {
	core.handle(event.data);
});

function isTransferable(value: object): value is ImageBitmap | VideoFrame {
	return value instanceof ImageBitmap || value instanceof VideoFrame;
}
