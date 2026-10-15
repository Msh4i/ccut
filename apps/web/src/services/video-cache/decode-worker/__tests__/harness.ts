import {
	type SampleIterator,
	type WorkerBackend,
	type WorkerSample,
	createDecodeWorkerCore,
} from "../core";
import {
	type Channel,
	type ImageOps,
	type TimerClock,
	createDecodeClient,
} from "../client";
import type { FromWorkerMessage, ToWorkerMessage, WireImage } from "../protocol";
import { scaledFrameSize } from "../../frame-scale";

/** Lets every message hop (setImmediate delivery) and every queued reaction run, `hops` times. */
export async function settleHops(hops = 6): Promise<void> {
	for (let hop = 0; hop < hops; hop++) {
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
	}
}

/** A deterministic random generator (mulberry32). */
export function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A clock whose timers fire only when the test advances it. */
export function createFakeClock(): TimerClock & { advance: (ms: number) => void; pending: () => number } {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; run: () => void }>();
	return {
		setTimer: ({ run, ms }) => {
			const id = nextId;
			nextId += 1;
			timers.set(id, { at: now + ms, run });
			return id;
		},
		clearTimer: (handle) => {
			if (typeof handle === "number") timers.delete(handle);
		},
		advance: (ms) => {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now && timers.delete(id)) timer.run();
			}
		},
		pending: () => timers.size,
	};
}

/** What the fake pictures look like: plain data, so `structuredClone` can copy them. */
export type FakeImage = { id: number; width: number; height: number; detached: boolean };

/**
 * `structuredClone` of a message. A File travels by reference (a real clone of a
 * Blob is a reference to the same bytes; bun cannot clone one at all).
 */
function cloneMessage(data: unknown): unknown {
	if (typeof data === "object" && data !== null) {
		const file = Reflect.get(data, "file");
		if (file instanceof Blob) {
			return { ...structuredClone({ ...data, file: undefined }), file };
		}
	}
	return structuredClone(data);
}

/**
 * A channel pair: messages are structured-cloned and delivered with
 * setImmediate, and every object in a transfer list is marked `detached` on the
 * SENDER after the copy (what a real transfer does). Posting a detached object
 * throws, like a DataCloneError.
 */
export function createFakeChannel() {
	let toWorker: (data: unknown) => void = () => {};
	let toMain: (data: unknown) => void = () => {};
	let failureHandler: (reason: string) => void = () => {};
	const state = { terminated: false, posted: [] as ToWorkerMessage[] };

	function deliver({
		data,
		transfer,
		target,
	}: {
		data: unknown;
		transfer: readonly object[];
		target: () => (data: unknown) => void;
	}): void {
		for (const object of transfer) {
			if (Reflect.get(object, "detached") === true) throw new Error("DataCloneError: already detached");
		}
		const copy = cloneMessage(data);
		for (const object of transfer) Reflect.set(object, "detached", true);
		setImmediate(() => {
			if (!state.terminated) target()(copy);
		});
	}

	const main: Channel = {
		post: ({ message, transfer = [] }) => {
			if (state.terminated) return;
			state.posted.push(message);
			deliver({ data: message, transfer, target: () => toWorker });
		},
		onMessage: (handler) => {
			toMain = handler;
		},
		onFailure: (handler) => {
			failureHandler = handler;
		},
		terminate: () => {
			state.terminated = true;
		},
	};
	const worker = {
		onMessage: (handler: (data: unknown) => void) => {
			toWorker = handler;
		},
		post: ({ message, transfer = [] }: { message: unknown; transfer?: readonly object[] }) => {
			if (state.terminated) return;
			deliver({ data: message, transfer, target: () => toMain });
		},
		/** The worker crashes: the main side hears of it. */
		crash: (reason: string) => failureHandler(reason),
	};
	return { main, worker, state };
}

export type FakeSample = WorkerSample & { id: number };

export type BackendLog = {
	created: number;
	closed: Map<number, number>;
	doubleClosed: number;
	renders: Array<{ sample: number; scale: number }>;
	images: FakeImage[];
	iterators: number;
	returned: number;
	disposed: number;
	/** Renders of a sample that was already closed. */
	renderedClosed: number;
};

/**
 * A worker's media: `frames` samples at `fps`, decoded instantly (or when the
 * test opens `gate`), pictures as plain fake objects.
 */
export function createFakeBackend({
	frames = 1000,
	fps = 30,
	display = { width: 1920, height: 1080 },
	gate,
	bitmapGrowth = 0,
}: {
	/** Pixels the worker's bitmaps are too wide by (a worker that disagrees about the size). */
	bitmapGrowth?: number;
	frames?: number;
	fps?: number;
	display?: { width: number; height: number };
	/** When set, `next` waits for it after decoding a frame (a decoder slow to hand it over). */
	gate?: () => Promise<void>;
} = {}) {
	const log: BackendLog = {
		created: 0,
		closed: new Map(),
		doubleClosed: 0,
		renders: [],
		images: [],
		iterators: 0,
		returned: 0,
		disposed: 0,
		renderedClosed: 0,
	};
	let nextSampleId = 1;
	let nextImageId = 1;

	function makeSample(index: number): FakeSample {
		const id = nextSampleId;
		nextSampleId += 1;
		log.created += 1;
		return {
			id,
			timestamp: index / fps,
			duration: 1 / fps,
			close: () => {
				const count = log.closed.get(id) ?? 0;
				if (count > 0) log.doubleClosed += 1;
				log.closed.set(id, count + 1);
			},
		};
	}

	const backend: WorkerBackend<FakeSample> = {
		displaySize: display,
		frameBytes: { decoded: 1, drawn: 1 },
		rotation: 0,
		samples: ({ startTime }) => {
			log.iterators += 1;
			let index = Math.max(0, Math.min(frames - 1, Math.floor(startTime * fps + 1e-9)));
			let stopped = false;
			const iterator: SampleIterator<FakeSample> = {
				next: async () => {
					if (stopped || index >= frames) return { done: true, value: undefined };
					// The decoder has the frame; with a gate it hands it over later, even to a
					// caller that has stopped waiting (the race `return` must close).
					const sample = makeSample(index);
					index += 1;
					if (gate) await gate();
					return { done: false, value: sample };
				},
				return: async () => {
					stopped = true;
					log.returned += 1;
					return undefined;
				},
			};
			return iterator;
		},
		render: ({ sample, scale }) => {
			if ((log.closed.get(sample.id) ?? 0) > 0) {
				log.renderedClosed += 1;
				throw new Error("rendered a closed sample");
			}
			log.renders.push({ sample: sample.id, scale });
			const id = nextImageId;
			nextImageId += 1;
			if (scale < 1) {
				const size = scaledFrameSize({ ...display, scale });
				const bitmap: FakeImage = { id, width: size.width + bitmapGrowth, height: size.height, detached: false };
				log.images.push(bitmap);
				const image: WireImage = { kind: "bitmap", bitmap };
				return { image, transfer: [bitmap] };
			}
			const frame: FakeImage = { id, width: display.width, height: display.height, detached: false };
			log.images.push(frame);
			return { image: { kind: "frame", frame }, transfer: [frame] };
		},
		dispose: () => {
			log.disposed += 1;
		},
	};
	return { backend, log };
}

/** What the main side did with pictures it received or discarded, by picture id. */
export function createImageBook() {
	const closes = new Map<number, number>();
	const idOf = (value: unknown): number => {
		const id = typeof value === "object" && value !== null ? Reflect.get(value, "id") : undefined;
		return typeof id === "number" ? id : -1;
	};
	const close = (id: number) => closes.set(id, (closes.get(id) ?? 0) + 1);
	const ops: ImageOps = {
		discard: (image) => close(idOf(image.kind === "bitmap" ? image.bitmap : image.frame)),
	};
	return { closes, idOf, close, ops };
}

/** A worker (the core over fake backends), a channel and a client, wired together. */
export function createWorld({
	backendOptions,
	timeouts,
	dropReplies = () => false,
}: {
	backendOptions?: Parameters<typeof createFakeBackend>[0];
	timeouts?: { openMs: number; pullMs: number; renderMs: number };
	/** The worker never sends these replies (a hung worker). */
	dropReplies?: (message: FromWorkerMessage) => boolean;
} = {}) {
	const channel = createFakeChannel();
	const clock = createFakeClock();
	const book = createImageBook();
	const fake = createFakeBackend(backendOptions);
	const core = createDecodeWorkerCore<FakeSample>({
		post: ({ message, transfer }) => {
			if (!dropReplies(message)) channel.worker.post({ message, transfer });
		},
		openBackend: async () => fake.backend,
	});
	channel.worker.onMessage((data) => core.handle(data));
	const client = createDecodeClient({
		channel: channel.main,
		clock,
		ops: book.ops,
		...(timeouts && { timeouts }),
	});
	return { channel, clock, book, fake, core, client };
}
