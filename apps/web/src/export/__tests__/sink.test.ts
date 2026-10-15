import { describe, expect, test } from "bun:test";
import {
	ALL_FORMATS,
	BufferSource,
	EncodedAudioPacketSource,
	EncodedPacket,
	Input,
	Mp4OutputFormat,
	Output,
	QUALITY_HIGH,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_VERY_HIGH,
	WebMOutputFormat,
} from "mediabunny";
import { EXPORT_QUALITY_VALUES } from "../index";
import { bridgeErrorCode, bridgeErrorDetail, getDesktopExportBridge, type BeginResult, type CcutExportBridge } from "../desktop-bridge";
import { isExportError, type ExportErrorCode } from "../errors";
import { IN_MEMORY_EXPORT_LIMIT_BYTES, estimateExportBytes, videoBitrateFor } from "../memory-limit";
import {
	DESKTOP_CHUNK_BYTES,
	KEEPALIVE_INTERVAL_MS,
	MAX_SUGGESTED_NAME_CODE_POINTS,
	createBufferSink,
	createDesktopSink,
	openExportSink,
	shortenSuggestedName,
	type ExportSink,
	type KeepAliveTimers,
} from "../sink";

// The sink with a fake bridge that keeps the main process's rules (no hole, one
// session), driven by a real mediabunny Output writing ready-made packets.

type Call = { method: string; request: unknown };

function createFakeBridge({
	beginResult = { ok: true, token: "t1", displayName: "clip.mp4" },
	failWriteAfter = Number.POSITIVE_INFINITY,
	failWith = "Error invoking remote method 'ccut-export:write': ExportIpcError: CCUT_EXPORT:DISK_FULL",
	finishError,
}: {
	beginResult?: BeginResult;
	failWriteAfter?: number;
	failWith?: string;
	finishError?: string;
} = {}) {
	const calls: Call[] = [];
	let file = new Uint8Array(0);
	let writes = 0;
	const bridge: CcutExportBridge = {
		begin: async (request) => {
			calls.push({ method: "begin", request });
			return beginResult;
		},
		write: async ({ token, position, data }) => {
			calls.push({ method: "write", request: { token, position, length: data.byteLength, ownsBuffer: data.byteLength === data.buffer.byteLength } });
			if (++writes > failWriteAfter) throw new Error(failWith);
			if (position > file.length) throw new Error("CCUT_EXPORT:INVALID");
			const end = position + data.byteLength;
			if (end > file.length) {
				const grown = new Uint8Array(end);
				grown.set(file);
				file = grown;
			}
			file.set(data, position);
		},
		finish: async ({ token, totalBytes }) => {
			calls.push({ method: "finish", request: { token, totalBytes } });
			if (finishError) throw new Error(finishError);
			return { displayName: "clip.mp4", bytes: totalBytes };
		},
		abort: async (request) => {
			calls.push({ method: "abort", request });
		},
		reveal: async () => true,
	};
	return { bridge, calls, file: () => file };
}

/** A clock for the keepalive: nothing runs unless the test ticks it. */
function createFakeIntervals() {
	const callbacks = new Map<number, () => void>();
	let next = 1;
	const timers: KeepAliveTimers = {
		setInterval: ({ callback }) => {
			const id = next++;
			callbacks.set(id, callback);
			return id;
		},
		clearInterval: (id) => {
			if (typeof id === "number") callbacks.delete(id);
		},
	};
	return {
		timers,
		/** One interval elapses for every timer still set. */
		tick: async () => {
			for (const callback of [...callbacks.values()]) callback();
			await Promise.resolve();
			await Promise.resolve();
		},
		active: () => callbacks.size,
	};
}

async function writeFile({ sink, format, packets = 40 }: { sink: ExportSink; format: "mp4" | "webm"; packets?: number }) {
	const output = new Output({
		format: format === "mp4" ? new Mp4OutputFormat({ fastStart: sink.fastStart }) : new WebMOutputFormat(),
		target: sink.target,
	});
	const source = new EncodedAudioPacketSource(format === "mp4" ? "aac" : "opus");
	output.addAudioTrack(source, { maximumPacketCount: packets });
	await output.start();
	const meta =
		format === "mp4"
			? { decoderConfig: { codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 44100, description: new Uint8Array([0x12, 0x10]) } }
			: { decoderConfig: { codec: "opus", numberOfChannels: 2, sampleRate: 48000 } };
	for (let i = 0; i < packets; i++) {
		await source.add(new EncodedPacket(new Uint8Array(200).fill(i), "key", i * 0.02, 0.02), i === 0 ? meta : undefined);
	}
	return output;
}

type Outcome = { rejected: false; value: unknown } | { rejected: true; error: unknown };
// bun 1.2.18 can hang after an unhandled rejection: only ever await this.
function outcomeOf({ promise }: { promise: Promise<unknown> }): Promise<Outcome> {
	return promise.then(
		(value): Outcome => ({ rejected: false, value }),
		(error: unknown): Outcome => ({ rejected: true, error }),
	);
}

function topLevelBoxes({ bytes }: { bytes: Uint8Array }): string[] {
	const types: string[] = [];
	for (let at = 0; at + 8 <= bytes.length && types.length < 100; ) {
		const size = new DataView(bytes.buffer, bytes.byteOffset + at, 8).getUint32(0);
		types.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
		if (size < 8) break;
		at += size;
	}
	return types;
}

describe("getDesktopExportBridge", () => {
	test("finds a complete bridge, refuses anything less", () => {
		const { bridge } = createFakeBridge();
		expect(getDesktopExportBridge({ scope: { ccutExport: bridge } })).toBe(bridge);
		expect(getDesktopExportBridge({ scope: {} })).toBeNull();
		expect(getDesktopExportBridge({ scope: { ccutExport: { ...bridge, reveal: undefined } } })).toBeNull();
		expect(getDesktopExportBridge({ scope: { ccutExport: "x" } })).toBeNull();
		expect(getDesktopExportBridge({ scope: { ccutExport: null } })).toBeNull();
		expect(getDesktopExportBridge()).toBeNull(); // bun has no preload
	});

	test("bridgeErrorCode reads the code out of Electron's wrapped message", () => {
		const wrap = (code: string) => new Error(`Error invoking remote method 'ccut-export:write': ExportIpcError: CCUT_EXPORT:${code}`);
		expect(bridgeErrorCode({ error: wrap("DISK_FULL") })).toBe("DISK_FULL");
		expect(bridgeErrorCode({ error: wrap("VERIFY_FAILED") })).toBe("VERIFY_FAILED");
		// A session the main process no longer has (expired, or closed with the page) is not "pick another folder".
		expect(bridgeErrorCode({ error: wrap("UNKNOWN_SESSION") })).toBe("SESSION_EXPIRED");
		for (const other of ["WRITE_FAILED", "INVALID", "FORBIDDEN"]) {
			expect(bridgeErrorCode({ error: wrap(other) })).toBe("WRITE_FAILED");
		}
		expect(bridgeErrorCode({ error: "weird" })).toBe("WRITE_FAILED");
	});

	test("bridgeErrorDetail names the stage and the bridge code, or else what the error said", () => {
		const wrap = (code: string) => new Error(`Error invoking remote method 'ccut-export:write': ExportIpcError: CCUT_EXPORT:${code}`);
		expect(bridgeErrorDetail({ error: wrap("FORBIDDEN"), stage: "while writing" })).toBe("while writing (CCUT_EXPORT:FORBIDDEN)");
		expect(bridgeErrorDetail({ error: new Error("CCUT_EXPORT:INVALID"), stage: "while opening the file" })).toBe("while opening the file (CCUT_EXPORT:INVALID)");
		expect(bridgeErrorDetail({ error: new TypeError("An object could not be cloned."), stage: "while writing" })).toBe(
			"while writing (An object could not be cloned.)",
		);
		expect(bridgeErrorDetail({ error: "weird", stage: "while finishing" })).toBe("while finishing (weird)");
		expect(bridgeErrorDetail({ error: new Error(""), stage: "while finishing" })).toBe("while finishing (no message)");
		// A long message is cut: the detail is shown to the user.
		expect(bridgeErrorDetail({ error: new Error("x".repeat(1000)), stage: "while writing" }).length).toBeLessThan(200);
	});
});

describe("desktop sink", () => {
	test("MP4: streamed with the moov reserved at the front (ftyp, moov, free, mdat), committed with the exact size", async () => {
		const fake = createFakeBridge();
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1" });
		expect(sink.fastStart).toBe("reserve");
		const output = await writeFile({ sink, format: "mp4" });
		await output.finalize();
		expect(fake.calls.some((call) => call.method === "finish")).toBe(false); // finalize alone never commits
		const result = await sink.commit();

		const bytes = fake.file();
		expect(result).toEqual({ kind: "file", displayName: "clip.mp4", bytes: bytes.length, revealToken: "t1" });
		expect(fake.calls.at(-1)).toEqual({ method: "finish", request: { token: "t1", totalBytes: bytes.length } });
		expect(topLevelBoxes({ bytes })).toEqual(["ftyp", "moov", "free", "mdat"]);
		const input = new Input({ source: new BufferSource(bytes.slice().buffer), formats: ALL_FORMATS });
		try {
			expect((await input.getPrimaryAudioTrack())?.codec).toBe("aac");
		} finally {
			input.dispose();
		}
	});

	test("WebM goes through the same path, back-patches included", async () => {
		const fake = createFakeBridge();
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1" });
		const output = await writeFile({ sink, format: "webm" });
		await output.finalize();
		await sink.commit();
		const input = new Input({ source: new BufferSource(fake.file().slice().buffer), formats: ALL_FORMATS });
		try {
			expect((await input.getPrimaryAudioTrack())?.codec).toBe("opus");
		} finally {
			input.dispose();
		}
	});

	test("every IPC write carries only its own bytes (no larger backing buffer) and at most one chunk", async () => {
		const fake = createFakeBridge();
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1" });
		const output = await writeFile({ sink, format: "mp4" });
		await output.finalize();
		const writes = fake.calls.filter((call) => call.method === "write").map((call) => call.request);
		expect(writes.length).toBeGreaterThan(0);
		for (const write of writes) {
			expect(write).toMatchObject({ token: "t1", ownsBuffer: true });
			expect(Reflect.get(Object(write), "length")).toBeLessThanOrEqual(DESKTOP_CHUNK_BYTES);
		}
	});

	test("a write the main process refuses (disk full) becomes DISK_FULL out of finalize; commit is then refused, abort tells the main process once", async () => {
		const fake = createFakeBridge({ failWriteAfter: 0 });
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1" });
		const output = await writeFile({ sink, format: "mp4" });
		const outcome = await outcomeOf({ promise: output.finalize() });
		const error = outcome.rejected ? outcome.error : null;
		expect(isExportError(error) && error.code).toBe("DISK_FULL");

		const commit = await outcomeOf({ promise: sink.commit() });
		expect(commit.rejected).toBe(true);
		expect(fake.calls.some((call) => call.method === "finish")).toBe(false);
		await sink.abort();
		await sink.abort();
		expect(fake.calls.filter((call) => call.method === "abort")).toEqual([{ method: "abort", request: { token: "t1" } }]);
	});

	test("a finish the main process refuses (file did not check out) is VERIFY_FAILED; abort afterwards sends nothing", async () => {
		const fake = createFakeBridge({ finishError: "Error invoking remote method 'ccut-export:finish': ExportIpcError: CCUT_EXPORT:VERIFY_FAILED" });
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1" });
		const output = await writeFile({ sink, format: "mp4" });
		await output.finalize();
		const outcome = await outcomeOf({ promise: sink.commit() });
		const error = outcome.rejected ? outcome.error : null;
		expect(isExportError(error) && error.code).toBe("VERIFY_FAILED");
		await sink.abort();
		expect(fake.calls.filter((call) => call.method === "abort")).toEqual([]);
	});

	test("Output.cancel() closes the stream but never commits; abort deletes the part file; writes after abort are refused", async () => {
		const fake = createFakeBridge();
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1" });
		const output = await writeFile({ sink, format: "mp4" });
		await output.cancel();
		expect(fake.calls.some((call) => call.method === "finish")).toBe(false);
		await sink.abort();
		expect(fake.calls.filter((call) => call.method === "abort")).toHaveLength(1);
		const outcome = await outcomeOf({ promise: sink.commit() });
		expect(outcome.rejected).toBe(true);
		expect(fake.calls.some((call) => call.method === "finish")).toBe(false);
	});

	test("abort after a successful commit does nothing (the file stays)", async () => {
		const fake = createFakeBridge();
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1" });
		const output = await writeFile({ sink, format: "mp4" });
		await output.finalize();
		await sink.commit();
		await sink.abort();
		expect(fake.calls.filter((call) => call.method === "abort")).toEqual([]);
	});

	test("an abort the main process rejects (session already gone) is not an error", async () => {
		const fake = createFakeBridge();
		fake.bridge.abort = async () => {
			throw new Error("CCUT_EXPORT:UNKNOWN_SESSION");
		};
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1" });
		expect((await outcomeOf({ promise: sink.abort() })).rejected).toBe(false);
	});
});

const failingWith = (code: string) => `Error invoking remote method 'ccut-export:write': ExportIpcError: CCUT_EXPORT:${code}`;

describe("desktop sink: what the user can copy out of a failure", () => {
	test("a failed write carries the bridge's code in the details (a sender or type problem in the real window is then visible)", async () => {
		for (const code of ["FORBIDDEN", "INVALID"]) {
			const fake = createFakeBridge({ failWriteAfter: 0, failWith: failingWith(code) });
			const sink = createDesktopSink({ bridge: fake.bridge, token: "t1", keepAlive: createFakeIntervals().timers });
			const output = await writeFile({ sink, format: "mp4" });
			const outcome = await outcomeOf({ promise: output.finalize() });
			const error = outcome.rejected ? outcome.error : null;
			if (!isExportError(error)) throw new Error("expected an ExportError");
			expect(error.code).toBe("WRITE_FAILED");
			expect(error.detail).toBe(`while writing (CCUT_EXPORT:${code})`);
			expect(error.message).toContain(`CCUT_EXPORT:${code}`);
			expect(error.cause).toBeInstanceOf(Error);
		}
	});

	test("a session the main process no longer knows is SESSION_EXPIRED with its own message, not 'pick another folder'", async () => {
		const fake = createFakeBridge({ failWriteAfter: 0, failWith: failingWith("UNKNOWN_SESSION") });
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1", keepAlive: createFakeIntervals().timers });
		const output = await writeFile({ sink, format: "mp4" });
		const outcome = await outcomeOf({ promise: output.finalize() });
		const error = outcome.rejected ? outcome.error : null;
		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.code).toBe("SESSION_EXPIRED");
		expect(error.message).toContain("The export session expired or was closed. Start the export again.");
		expect(error.message).not.toMatch(/another folder/i);
		expect(error.detail).toBe("while writing (CCUT_EXPORT:UNKNOWN_SESSION)");
	});

	test("finish: the same, for the commit", async () => {
		const fake = createFakeBridge({ finishError: failingWith("UNKNOWN_SESSION").replace("write", "finish") });
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1", keepAlive: createFakeIntervals().timers });
		const output = await writeFile({ sink, format: "mp4" });
		await output.finalize();
		const outcome = await outcomeOf({ promise: sink.commit() });
		const error = outcome.rejected ? outcome.error : null;
		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.code).toBe("SESSION_EXPIRED");
		expect(error.detail).toBe("while finishing (CCUT_EXPORT:UNKNOWN_SESSION)");
	});

	test("begin: a rejected begin carries the code too", async () => {
		const fake = createFakeBridge();
		fake.bridge.begin = async () => {
			throw new Error("CCUT_EXPORT:FORBIDDEN");
		};
		const outcome = await outcomeOf({ promise: openExportSink({ bridge: fake.bridge, format: "mp4", suggestedName: "x", estimatedBytes: 1 }) });
		const error = outcome.rejected ? outcome.error : null;
		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.detail).toBe("while opening the file (CCUT_EXPORT:FORBIDDEN)");
	});
});

describe("desktop sink: keepalive", () => {
	const keepalives = (fake: ReturnType<typeof createFakeBridge>) =>
		fake.calls.filter((call) => call.method === "write" && Reflect.get(Object(call.request), "length") === 0);

	test("every minute while the export runs, a zero-length write at position 0 tells the main process the page is alive", async () => {
		expect(KEEPALIVE_INTERVAL_MS).toBe(60_000);
		const intervals = createFakeIntervals();
		const fake = createFakeBridge();
		createDesktopSink({ bridge: fake.bridge, token: "t1", keepAlive: intervals.timers });
		expect(intervals.active()).toBe(1);
		expect(keepalives(fake)).toEqual([]);
		await intervals.tick();
		await intervals.tick();
		expect(keepalives(fake)).toEqual([
			{ method: "write", request: { token: "t1", position: 0, length: 0, ownsBuffer: true } },
			{ method: "write", request: { token: "t1", position: 0, length: 0, ownsBuffer: true } },
		]);
	});

	test("the interval is the one asked for: 60 s by default", () => {
		const asked: number[] = [];
		const timers: KeepAliveTimers = {
			setInterval: ({ ms }) => {
				asked.push(ms);
				return 1;
			},
			clearInterval: () => {},
		};
		createDesktopSink({ bridge: createFakeBridge().bridge, token: "t1", keepAlive: timers });
		expect(asked).toEqual([KEEPALIVE_INTERVAL_MS]);
	});

	test("it does not touch the file: the written bytes are exactly the muxer's", async () => {
		const intervals = createFakeIntervals();
		const fake = createFakeBridge();
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1", keepAlive: intervals.timers });
		await intervals.tick();
		const output = await writeFile({ sink, format: "mp4" });
		await intervals.tick();
		await output.finalize();
		await intervals.tick();
		const result = await sink.commit();
		expect(result).toMatchObject({ kind: "file", bytes: fake.file().length });
		expect(topLevelBoxes({ bytes: fake.file() })).toEqual(["ftyp", "moov", "free", "mdat"]);
	});

	test("it stops at commit, at abort (also an abort after a failure) and when a write fails", async () => {
		const committed = createFakeIntervals();
		const fakeA = createFakeBridge();
		const sinkA = createDesktopSink({ bridge: fakeA.bridge, token: "t1", keepAlive: committed.timers });
		const outputA = await writeFile({ sink: sinkA, format: "mp4" });
		await outputA.finalize();
		await sinkA.commit();
		expect(committed.active()).toBe(0);

		const aborted = createFakeIntervals();
		const sinkB = createDesktopSink({ bridge: createFakeBridge().bridge, token: "t1", keepAlive: aborted.timers });
		await sinkB.abort();
		expect(aborted.active()).toBe(0);

		const failed = createFakeIntervals();
		const fakeC = createFakeBridge({ failWriteAfter: 0 });
		const sinkC = createDesktopSink({ bridge: fakeC.bridge, token: "t1", keepAlive: failed.timers });
		const outputC = await writeFile({ sink: sinkC, format: "mp4" });
		await outcomeOf({ promise: outputC.finalize() });
		expect(failed.active()).toBe(0);
	});

	test("a commit that fails still ends the keepalive", async () => {
		const intervals = createFakeIntervals();
		const fake = createFakeBridge({ finishError: "CCUT_EXPORT:VERIFY_FAILED" });
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1", keepAlive: intervals.timers });
		const output = await writeFile({ sink, format: "mp4" });
		await output.finalize();
		await outcomeOf({ promise: sink.commit() });
		expect(intervals.active()).toBe(0);
	});

	test("a keepalive the main process refuses ends the keepalive quietly; the next real write or the commit reports the loss", async () => {
		const intervals = createFakeIntervals();
		const fake = createFakeBridge();
		const realWrite = fake.bridge.write;
		let refuse = false;
		fake.bridge.write = async (request) => {
			if (refuse && request.data.byteLength === 0) throw new Error(failingWith("UNKNOWN_SESSION"));
			return realWrite(request);
		};
		const sink = createDesktopSink({ bridge: fake.bridge, token: "t1", keepAlive: intervals.timers });
		refuse = true;
		await intervals.tick();
		expect(intervals.active()).toBe(0);
		await sink.abort(); // nothing throws
	});

	test("a bridge that throws at once instead of rejecting does not escape the timer", async () => {
		const intervals = createFakeIntervals();
		const fake = createFakeBridge();
		fake.bridge.write = () => {
			throw new Error("not cloneable");
		};
		createDesktopSink({ bridge: fake.bridge, token: "t1", keepAlive: intervals.timers });
		await intervals.tick();
		expect(intervals.active()).toBe(0);
	});
});

describe("buffer sink (browser fallback)", () => {
	test("today's in-memory MP4: moov first, the bytes come back from commit", async () => {
		const sink = createBufferSink();
		expect(sink.fastStart).toBe("in-memory");
		const output = await writeFile({ sink, format: "mp4" });
		await output.finalize();
		const result = await sink.commit();
		if (result.kind !== "buffer") throw new Error("expected bytes");
		expect(result.bytes).toBe(result.buffer.byteLength);
		expect(topLevelBoxes({ bytes: new Uint8Array(result.buffer) }).slice(0, 2)).toEqual(["ftyp", "moov"]);
	});

	test("commit without a finished file is refused", async () => {
		const outcome = await outcomeOf({ promise: createBufferSink().commit() });
		expect(outcome.rejected).toBe(true);
	});
});

describe("openExportSink", () => {
	const args = { format: "mp4" as const, suggestedName: "My film", estimatedBytes: 1000 };

	test("with the bridge: begin gets the name, container and estimate; ok -> a desktop sink", async () => {
		const fake = createFakeBridge();
		const sink = await openExportSink({ ...args, bridge: fake.bridge });
		expect(sink?.fastStart).toBe("reserve");
		expect(fake.calls).toEqual([{ method: "begin", request: { suggestedName: "My film", container: "mp4", estimatedBytes: 1000 } }]);
	});

	test("a cancelled save dialog is null: nothing to export, no error", async () => {
		const fake = createFakeBridge({ beginResult: { ok: false, reason: "cancelled" } });
		expect(await openExportSink({ ...args, bridge: fake.bridge })).toBeNull();
	});

	test("busy, invalid and an unwritable folder are coded errors; a rejected begin too", async () => {
		const cases: [BeginResult, ExportErrorCode][] = [
			[{ ok: false, reason: "busy" }, "EXPORT_BUSY"],
			[{ ok: false, reason: "invalid" }, "WRITE_FAILED"],
			[{ ok: false, reason: "dir-not-writable" }, "WRITE_FAILED"],
		];
		for (const [beginResult, code] of cases) {
			const outcome = await outcomeOf({ promise: openExportSink({ ...args, bridge: createFakeBridge({ beginResult }).bridge }) });
			const error = outcome.rejected ? outcome.error : null;
			expect(isExportError(error) && error.code).toBe(code);
		}
		const fake = createFakeBridge();
		fake.bridge.begin = async () => {
			throw new Error("CCUT_EXPORT:FORBIDDEN");
		};
		const outcome = await outcomeOf({ promise: openExportSink({ ...args, bridge: fake.bridge }) });
		const error = outcome.rejected ? outcome.error : null;
		expect(isExportError(error) && error.code).toBe("WRITE_FAILED");
	});

	test("without the bridge: the in-memory sink, unless the estimate is over the limit", async () => {
		expect((await openExportSink({ ...args, bridge: null }))?.fastStart).toBe("in-memory");
		expect((await openExportSink({ ...args, bridge: null, estimatedBytes: IN_MEMORY_EXPORT_LIMIT_BYTES }))?.fastStart).toBe("in-memory");
		const outcome = await outcomeOf({ promise: openExportSink({ ...args, bridge: null, estimatedBytes: IN_MEMORY_EXPORT_LIMIT_BYTES + 1 }) });
		const error = outcome.rejected ? outcome.error : null;
		expect(isExportError(error) && error.code).toBe("TOO_LARGE_FOR_MEMORY");
	});

	test("a long project name is cut before it is sent: never over 1000 UTF-16 units (the main process refuses more), never through a surrogate pair", async () => {
		expect(MAX_SUGGESTED_NAME_CODE_POINTS).toBe(120);
		const sent: string[] = [];
		const fake = createFakeBridge();
		fake.bridge.begin = async ({ suggestedName }) => {
			sent.push(suggestedName);
			return { ok: false, reason: "cancelled" };
		};
		for (const name of ["中".repeat(1500), "😀".repeat(900), "a".repeat(100_000), "short"]) {
			await openExportSink({ ...args, suggestedName: name, bridge: fake.bridge });
		}
		expect(sent[0]).toBe("中".repeat(120));
		expect(sent[1]).toBe("😀".repeat(120));
		expect(sent[2]).toBe("a".repeat(120));
		expect(sent[3]).toBe("short");
		for (const name of sent) expect(name.length).toBeLessThanOrEqual(1000);
	});

	test("shortenSuggestedName keeps what fits, including the empty name and a lone surrogate", () => {
		expect(shortenSuggestedName({ name: "" })).toBe("");
		expect(shortenSuggestedName({ name: "a".repeat(120) })).toBe("a".repeat(120));
		expect(shortenSuggestedName({ name: "a".repeat(121) })).toBe("a".repeat(120));
		expect(shortenSuggestedName({ name: `${"a".repeat(119)}😀😀` })).toBe(`${"a".repeat(119)}😀`);
		expect(shortenSuggestedName({ name: "\ud800".repeat(130) })).toBe("\ud800".repeat(120));
	});

	test("a name the file system cannot hold is its own error, not 'pick another folder'", async () => {
		const fake = createFakeBridge({ beginResult: { ok: false, reason: "name-too-long" } });
		const outcome = await outcomeOf({ promise: openExportSink({ ...args, bridge: fake.bridge }) });
		const error = outcome.rejected ? outcome.error : null;
		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.code).toBe("NAME_TOO_LONG");
		expect(error.message).toMatch(/too long/i);
		expect(error.message).not.toMatch(/another folder/i);
	});

	test("with the bridge, a big export is not limited by memory", async () => {
		const fake = createFakeBridge();
		expect(await openExportSink({ ...args, bridge: fake.bridge, estimatedBytes: 50 * 2 ** 30 })).not.toBeNull();
	});
});

describe("size estimate", () => {
	const qualities = { low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH, very_high: QUALITY_VERY_HIGH };

	test("the video bitrate is mediabunny's, for every quality, both codecs and several sizes", () => {
		for (const quality of EXPORT_QUALITY_VALUES) {
			const toVideoBitrate: unknown = Reflect.get(qualities[quality], "_toVideoBitrate");
			if (typeof toVideoBitrate !== "function") throw new Error("mediabunny changed Quality");
			for (const [width, height] of [[1920, 1080], [3840, 2160], [1280, 720], [1080, 1920], [640, 360]]) {
				for (const [format, codec] of [["mp4", "avc"], ["webm", "vp9"]] as const) {
					expect(videoBitrateFor({ format, quality, width, height })).toBe(toVideoBitrate.call(qualities[quality], codec, width, height));
				}
			}
		}
	});

	test("bytes = (video + audio) x seconds / 8; no audio, no audio bytes", () => {
		const base = { format: "mp4" as const, quality: "high" as const, width: 1920, height: 1080, durationSeconds: 60 };
		expect(estimateExportBytes({ ...base, includeAudio: false })).toBe((6_000_000 * 60) / 8);
		expect(estimateExportBytes({ ...base, includeAudio: true })).toBe(((6_000_000 + 192_000) * 60) / 8);
		expect(estimateExportBytes({ ...base, durationSeconds: -5, includeAudio: true })).toBe(0);
	});

	test("an hour of 4K at very high quality is over the in-memory limit; ten minutes of 1080p high is not", () => {
		const hour4k = estimateExportBytes({ format: "mp4", quality: "very_high", width: 3840, height: 2160, durationSeconds: 3600, includeAudio: true });
		expect(hour4k).toBeGreaterThan(IN_MEMORY_EXPORT_LIMIT_BYTES);
		const short = estimateExportBytes({ format: "mp4", quality: "high", width: 1920, height: 1080, durationSeconds: 600, includeAudio: true });
		expect(short).toBeLessThan(IN_MEMORY_EXPORT_LIMIT_BYTES);
	});
});
