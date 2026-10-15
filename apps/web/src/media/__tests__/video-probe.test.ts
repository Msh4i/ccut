import { describe, expect, test } from "bun:test";
import {
	VIDEO_PROBE_LIMITS,
	probeVideo,
	type ProbeInput,
	type ProbeVideoTrack,
} from "../video-probe";
import { createFakeTimers, flushMicrotasks } from "./fake-timers";

const never = <T>() => new Promise<T>(() => {});

function fakeTrack(overrides: Partial<ProbeVideoTrack> = {}): ProbeVideoTrack {
	return {
		displayWidth: 1920,
		displayHeight: 1080,
		codec: "avc",
		canDecode: async () => true,
		computePacketStats: async () => ({ averagePacketRate: 29.97 }),
		...overrides,
	};
}

function fakeInput({
	track = fakeTrack(),
	...overrides
}: Partial<ProbeInput<ProbeVideoTrack>> & { track?: ProbeVideoTrack | null } = {}) {
	const calls = { dispose: 0 };
	const input: ProbeInput<ProbeVideoTrack> = {
		computeDuration: async () => 12.5,
		getPrimaryVideoTrack: async () => track,
		getPrimaryAudioTrack: async () => ({}),
		dispose: () => {
			calls.dispose += 1;
		},
		...overrides,
	};
	return { input, calls };
}

/** Starts the probe, lets every ready await run, then moves the clock. */
async function runWithClock<T>({
	start,
	timers,
	steps,
}: {
	start: () => Promise<T>;
	timers: ReturnType<typeof createFakeTimers>;
	steps: number[];
}): Promise<{ value?: T; error?: unknown }> {
	const outcome: { value?: T; error?: unknown; done: boolean } = { done: false };
	const promise = start().then(
		(value) => {
			outcome.value = value;
			outcome.done = true;
		},
		(error: unknown) => {
			outcome.error = error;
			outcome.done = true;
		},
	);
	for (const ms of steps) {
		await flushMicrotasks();
		if (outcome.done) break;
		timers.advance(ms);
	}
	await flushMicrotasks();
	if (!outcome.done) {
		throw new Error("probe did not settle within the scripted clock steps");
	}
	await promise;
	return outcome;
}

describe("probeVideo", () => {
	test("reads metadata and the thumbnail when everything answers", async () => {
		const timers = createFakeTimers();
		const { input, calls } = fakeInput();
		const { value } = await runWithClock({
			timers,
			steps: [],
			start: () =>
				probeVideo({
					input,
					decodeThumbnail: async () => "data:thumb",
					timers,
				}),
		});
		expect(value).toEqual({
			duration: 12.5,
			width: 1920,
			height: 1080,
			fps: 29.97,
			hasAudio: true,
			codec: "avc",
			canDecode: true,
			thumbnailUrl: "data:thumb",
			previewIssue: null,
		});
		expect(calls.dispose).toBe(1);
		expect(timers.pending()).toBe(0);
	});

	test("a thumbnail decode that throws keeps every metadata field", async () => {
		const timers = createFakeTimers();
		const { input, calls } = fakeInput();
		const { value } = await runWithClock({
			timers,
			steps: [],
			start: () =>
				probeVideo({
					input,
					decodeThumbnail: async () => {
						throw new Error("decoder error");
					},
					timers,
				}),
		});
		expect(value).toMatchObject({
			duration: 12.5,
			width: 1920,
			fps: 29.97,
			canDecode: true,
			thumbnailUrl: null,
			previewIssue: "error",
		});
		expect(calls.dispose).toBe(1);
	});

	test("a thumbnail decode that never answers does not block the import", async () => {
		const timers = createFakeTimers();
		const { input, calls } = fakeInput();
		const { value } = await runWithClock({
			timers,
			steps: [VIDEO_PROBE_LIMITS.previewMs - 1, 1],
			start: () =>
				probeVideo({ input, decodeThumbnail: never, timers }),
		});
		expect(value).toMatchObject({
			duration: 12.5,
			canDecode: true,
			thumbnailUrl: null,
			previewIssue: "timeout",
		});
		expect(calls.dispose).toBe(1);
	});

	test("waits for a slow thumbnail up to the limit, not less", async () => {
		const timers = createFakeTimers();
		const { input } = fakeInput();
		let resolveThumb: (url: string) => void = () => {};
		let settled = false;
		const promise = probeVideo({
			input,
			decodeThumbnail: () =>
				new Promise<string>((resolve) => {
					resolveThumb = resolve;
				}),
			timers,
		}).then((value) => {
			settled = true;
			return value;
		});
		await flushMicrotasks();
		timers.advance(VIDEO_PROBE_LIMITS.previewMs - 1);
		await flushMicrotasks();
		expect(settled).toBe(false);
		resolveThumb("data:late-but-in-time");
		expect((await promise).thumbnailUrl).toBe("data:late-but-in-time");
	});

	test("a decodability check that never answers gives an unknown answer and no thumbnail", async () => {
		const timers = createFakeTimers();
		let decodeCalls = 0;
		const { input } = fakeInput({ track: fakeTrack({ canDecode: never }) });
		const { value } = await runWithClock({
			timers,
			steps: [VIDEO_PROBE_LIMITS.previewMs],
			start: () =>
				probeVideo({
					input,
					decodeThumbnail: async () => {
						decodeCalls += 1;
						return "data:thumb";
					},
					timers,
				}),
		});
		expect(value).toMatchObject({
			duration: 12.5,
			canDecode: null,
			thumbnailUrl: null,
			previewIssue: "timeout",
		});
		expect(decodeCalls).toBe(0);
	});

	test("an undecodable codec skips the thumbnail without reporting an issue", async () => {
		const timers = createFakeTimers();
		let decodeCalls = 0;
		const { input } = fakeInput({
			track: fakeTrack({ canDecode: async () => false, codec: "hevc" }),
		});
		const { value } = await runWithClock({
			timers,
			steps: [],
			start: () =>
				probeVideo({
					input,
					decodeThumbnail: async () => {
						decodeCalls += 1;
						return "data:thumb";
					},
					timers,
				}),
		});
		expect(value).toMatchObject({
			canDecode: false,
			codec: "hevc",
			thumbnailUrl: null,
			previewIssue: null,
		});
		expect(decodeCalls).toBe(0);
	});

	test("a metadata read that never answers fails visibly after the metadata limit", async () => {
		const timers = createFakeTimers();
		const { input, calls } = fakeInput({ computeDuration: never });
		const { error, value } = await runWithClock({
			timers,
			steps: [VIDEO_PROBE_LIMITS.metadataMs],
			start: () =>
				probeVideo({ input, decodeThumbnail: async () => "x", timers }),
		});
		expect(value).toBeUndefined();
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("Timed out reading the video's metadata");
		expect(calls.dispose).toBe(1);
	});

	test("a slow but live metadata read (a huge unindexed MP4, a network drive) is waited for up to 120 s before it counts as a hang", async () => {
		expect(VIDEO_PROBE_LIMITS.metadataMs).toBe(120_000);
		const timers = createFakeTimers();
		let resolveDuration: (value: number) => void = () => {};
		const { input } = fakeInput({
			computeDuration: () =>
				new Promise<number>((resolve) => {
					resolveDuration = resolve;
				}),
		});
		let settled = false;
		const promise = probeVideo({ input, decodeThumbnail: async () => "data:ok", timers }).then((value) => {
			settled = true;
			return value;
		});
		await flushMicrotasks();
		timers.advance(100_000); // the old limit (30 s) is long gone
		await flushMicrotasks();
		expect(settled).toBe(false);
		timers.advance(19_999);
		await flushMicrotasks();
		expect(settled).toBe(false);
		resolveDuration(7200);
		const value = await promise;
		expect(value.duration).toBe(7200);
		expect(value.thumbnailUrl).toBe("data:ok");
	});

	test("the timeout names the limit in seconds", async () => {
		const timers = createFakeTimers();
		const { input } = fakeInput({ computeDuration: never });
		const { error } = await runWithClock({
			timers,
			steps: [VIDEO_PROBE_LIMITS.metadataMs],
			start: () => probeVideo({ input, decodeThumbnail: async () => "x", timers }),
		});
		expect(String(error)).toContain("after 120 s");
	});

	test("a metadata read error is passed on unchanged and the input is released", async () => {
		const timers = createFakeTimers();
		const boom = new Error("broken moov");
		const { input, calls } = fakeInput({
			computeDuration: async () => {
				throw boom;
			},
		});
		const { error } = await runWithClock({
			timers,
			steps: [],
			start: () =>
				probeVideo({ input, decodeThumbnail: async () => "x", timers }),
		});
		expect(error).toBe(boom);
		expect(calls.dispose).toBe(1);
		expect(timers.pending()).toBe(0);
	});

	test("a file without a video track is an error", async () => {
		const timers = createFakeTimers();
		const { input } = fakeInput({ track: null });
		const { error } = await runWithClock({
			timers,
			steps: [],
			start: () =>
				probeVideo({ input, decodeThumbnail: async () => "x", timers }),
		});
		expect(String(error)).toContain("No video track found in the file");
	});

	test("the preview gets its own budget after a slow metadata read", async () => {
		const timers = createFakeTimers();
		let resolveDuration: (value: number) => void = () => {};
		const { input } = fakeInput({
			computeDuration: () =>
				new Promise<number>((resolve) => {
					resolveDuration = resolve;
				}),
		});
		let resolveThumb: (url: string) => void = () => {};
		const promise = probeVideo({
			input,
			decodeThumbnail: () =>
				new Promise<string>((resolve) => {
					resolveThumb = resolve;
				}),
			timers,
		});
		await flushMicrotasks();
		timers.advance(VIDEO_PROBE_LIMITS.metadataMs - 1);
		resolveDuration(3);
		await flushMicrotasks();
		timers.advance(VIDEO_PROBE_LIMITS.previewMs - 1);
		resolveThumb("data:ok");
		const value = await promise;
		expect(value.duration).toBe(3);
		expect(value.thumbnailUrl).toBe("data:ok");
		expect(value.previewIssue).toBeNull();
	});
});
