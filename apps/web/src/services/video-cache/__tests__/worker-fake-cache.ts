import { createDecodeClient } from "../decode-worker/client";
import { createDecodeWorkerCore } from "../decode-worker/core";
import { createDecodeWorkers } from "../decode-worker/decode-workers";
import {
	createFakeChannel,
	createFakeClock,
	createImageBook,
} from "../decode-worker/__tests__/harness";
import type { FakeCanvas, createFakeVideo } from "./fake-video";
import {
	type MainSideStats,
	createWorkerControl,
	fakeAdapters,
	fakeBackendOver,
} from "./worker-fake-video";

/**
 * The `workers` of a `VideoCache` over one fake video: every `createClient`
 * starts a fake worker (core + fake channel + client) whose files are the
 * fake video. `state.on` is the lever; `state.created` counts the workers
 * started (the "no worker is constructed" check).
 */
export function createFakeDecodeWorkers({
	video,
	hardwareConcurrency = 12,
}: {
	video: ReturnType<typeof createFakeVideo>;
	hardwareConcurrency?: number;
}) {
	const state = { on: true, created: 0 };
	const worlds: Array<{
		core: ReturnType<typeof createDecodeWorkerCore>;
		client: ReturnType<typeof createDecodeClient>;
		channel: ReturnType<typeof createFakeChannel>;
		control: ReturnType<typeof createWorkerControl>;
	}> = [];
	const stats: MainSideStats = {
		bitmapsClosed: 0,
		bitmapsDoubleClosed: 0,
		mainSamplesClosed: 0,
		mainSamplesDoubleClosed: 0,
	};
	const book = createImageBook();
	const workers = createDecodeWorkers<FakeCanvas>({
		isOn: () => state.on,
		hardwareConcurrency: () => hardwareConcurrency,
		createClient: () => {
			state.created += 1;
			const channel = createFakeChannel();
			const control = createWorkerControl();
			const core = createDecodeWorkerCore({
				post: ({ message, transfer }) => {
					if (control.holdRenders && message.type === "rendered") {
						control.held.push({ message, transfer });
						return;
					}
					channel.worker.post({ message, transfer });
				},
				openBackend: async () => fakeBackendOver({ video, control }),
			});
			channel.worker.onMessage((data) => core.handle(data));
			control.releaseRenders = () => {
				control.holdRenders = false;
				for (const entry of control.held.splice(0)) channel.worker.post(entry);
			};
			const client = createDecodeClient({ channel: channel.main, clock: createFakeClock(), ops: book.ops });
			worlds.push({ core, client, channel, control });
			return client;
		},
		adapters: fakeAdapters({ video, stats, discard: book.ops }),
		closeImage: (image) => {
			if (image.destroyed) stats.bitmapsDoubleClosed += 1;
			image.destroyed = true;
			image.frame = null;
			stats.bitmapsClosed += 1;
		},
	});
	return { workers, state, worlds, stats };
}
