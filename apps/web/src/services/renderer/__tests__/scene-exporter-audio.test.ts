import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	ALL_FORMATS,
	AudioBufferSource,
	BufferSource,
	CanvasSource,
	Input,
	Output,
} from "mediabunny";
import type { CcutExportBridge } from "@/export/desktop-bridge";
import { createDesktopSink, type ExportSink } from "@/export/sink";
import { AUDIO_SLICE_SECONDS } from "@/export/audio-slices";
import { isExportError } from "@/export/errors";
import { FakeAudioBuffer, createFilledBuffer } from "@/export/__tests__/fake-audio-buffer";

// SceneExporter's audio and failure paths, with the real mediabunny Output, the
// real AudioBufferSource and the real wasm AAC encoder (bun runs it in a worker
// thread). Only what needs a browser is replaced: the canvas (a stand-in class),
// AudioBuffer (FakeAudioBuffer) and the renderer (renders nothing, or throws).
// There are no video frames in most tests, because bun has no VideoEncoder.

class FakeOffscreenCanvas {
	width = 0;
	height = 0;
	getContext() {
		return {};
	}
}

function replaceGlobal({ name, value }: { name: string; value: unknown }): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	return () => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	};
}

// Installed for this file's tests only (not at import, which other files' tests may share).
const restores: (() => void)[] = [];
beforeAll(() => {
	restores.push(replaceGlobal({ name: "OffscreenCanvas", value: FakeOffscreenCanvas }));
	restores.push(replaceGlobal({ name: "AudioBuffer", value: FakeAudioBuffer }));
});
afterAll(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

const { SceneExporter } = await import("../scene-exporter");
const { RootNode } = await import("../nodes/root-node");

const FPS = { numerator: 30, denominator: 1 };
const TICKS_PER_FRAME = 4000; // 120 000 ticks per second / 30 fps

function createMix({ seconds, sampleRate = 44100 }: { seconds: number; sampleRate?: number }) {
	return createFilledBuffer({
		length: Math.round(seconds * sampleRate),
		numberOfChannels: 2,
		sampleRate,
		value: ({ channel, frame }) => Math.fround(0.5 * Math.sin((frame / sampleRate) * 2 * Math.PI * (440 + channel * 110))),
	});
}

function createExporter({
	format = "mp4",
	mix,
	render = async () => {},
	sink,
	signal,
}: {
	format?: "mp4" | "webm";
	mix?: FakeAudioBuffer;
	render?: () => Promise<void>;
	sink?: ExportSink;
	signal?: AbortSignal;
}) {
	const exporter = new SceneExporter({
		width: 64,
		height: 64,
		fps: FPS,
		format,
		quality: "high",
		shouldIncludeAudio: !!mix,
		audioBuffer: mix,
		sink,
		signal,
	});
	Reflect.set(exporter, "renderer", {
		fps: FPS,
		getOutputCanvas: () => new FakeOffscreenCanvas(),
		render,
	});
	return exporter;
}

function rootFor({ frames }: { frames: number }) {
	return new RootNode({ duration: frames * TICKS_PER_FRAME });
}

type Outcome = { rejected: false; value: unknown } | { rejected: true; error: unknown };

// bun 1.2.18 does not exit after an unhandled rejection: only ever await this.
function outcomeOf({ promise }: { promise: Promise<unknown> }): Promise<Outcome> {
	return promise.then(
		(value): Outcome => ({ rejected: false, value }),
		(error: unknown): Outcome => ({ rejected: true, error }),
	);
}

async function audioTrackOf({ buffer }: { buffer: ArrayBuffer }) {
	const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryAudioTrack();
		return track ? { codec: track.codec, seconds: await track.computeDuration() } : null;
	} finally {
		input.dispose();
	}
}

describe("SceneExporter, failure path", () => {
	test("a render error cancels the Output and the same error reaches the caller", async () => {
		const failure = new Error("render exploded");
		const cancel = spyOn(Output.prototype, "cancel");
		try {
			const exporter = createExporter({ mix: createMix({ seconds: 2 }), render: async () => { throw failure; } });

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 3 }) }) });

			expect(outcome.rejected && outcome.error).toBe(failure);
			expect(cancel).toHaveBeenCalledTimes(1);
		} finally {
			cancel.mockRestore();
		}
	}, 30_000);

	test("an error with no audio at all cancels the Output too", async () => {
		const failure = new Error("render exploded, no audio");
		const cancel = spyOn(Output.prototype, "cancel");
		try {
			const exporter = createExporter({ render: async () => { throw failure; } });

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 3 }) }) });

			expect(outcome.rejected && outcome.error).toBe(failure);
			expect(cancel).toHaveBeenCalledTimes(1);
		} finally {
			cancel.mockRestore();
		}
	}, 30_000);

	test("a cancel that fails does not hide the render error", async () => {
		const failure = new Error("render exploded again");
		const cancel = spyOn(Output.prototype, "cancel").mockImplementation(async () => {
			throw new Error("cancel exploded");
		});
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const exporter = createExporter({ render: async () => { throw failure; } });

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 2 }) }) });

			expect(outcome.rejected && outcome.error).toBe(failure);
			expect(warn).toHaveBeenCalledWith("output.cancel failed (possible leaked encoder worker)", expect.any(Error));
		} finally {
			cancel.mockRestore();
			warn.mockRestore();
		}
	}, 30_000);

	test("AAC that cannot start stops the export before anything is opened: AAC_UNAVAILABLE, no start, no cancel", async () => {
		const start = spyOn(Output.prototype, "start");
		const cancel = spyOn(Output.prototype, "cancel");
		try {
			// 12 345 Hz is a rate the AAC encoder refuses, so its gate fails for real.
			const exporter = createExporter({ mix: createMix({ seconds: 1, sampleRate: 12345 }) });

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 3 }) }) });

			expect(outcome.rejected).toBe(true);
			const error = outcome.rejected ? outcome.error : null;
			expect(isExportError(error) && error.code).toBe("AAC_UNAVAILABLE");
			expect(start).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
		} finally {
			start.mockRestore();
			cancel.mockRestore();
		}
	}, 30_000);

	test("an MP4 mix of 1024 samples or fewer stops with AUDIO_TOO_SHORT before anything is opened", async () => {
		const start = spyOn(Output.prototype, "start");
		try {
			const exporter = createExporter({ mix: createMix({ seconds: 1000 / 44100 }) });

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 3 }) }) });

			const error = outcome.rejected ? outcome.error : null;
			expect(isExportError(error) && error.code).toBe("AUDIO_TOO_SHORT");
			expect(start).not.toHaveBeenCalled();
		} finally {
			start.mockRestore();
		}
	}, 30_000);
});

describe("SceneExporter, audio phase", () => {
	test("the mix goes to the encoder in slices of at most AUDIO_SLICE_SECONDS, from sample 1024, every sample once", async () => {
		const sampleRate = 44100;
		const mix = createMix({ seconds: 3.5, sampleRate });
		const add = spyOn(AudioBufferSource.prototype, "add");
		try {
			const exporter = createExporter({ mix });
			const progress: number[] = [];
			exporter.on("progress", (value) => progress.push(value));

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 0 }) }) });

			expect(outcome.rejected ? String(outcome.error) : "resolved").toBe("resolved");
			const lengths = add.mock.calls.map(([slice]) => slice.length);
			expect(lengths).toEqual([
				AUDIO_SLICE_SECONDS * sampleRate,
				AUDIO_SLICE_SECONDS * sampleRate,
				AUDIO_SLICE_SECONDS * sampleRate,
				mix.length - 1024 - 3 * AUDIO_SLICE_SECONDS * sampleRate,
			]);
			expect(add.mock.calls[0]?.[0].getChannelData(0)[0]).toBe(mix.getChannelData(0)[1024]);
			expect(progress).toEqual([1]);
		} finally {
			add.mockRestore();
		}
	}, 60_000);

	test("audio goes in between the frames, never more than one slice ahead of the video and never behind it", async () => {
		const sampleRate = 44100;
		const mix = createMix({ seconds: 3, sampleRate });
		const add = spyOn(AudioBufferSource.prototype, "add");
		// bun has no VideoEncoder: the frame is taken, not encoded.
		const addFrame = spyOn(CanvasSource.prototype, "add").mockImplementation(async () => {});
		const audioAtFrame: number[] = [];
		try {
			const exporter = createExporter({
				mix,
				render: async () => {
					audioAtFrame.push(add.mock.calls.reduce((sum, [slice]) => sum + slice.length, 0) / sampleRate);
				},
			});

			const events: string[] = [];
			exporter.on("frames", (done, count) => events.push(`${done}/${count}`));
			exporter.on("finalizing", () => events.push("finalizing"));

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 90 }) }) });

			expect(outcome.rejected ? String(outcome.error) : "resolved").toBe("resolved");
			expect(events).toEqual([...Array.from({ length: 90 }, (_, i) => `${i + 1}/90`), "finalizing"]);
			expect(audioAtFrame).toHaveLength(90);
			for (let frame = 0; frame < 90; frame++) {
				const seconds = frame / 30;
				expect(audioAtFrame[frame]).toBeGreaterThanOrEqual(seconds - 1e-9);
				expect(audioAtFrame[frame]).toBeLessThanOrEqual(seconds + AUDIO_SLICE_SECONDS);
			}
			// The first frame comes before any audio; audio then arrives one slice at a time.
			expect(audioAtFrame[0]).toBe(0);
			expect(audioAtFrame[1]).toBe(1);
			expect(audioAtFrame[31]).toBe(2);
		} finally {
			add.mockRestore();
			addFrame.mockRestore();
		}
	}, 60_000);

	test("the MP4 has an AAC track whose length is the mix rounded up to whole AAC frames, not a frame longer", async () => {
		const sampleRate = 44100;
		const mix = createMix({ seconds: 3, sampleRate });
		const exporter = createExporter({ mix });

		const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 0 }) }) });

		expect(outcome.rejected ? String(outcome.error) : "resolved").toBe("resolved");
		const result = outcome.rejected ? null : outcome.value;
		const buffer = result && typeof result === "object" ? Reflect.get(result, "buffer") : null;
		if (!(buffer instanceof ArrayBuffer)) throw new Error("expected the MP4 bytes");
		const track = await audioTrackOf({ buffer });
		expect(track?.codec).toBe("aac");
		expect(track?.seconds).toBeCloseTo((Math.ceil(mix.length / 1024) * 1024) / sampleRate, 3);
	}, 60_000);

	test("cancelling while audio is encoded stops after the current slice: no more slices, 'cancelled', output cancelled", async () => {
		const mix = createMix({ seconds: 6 });
		const cancel = spyOn(Output.prototype, "cancel");
		let exporter: ReturnType<typeof createExporter> | null = null;
		const add = spyOn(AudioBufferSource.prototype, "add").mockImplementation(async () => {
			exporter?.cancel();
		});
		try {
			exporter = createExporter({ mix });
			const events: string[] = [];
			exporter.on("cancelled", () => events.push("cancelled"));
			exporter.on("complete", () => events.push("complete"));

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 0 }) }) });

			expect(outcome.rejected ? String(outcome.error) : "resolved").toBe("resolved");
			expect(outcome.rejected ? null : outcome.value).toBeNull();
			expect(add).toHaveBeenCalledTimes(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(events).toEqual(["cancelled"]);
		} finally {
			add.mockRestore();
			cancel.mockRestore();
		}
	}, 60_000);

	test("cancelled before the first slice: the encoder is never fed", async () => {
		const add = spyOn(AudioBufferSource.prototype, "add");
		try {
			const exporter = createExporter({ mix: createMix({ seconds: 8 }) });
			exporter.cancel();

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 0 }) }) });

			expect(outcome.rejected ? "rejected" : outcome.value).toBeNull();
			expect(add).not.toHaveBeenCalled();
		} finally {
			add.mockRestore();
		}
	}, 60_000);

	test("WebM audio is Opus's: from sample 0, never touching the AAC encoder", async () => {
		const mix = createMix({ seconds: 2 });
		const add = spyOn(AudioBufferSource.prototype, "add").mockImplementation(async () => {});
		try {
			const exporter = createExporter({ format: "webm", mix });

			await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 0 }) }) });

			expect(add.mock.calls[0]?.[0].getChannelData(0)[0]).toBe(mix.getChannelData(0)[0]);
			expect(add.mock.calls.map(([slice]) => slice.length).reduce((a, b) => a + b, 0)).toBe(mix.length);
		} finally {
			add.mockRestore();
		}
	}, 60_000);
});

function createFileBridge({ failWritesAfter = Number.POSITIVE_INFINITY }: { failWritesAfter?: number } = {}) {
	const calls: string[] = [];
	let file = new Uint8Array(0);
	let writes = 0;
	const bridge: CcutExportBridge = {
		begin: async () => ({ ok: true, token: "t", displayName: "x.mp4", freeBytes: null }),
		write: async ({ position, data }) => {
			calls.push("write");
			if (++writes > failWritesAfter) throw new Error("ExportIpcError: CCUT_EXPORT:DISK_FULL");
			if (position > file.length) throw new Error("CCUT_EXPORT:INVALID");
			const end = position + data.byteLength;
			if (end > file.length) {
				const grown = new Uint8Array(end);
				grown.set(file);
				file = grown;
			}
			file.set(data, position);
		},
		finish: async ({ totalBytes }) => {
			calls.push(`finish:${totalBytes}`);
			return { displayName: "x.mp4", bytes: totalBytes };
		},
		abort: async () => {
			calls.push("abort");
		},
		reveal: async () => false,
	};
	return { bridge, calls, file: () => file };
}

function boxesOf({ bytes }: { bytes: Uint8Array }): string[] {
	const types: string[] = [];
	for (let at = 0; at + 8 <= bytes.length && types.length < 50; ) {
		const size = new DataView(bytes.buffer, bytes.byteOffset + at, 8).getUint32(0);
		types.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
		if (size < 8) break;
		at += size;
	}
	return types;
}

describe("SceneExporter, streamed to a desktop file", () => {
	for (const [seconds, sampleRate] of [[1025 / 44100, 44100], [3, 44100], [7.3, 48000]] as const) {
		test(`MP4 with real AAC (${seconds.toFixed(3)} s at ${sampleRate} Hz): moov reserved at the front, the packet bound holds, committed once`, async () => {
			const fake = createFileBridge();
			const exporter = createExporter({ mix: createMix({ seconds, sampleRate }), sink: createDesktopSink({ bridge: fake.bridge, token: "t" }) });

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 0 }) }) });

			expect(outcome.rejected ? String(outcome.error) : "resolved").toBe("resolved");
			const bytes = fake.file();
			expect(outcome.rejected ? null : outcome.value).toEqual({ kind: "file", displayName: "x.mp4", bytes: bytes.length, revealToken: "t" });
			expect(boxesOf({ bytes })).toEqual(["ftyp", "moov", "free", "mdat"]);
			expect(fake.calls.filter((call) => call.startsWith("finish"))).toEqual([`finish:${bytes.length}`]);
			expect(fake.calls).not.toContain("abort");
			const track = await audioTrackOf({ buffer: bytes.slice().buffer });
			expect(track?.codec).toBe("aac");
		}, 60_000);
	}

	test("a render error: Output cancelled, part file aborted, never committed, the error reaches the caller", async () => {
		const failure = new Error("render exploded");
		const fake = createFileBridge();
		const exporter = createExporter({
			mix: createMix({ seconds: 2 }),
			render: async () => {
				throw failure;
			},
			sink: createDesktopSink({ bridge: fake.bridge, token: "t" }),
		});

		const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 3 }) }) });

		expect(outcome.rejected && outcome.error).toBe(failure);
		expect(fake.calls.filter((call) => call === "abort")).toHaveLength(1);
		expect(fake.calls.some((call) => call.startsWith("finish"))).toBe(false);
	}, 30_000);

	test("AAC that cannot start: the part file is aborted before anything is written", async () => {
		const fake = createFileBridge();
		const exporter = createExporter({ mix: createMix({ seconds: 1, sampleRate: 12345 }), sink: createDesktopSink({ bridge: fake.bridge, token: "t" }) });

		const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 3 }) }) });

		const error = outcome.rejected ? outcome.error : null;
		expect(isExportError(error) && error.code).toBe("AAC_UNAVAILABLE");
		expect(fake.calls).toEqual(["abort"]);
	}, 30_000);

	test("the disk filling up: DISK_FULL reaches the caller, nothing is committed, the part file is aborted", async () => {
		const fake = createFileBridge({ failWritesAfter: 0 });
		const exporter = createExporter({ mix: createMix({ seconds: 2 }), sink: createDesktopSink({ bridge: fake.bridge, token: "t" }) });

		const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 0 }) }) });

		const error = outcome.rejected ? outcome.error : null;
		expect(isExportError(error) && error.code).toBe("DISK_FULL");
		expect(fake.calls.some((call) => call.startsWith("finish"))).toBe(false);
		expect(fake.calls.filter((call) => call === "abort")).toHaveLength(1);
	}, 30_000);

	test("an AbortSignal cancels like cancel(): null, 'cancelled', part file aborted, never committed", async () => {
		const fake = createFileBridge();
		const controller = new AbortController();
		const add = spyOn(AudioBufferSource.prototype, "add").mockImplementation(async () => {
			controller.abort();
		});
		try {
			const exporter = createExporter({
				mix: createMix({ seconds: 4 }),
				sink: createDesktopSink({ bridge: fake.bridge, token: "t" }),
				signal: controller.signal,
			});
			const events: string[] = [];
			exporter.on("cancelled", () => events.push("cancelled"));

			const outcome = await outcomeOf({ promise: exporter.export({ rootNode: rootFor({ frames: 0 }) }) });

			expect(outcome.rejected ? "rejected" : outcome.value).toBeNull();
			expect(add).toHaveBeenCalledTimes(1);
			expect(events).toEqual(["cancelled"]);
			expect(fake.calls.filter((call) => call === "abort")).toHaveLength(1);
			expect(fake.calls.some((call) => call.startsWith("finish"))).toBe(false);
		} finally {
			add.mockRestore();
		}
	}, 30_000);
});
