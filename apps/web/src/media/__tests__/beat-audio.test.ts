import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	BEAT_ANALYSIS_SAMPLE_RATE,
	BEAT_MAX_DURATION_SECONDS,
	BEAT_MAX_FILE_BYTES,
	BEAT_MAX_LIBRARY_BYTES,
	collectMono,
	createDecimator,
	decodeElementForBeats,
	decodeStemFileForBeats,
	mixToMono,
	STEM_DURATION_TOLERANCE_SECONDS,
	stemMatchesSource,
} from "@/media/beat-audio";
import type { MediaAsset } from "@/media/types";
import type { LibraryAudioElement, UploadAudioElement } from "@/timeline";
import { mediaTime } from "@/wasm";

type FakeBuffer = Pick<
	AudioBuffer,
	"numberOfChannels" | "length" | "duration" | "sampleRate" | "getChannelData"
>;

function fakeBuffer({
	channels,
	sampleRate = BEAT_ANALYSIS_SAMPLE_RATE,
	duration,
}: {
	channels: number[][];
	sampleRate?: number;
	duration?: number;
}): FakeBuffer {
	const data = channels.map((channel) => Float32Array.from(channel));
	return {
		numberOfChannels: data.length,
		length: data[0].length,
		duration: duration ?? data[0].length / sampleRate,
		sampleRate,
		getChannelData: (channel: number) => data[channel],
	};
}

/** A silent stereo chunk of `seconds` at `sampleRate`. */
function silence({
	seconds,
	sampleRate,
}: {
	seconds: number;
	sampleRate: number;
}): FakeBuffer {
	const length = Math.round(seconds * sampleRate);
	const channel = new Float32Array(length);
	return {
		numberOfChannels: 2,
		length,
		duration: seconds,
		sampleRate,
		getChannelData: () => channel,
	};
}

/** Claims `seconds` of audio without holding any of it (the cap must fire before mixing). */
function hugeBuffer({
	seconds,
	sampleRate = BEAT_ANALYSIS_SAMPLE_RATE,
}: {
	seconds: number;
	sampleRate?: number;
}): FakeBuffer {
	return {
		numberOfChannels: 1,
		length: Math.round(seconds * sampleRate),
		duration: seconds,
		sampleRate,
		getChannelData: () => new Float32Array(0),
	};
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	static decode: (data: ArrayBuffer) => Promise<FakeBuffer> = async () => {
		throw new Error("decode not configured");
	};
	closed = false;
	constructor(readonly options?: { sampleRate?: number }) {
		FakeAudioContext.instances.push(this);
	}
	decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
		return FakeAudioContext.decode(data);
	}
	async close() {
		this.closed = true;
	}
}

const originalFetch = globalThis.fetch;
let fetched: Array<{ url: string; signal?: AbortSignal | null }> = [];

function stubFetch(respond: (url: string) => Response) {
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			fetched.push({ url: String(input), signal: init?.signal });
			return respond(String(input));
		},
		{ preconnect: () => {} },
	);
}

beforeEach(() => {
	FakeAudioContext.instances = [];
	FakeAudioContext.decode = async () => {
		throw new Error("decode not configured");
	};
	fetched = [];
	Reflect.set(globalThis, "window", { AudioContext: FakeAudioContext });
});

afterEach(() => {
	Reflect.set(globalThis, "window", undefined);
	globalThis.fetch = originalFetch;
});

function uploadAudio(): UploadAudioElement {
	return {
		id: "audio-1",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		name: "Song",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 120000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function libraryAudio({
	url = "https://example.test/song.mp3",
}: { url?: string } = {}): LibraryAudioElement {
	return {
		id: "audio-1",
		type: "audio",
		sourceType: "library",
		sourceUrl: url,
		name: "Song",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 120000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function audioAsset({
	duration,
	size,
}: { duration?: number; size?: number } = {}): MediaAsset & {
	readFile: { reads: number };
} {
	const file = new File([new Uint8Array(16)], "song.mp3", { type: "audio/mpeg" });
	const readFile = { reads: 0 };
	const read = file.arrayBuffer.bind(file);
	Object.defineProperty(file, "arrayBuffer", {
		value: () => {
			readFile.reads++;
			return read();
		},
	});
	if (size !== undefined) Object.defineProperty(file, "size", { value: size });
	return {
		id: "media-1",
		name: "song.mp3",
		type: "audio",
		duration,
		file,
		readFile,
	};
}

describe("mixToMono", () => {
	test("averages stereo channels sample by sample", () => {
		const buffer = fakeBuffer({
			channels: [
				[1, 0.5, -1, 0],
				[0, 0.5, 1, 0.25],
			],
		});
		expect(Array.from(mixToMono({ buffer }))).toEqual([0.5, 0.5, 0, 0.125]);
	});

	test("averages more than two channels", () => {
		const buffer = fakeBuffer({ channels: [[3], [0], [0], [0], [0], [0]] });
		expect(Array.from(mixToMono({ buffer }))).toEqual([0.5]);
	});

	test("returns a copy for a mono buffer, never the decoder's own array", () => {
		const buffer = fakeBuffer({ channels: [[0.1, 0.2, 0.3]] });
		const mono = mixToMono({ buffer });
		expect(Array.from(mono)).toEqual(Array.from(buffer.getChannelData(0)));
		expect(mono).not.toBe(buffer.getChannelData(0));
		mono[0] = 9;
		expect(buffer.getChannelData(0)[0]).toBeCloseTo(0.1);
	});

	test("returns an empty array for an empty buffer", () => {
		const buffer = fakeBuffer({ channels: [[], []] });
		expect(mixToMono({ buffer }).length).toBe(0);
	});

	test("returns one Float32 sample per frame", () => {
		const buffer = fakeBuffer({
			channels: [new Array(1000).fill(0.2), new Array(1000).fill(0.4)],
		});
		const mono = mixToMono({ buffer });
		expect(mono).toBeInstanceOf(Float32Array);
		expect(mono.length).toBe(1000);
		expect(mono[999]).toBeCloseTo(0.3);
	});

	test("turns NaN and Infinity into silence so one bad sample cannot poison the analysis", () => {
		const buffer = fakeBuffer({
			channels: [
				[Number.NaN, 1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
				[1, 1, 1, 1],
			],
		});
		expect(Array.from(mixToMono({ buffer }))).toEqual([0.5, 1, 0.5, 0.5]);
	});
});

describe("createDecimator", () => {
	function sine({ hz, seconds, sampleRate }: { hz: number; seconds: number; sampleRate: number }) {
		const out = new Float32Array(Math.round(seconds * sampleRate));
		for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
		return out;
	}

	function run({ input, ratio, chunk }: { input: Float32Array; ratio: number; chunk: number }) {
		const decimate = createDecimator({ ratio });
		const parts: Float32Array[] = [];
		for (let i = 0; i < input.length; i += chunk) {
			parts.push(decimate(input.subarray(i, i + chunk)));
		}
		const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.length;
		}
		return out;
	}

	test("48 kHz to 22.05 kHz keeps the length, the pitch and nearly the level", () => {
		const ratio = 48000 / 22050;
		const out = run({ input: sine({ hz: 1000, seconds: 2, sampleRate: 48000 }), ratio, chunk: 1152 });
		expect(Math.abs(out.length - 2 * 22050)).toBeLessThanOrEqual(1);

		let crossings = 0;
		let peak = 0;
		for (let i = 1; i < out.length; i++) {
			if (out[i - 1] < 0 && out[i] >= 0) crossings++;
			peak = Math.max(peak, Math.abs(out[i]));
		}
		expect(Math.abs(crossings - 2000)).toBeLessThanOrEqual(2);
		expect(peak).toBeGreaterThan(0.95);
		expect(peak).toBeLessThanOrEqual(1);
	});

	test("does not depend on how the stream is cut into chunks", () => {
		const input = sine({ hz: 440, seconds: 1, sampleRate: 44100 });
		const whole = run({ input, ratio: 2, chunk: input.length });
		for (const chunk of [1, 7, 1000, 4096]) {
			const cut = run({ input, ratio: 2, chunk });
			expect(cut.length).toBe(whole.length);
			for (let i = 0; i < whole.length; i++) {
				expect(Math.abs(cut[i] - whole[i])).toBeLessThan(1e-5);
			}
		}
	});

	test("an integer ratio averages neighbouring samples", () => {
		const out = run({ input: Float32Array.from([1, 3, 5, 7, 9, 11]), ratio: 2, chunk: 4 });
		expect(Array.from(out)).toEqual([2, 6, 10]);
	});

	test("attenuates content above the new Nyquist instead of folding it back at full level", () => {
		const out = run({
			input: sine({ hz: 16000, seconds: 1, sampleRate: 48000 }),
			ratio: 48000 / 22050,
			chunk: 2048,
		});
		let peak = 0;
		for (const value of out) peak = Math.max(peak, Math.abs(value));
		expect(peak).toBeLessThan(0.5);
	});
});

describe("collectMono", () => {
	async function* endless({ seconds, sampleRate, pulled }: { seconds: number; sampleRate: number; pulled: { count: number } }) {
		for (;;) {
			pulled.count++;
			yield silence({ seconds, sampleRate });
		}
	}

	test("stops reading an endless source as soon as the duration cap is passed", async () => {
		const pulled = { count: 0 };
		const result = await collectMono({
			chunks: endless({ seconds: 1, sampleRate: 48000, pulled }),
			maxSeconds: 10,
			maxBytes: Number.MAX_SAFE_INTEGER,
		});
		expect(result).toEqual({ ok: false, reason: "too-long" });
		expect(pulled.count).toBe(11);
	});

	test("the duration cap counts native time, whatever the sample rate", async () => {
		const pulled = { count: 0 };
		const result = await collectMono({
			chunks: endless({ seconds: 2, sampleRate: 8000, pulled }),
			maxSeconds: 10,
			maxBytes: Number.MAX_SAFE_INTEGER,
		});
		expect(result).toEqual({ ok: false, reason: "too-long" });
		expect(pulled.count).toBe(6);
	});

	test("stops on the memory budget even when the duration looks fine", async () => {
		const pulled = { count: 0 };
		const result = await collectMono({
			chunks: endless({ seconds: 1, sampleRate: 22050, pulled }),
			maxSeconds: 1e9,
			maxBytes: 22050 * 4 * 3,
		});
		expect(result).toEqual({ ok: false, reason: "too-long" });
		expect(pulled.count).toBe(4);
	});

	test("keeps only mono at the analysis rate: never holds all channels at native rate", async () => {
		async function* source() {
			yield silence({ seconds: 1, sampleRate: 48000 });
			yield silence({ seconds: 1, sampleRate: 48000 });
		}
		const result = await collectMono({
			chunks: source(),
			maxSeconds: 60,
			maxBytes: 100 * 1024 * 1024,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.sampleRate).toBe(BEAT_ANALYSIS_SAMPLE_RATE);
		expect(Math.abs(result.samples.length - 2 * 22050)).toBeLessThanOrEqual(1);
	});

	test("leaves a source that is already at or below the analysis rate alone", async () => {
		async function* source() {
			yield fakeBuffer({ channels: [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5]], sampleRate: 16000 });
			yield fakeBuffer({ channels: [[1], [1]], sampleRate: 16000 });
		}
		const result = await collectMono({ chunks: source(), maxSeconds: 60, maxBytes: 1e6 });
		if (!result.ok) throw new Error(result.reason);
		expect(result.sampleRate).toBe(16000);
		expect(Array.from(result.samples)).toEqual([0.5, 0.5, 0.5, 1]);
	});

	test("rejects with an AbortError when the signal aborts between chunks", async () => {
		const controller = new AbortController();
		const pulled = { count: 0 };
		async function* source() {
			for (;;) {
				pulled.count++;
				if (pulled.count === 3) controller.abort();
				yield silence({ seconds: 1, sampleRate: 22050 });
			}
		}
		await expect(
			collectMono({
				chunks: source(),
				maxSeconds: 1e9,
				maxBytes: Number.MAX_SAFE_INTEGER,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(pulled.count).toBe(3);
	});

	test.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])(
		"refuses a chunk that claims the sample rate %p",
		async (sampleRate) => {
			async function* source() {
				yield fakeBuffer({ channels: [[0, 0]], sampleRate });
			}
			await expect(
				collectMono({ chunks: source(), maxSeconds: 60, maxBytes: 1e6 }),
			).rejects.toThrow("sample rate");
		},
	);

	test("an empty source yields empty samples", async () => {
		async function* source() {}
		const result = await collectMono({ chunks: source(), maxSeconds: 60, maxBytes: 1e6 });
		if (!result.ok) throw new Error(result.reason);
		expect(result.samples.length).toBe(0);
	});
});

describe("decodeElementForBeats: uploaded audio files", () => {
	test("decodes at the analysis rate and mixes to mono", async () => {
		FakeAudioContext.decode = async () => fakeBuffer({ channels: [[1, 1], [0, 0]] });

		const result = await decodeElementForBeats({
			element: uploadAudio(),
			mediaAsset: audioAsset(),
		});

		expect(FakeAudioContext.instances.length).toBe(1);
		expect(FakeAudioContext.instances[0].options?.sampleRate).toBe(BEAT_ANALYSIS_SAMPLE_RATE);
		if (!result.ok) throw new Error(result.reason);
		expect(result.sampleRate).toBe(BEAT_ANALYSIS_SAMPLE_RATE);
		expect(Array.from(result.samples)).toEqual([0.5, 0.5]);
	});

	test("brings a higher-rate decode down to the analysis rate", async () => {
		FakeAudioContext.decode = async () => silence({ seconds: 1, sampleRate: 48000 });
		const result = await decodeElementForBeats({
			element: uploadAudio(),
			mediaAsset: audioAsset(),
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.sampleRate).toBe(BEAT_ANALYSIS_SAMPLE_RATE);
		expect(Math.abs(result.samples.length - 22050)).toBeLessThanOrEqual(1);
	});

	test("closes the audio context after a successful decode", async () => {
		FakeAudioContext.decode = async () => fakeBuffer({ channels: [[0, 0]] });
		await decodeElementForBeats({ element: uploadAudio(), mediaAsset: audioAsset() });
		expect(FakeAudioContext.instances[0].closed).toBe(true);
	});

	test("reads the file once", async () => {
		FakeAudioContext.decode = async () => fakeBuffer({ channels: [[0, 0]] });
		const mediaAsset = audioAsset();
		await decodeElementForBeats({ element: uploadAudio(), mediaAsset });
		expect(mediaAsset.readFile.reads).toBe(1);
	});

	test("an undecodable file is unreadable and still closes the context", async () => {
		FakeAudioContext.decode = async () => {
			throw new Error("EncodingError");
		};
		const result = await decodeElementForBeats({
			element: uploadAudio(),
			mediaAsset: audioAsset(),
		});
		expect(result).toEqual({ ok: false, reason: "unreadable" });
		expect(FakeAudioContext.instances[0].closed).toBe(true);
	});

	test("an uploaded element without its media asset is unreadable", async () => {
		const result = await decodeElementForBeats({ element: uploadAudio(), mediaAsset: null });
		expect(result).toEqual({ ok: false, reason: "unreadable" });
	});

	test("refuses a file over the size cap before reading it", async () => {
		const mediaAsset = audioAsset({ size: BEAT_MAX_FILE_BYTES + 1 });
		const result = await decodeElementForBeats({ element: uploadAudio(), mediaAsset });
		expect(result).toEqual({ ok: false, reason: "too-large" });
		expect(mediaAsset.readFile.reads).toBe(0);
		expect(FakeAudioContext.instances.length).toBe(0);
	});

	test("accepts a file exactly at the size cap", async () => {
		FakeAudioContext.decode = async () => fakeBuffer({ channels: [[0, 0]] });
		const result = await decodeElementForBeats({
			element: uploadAudio(),
			mediaAsset: audioAsset({ size: BEAT_MAX_FILE_BYTES }),
		});
		expect(result.ok).toBe(true);
	});

	test("refuses a known long asset without reading or decoding it", async () => {
		const mediaAsset = audioAsset({ duration: BEAT_MAX_DURATION_SECONDS + 1 });
		const result = await decodeElementForBeats({ element: uploadAudio(), mediaAsset });
		expect(result).toEqual({ ok: false, reason: "too-long" });
		expect(mediaAsset.readFile.reads).toBe(0);
		expect(FakeAudioContext.instances.length).toBe(0);
	});

	test("accepts an asset exactly at the duration limit", async () => {
		FakeAudioContext.decode = async () => fakeBuffer({ channels: [[0, 0]] });
		const result = await decodeElementForBeats({
			element: uploadAudio(),
			mediaAsset: audioAsset({ duration: BEAT_MAX_DURATION_SECONDS }),
		});
		expect(result.ok).toBe(true);
	});

	test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -5])(
		"a declared duration of %p is not trusted: unreadable, nothing decoded",
		async (duration) => {
			const mediaAsset = audioAsset({ duration });
			const result = await decodeElementForBeats({ element: uploadAudio(), mediaAsset });
			expect(result).toEqual({ ok: false, reason: "unreadable" });
			expect(mediaAsset.readFile.reads).toBe(0);
		},
	);

	test("a missing declared duration does not block the decode", async () => {
		FakeAudioContext.decode = async () => fakeBuffer({ channels: [[0, 0]] });
		const result = await decodeElementForBeats({
			element: uploadAudio(),
			mediaAsset: audioAsset({ duration: undefined }),
		});
		expect(result.ok).toBe(true);
	});

	test("refuses a decoded buffer over the duration limit", async () => {
		FakeAudioContext.decode = async () =>
			hugeBuffer({ seconds: BEAT_MAX_DURATION_SECONDS + 1 });
		const result = await decodeElementForBeats({
			element: uploadAudio(),
			mediaAsset: audioAsset(),
		});
		expect(result).toEqual({ ok: false, reason: "too-long" });
		expect(FakeAudioContext.instances[0].closed).toBe(true);
	});

	test("rejects with an AbortError when already aborted, touching nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		const mediaAsset = audioAsset();
		await expect(
			decodeElementForBeats({
				element: uploadAudio(),
				mediaAsset,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(mediaAsset.readFile.reads).toBe(0);
	});

	test("rejects with an AbortError when aborted while the decode runs", async () => {
		const controller = new AbortController();
		FakeAudioContext.decode = async () => {
			controller.abort();
			return fakeBuffer({ channels: [[0, 0]] });
		};
		await expect(
			decodeElementForBeats({
				element: uploadAudio(),
				mediaAsset: audioAsset(),
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(FakeAudioContext.instances[0].closed).toBe(true);
	});
});

describe("decodeElementForBeats: library sounds", () => {
	test("fetches over https with the abort signal and decodes", async () => {
		stubFetch(() => new Response(new Uint8Array(8)));
		FakeAudioContext.decode = async () => fakeBuffer({ channels: [[0.25, 0.5]] });
		const controller = new AbortController();

		const result = await decodeElementForBeats({
			element: libraryAudio(),
			mediaAsset: null,
			signal: controller.signal,
		});

		expect(fetched.map((request) => request.url)).toEqual(["https://example.test/song.mp3"]);
		expect(fetched[0].signal).toBe(controller.signal);
		if (!result.ok) throw new Error(result.reason);
		expect(Array.from(result.samples)).toEqual([0.25, 0.5]);
		expect(FakeAudioContext.instances[0].closed).toBe(true);
	});

	test.each([
		"http://example.test/song.mp3",
		"file:///etc/passwd",
		"data:audio/mpeg;base64,AAAA",
		"/sounds/song.mp3",
		"not a url",
		"ftp://example.test/song.mp3",
	])("never fetches %p", async (url) => {
		stubFetch(() => new Response(new Uint8Array(8)));
		const result = await decodeElementForBeats({
			element: libraryAudio({ url }),
			mediaAsset: null,
		});
		expect(result).toEqual({ ok: false, reason: "unreadable" });
		expect(fetched).toEqual([]);
	});

	test("uses the decoded buffer the clip already carries instead of downloading", async () => {
		stubFetch(() => new Response(new Uint8Array(8)));
		const element = libraryAudio();
		Reflect.set(element, "buffer", silence({ seconds: 2, sampleRate: 44100 }));
		const result = await decodeElementForBeats({ element, mediaAsset: null });
		expect(fetched).toEqual([]);
		expect(FakeAudioContext.instances.length).toBe(0);
		if (!result.ok) throw new Error(result.reason);
		expect(result.sampleRate).toBe(BEAT_ANALYSIS_SAMPLE_RATE);
		expect(Math.abs(result.samples.length - 2 * 22050)).toBeLessThanOrEqual(1);
	});

	test("a failed download is unreadable and nothing is decoded", async () => {
		stubFetch(() => new Response("nope", { status: 404 }));
		const result = await decodeElementForBeats({ element: libraryAudio(), mediaAsset: null });
		expect(result).toEqual({ ok: false, reason: "unreadable" });
		expect(FakeAudioContext.instances.length).toBe(0);
	});

	test("refuses a response that announces a body over the cap and cancels it unread", async () => {
		let cancelled = false;
		stubFetch(
			() =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-length": String(BEAT_MAX_LIBRARY_BYTES + 1) } },
				),
		);
		const result = await decodeElementForBeats({ element: libraryAudio(), mediaAsset: null });
		expect(result).toEqual({ ok: false, reason: "too-large" });
		expect(cancelled).toBe(true);
		expect(FakeAudioContext.instances.length).toBe(0);
	});

	test("stops a body that lies about, or hides, its size once it passes the cap", async () => {
		const piece = new Uint8Array(8 * 1024 * 1024);
		let pulls = 0;
		let cancelled = false;
		stubFetch(
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							pulls++;
							controller.enqueue(piece);
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		);
		const result = await decodeElementForBeats({ element: libraryAudio(), mediaAsset: null });
		expect(result).toEqual({ ok: false, reason: "too-large" });
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(Math.ceil(BEAT_MAX_LIBRARY_BYTES / piece.byteLength) + 2);
		expect(FakeAudioContext.instances.length).toBe(0);
	});

	test("reassembles a body that arrives in pieces", async () => {
		let received = 0;
		stubFetch(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(Uint8Array.from([1, 2, 3]));
							controller.enqueue(Uint8Array.from([4, 5]));
							controller.close();
						},
					}),
				),
		);
		FakeAudioContext.decode = async (data) => {
			received = data.byteLength;
			expect(Array.from(new Uint8Array(data))).toEqual([1, 2, 3, 4, 5]);
			return fakeBuffer({ channels: [[0, 0]] });
		};
		const result = await decodeElementForBeats({ element: libraryAudio(), mediaAsset: null });
		expect(result.ok).toBe(true);
		expect(received).toBe(5);
	});

	test("refuses a decoded library sound over the duration limit", async () => {
		stubFetch(() => new Response(new Uint8Array(8)));
		FakeAudioContext.decode = async () =>
			hugeBuffer({ seconds: BEAT_MAX_DURATION_SECONDS + 1 });
		const result = await decodeElementForBeats({ element: libraryAudio(), mediaAsset: null });
		expect(result).toEqual({ ok: false, reason: "too-long" });
		expect(FakeAudioContext.instances[0].closed).toBe(true);
	});
});

describe("stem files", () => {
	test("a stem within the tolerance of the clip's media belongs to it, a different length does not", () => {
		const sourceSeconds = 199.2;
		expect(stemMatchesSource({ stemSeconds: sourceSeconds + 0.05, sourceSeconds })).toBe(true);
		expect(
			stemMatchesSource({
				stemSeconds: sourceSeconds - 0.9 * STEM_DURATION_TOLERANCE_SECONDS,
				sourceSeconds,
			}),
		).toBe(true);
		expect(stemMatchesSource({ stemSeconds: sourceSeconds + 1.1 * STEM_DURATION_TOLERANCE_SECONDS, sourceSeconds })).toBe(false);
		expect(stemMatchesSource({ stemSeconds: 20, sourceSeconds })).toBe(false);
		expect(stemMatchesSource({ stemSeconds: Number.NaN, sourceSeconds })).toBe(false);
	});

	test("a stem file over the size cap is refused without being read", async () => {
		let read = false;
		const file = new File([new Uint8Array(8)], "drums.mp3");
		Object.defineProperty(file, "size", { value: BEAT_MAX_FILE_BYTES + 1 });
		file.arrayBuffer = async () => {
			read = true;
			return new ArrayBuffer(0);
		};
		expect(await decodeStemFileForBeats({ file })).toEqual({ ok: false, reason: "too-large" });
		expect(read).toBe(false);
	});

	test("a stem file is decoded to mono at the analysis rate and the audio context is closed", async () => {
		FakeAudioContext.decode = async () =>
			fakeBuffer({ channels: [[0.5, 0.5, 0.5, 0.5], [-0.5, -0.5, -0.5, -0.5]] });
		const file = new File([new Uint8Array(8)], "drums.mp3");
		const result = await decodeStemFileForBeats({ file });
		expect(result).toEqual({
			ok: true,
			samples: Float32Array.from([0, 0, 0, 0]),
			sampleRate: BEAT_ANALYSIS_SAMPLE_RATE,
		});
		expect(FakeAudioContext.instances[0].closed).toBe(true);
	});

	test("a stem file that cannot be decoded is unreadable, not an exception", async () => {
		const file = new File([new Uint8Array(8)], "drums.mp3");
		expect(await decodeStemFileForBeats({ file })).toEqual({ ok: false, reason: "unreadable" });
	});
});
