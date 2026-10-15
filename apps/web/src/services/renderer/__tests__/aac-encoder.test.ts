import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	AudioSample,
	AudioSampleSource,
	BufferTarget,
	Mp4OutputFormat,
	Output,
	canEncodeAudio,
	type AudioCodec,
} from "mediabunny";
import { ExportError, isExportError } from "@/export/errors";
import {
	assertAacMp4,
	createAacEncoderGate,
	runAacTrialEncode,
	type AacEncoderDeps,
	type AacEncoderParams,
} from "../aac-encoder";

const STEREO_44K: AacEncoderParams = {
	sampleRate: 44100,
	numberOfChannels: 2,
	bitrate: 192_000,
};

type Deferred = { promise: Promise<void>; resolve: () => void };

function defer(): Deferred {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Fakes that record the order of events; each can be made to fail on demand. */
type FakeTimer = { ms: number; fire: () => void; cancelled: boolean; fired: boolean };

function createFakes({
	gateLoad,
	failures = {},
}: {
	gateLoad?: Deferred;
	failures?: { load?: number; register?: number; trial?: number; probeFalse?: boolean };
} = {}) {
	const log: string[] = [];
	const remaining = {
		load: failures.load ?? 0,
		register: failures.register ?? 0,
		trial: failures.trial ?? 0,
	};
	let registered = false;
	const trialSignals: AbortSignal[] = [];
	const timers: FakeTimer[] = [];

	const deps: AacEncoderDeps = {
		trialTimeoutMs: 20_000,
		startTimeout: ({ ms, onTimeout }) => {
			const timer: FakeTimer = {
				ms,
				cancelled: false,
				fired: false,
				fire: () => {
					timer.fired = true;
					onTimeout();
				},
			};
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		loadEncoderModule: async () => {
			log.push("load");
			await gateLoad?.promise;
			if (remaining.load-- > 0) throw new Error("chunk failed to load");
			return {
				registerAacEncoder: () => {
					log.push("register");
					if (remaining.register-- > 0) throw new Error("registerEncoder threw");
					registered = true;
				},
			};
		},
		canEncodeAac: async (params) => {
			log.push(`probe:${params.sampleRate}/${params.numberOfChannels}`);
			// Like mediabunny without a native encoder: true only after registration.
			return registered && !failures.probeFalse && params.sampleRate !== 12345;
		},
		trialEncode: async ({ signal }) => {
			log.push("trial");
			trialSignals.push(signal);
			if (remaining.trial-- > 0) throw new Error("worker never answered");
		},
	};

	return { deps, log, trialSignals, timers, isRegistered: () => registered };
}

function count({ log, entry }: { log: string[]; entry: string }): number {
	return log.filter((item) => item === entry).length;
}

// bun 1.2.18 does not exit after a test run that saw an unhandled rejection. So a
// promise that is not awaited right away goes through `outcomeOf`, which never
// rejects, and only awaited promises go through `rejection`.
type Outcome = { rejected: false } | { rejected: true; error: unknown };

function outcomeOf({ promise }: { promise: Promise<unknown> }): Promise<Outcome> {
	return promise.then(
		(): Outcome => ({ rejected: false }),
		(error: unknown): Outcome => ({ rejected: true, error }),
	);
}

function errorOf({ outcome }: { outcome: Outcome }): unknown {
	if (!outcome.rejected) throw new Error("expected the promise to reject");
	return outcome.error;
}

/** Resolves to "stuck" if `promise` has not settled after `ms`: a failed wait instead of a hung test. */
function settledWithin({ promise, ms }: { promise: Promise<unknown>; ms: number }): Promise<"settled" | "stuck"> {
	return Promise.race([
		promise.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), ms)),
	]);
}

async function rejection({ promise }: { promise: Promise<unknown> }): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

describe("ensureAacEncoder (gate with fakes)", () => {
	test("creating the gate loads nothing: the 1 MB encoder is fetched only when an export asks for it", () => {
		const { deps, log } = createFakes();
		createAacEncoderGate({ deps });
		expect(log).toEqual([]);
	});

	test("loads, registers, probes AFTER registering, then runs the trial encode with the export's parameters", async () => {
		const { deps, log } = createFakes();
		const gate = createAacEncoderGate({ deps });

		await gate.ensure(STEREO_44K);

		expect(log).toEqual(["load", "register", "probe:44100/2", "trial"]);
	});

	test("a second call registers and trials nothing again, but still checks its own parameters", async () => {
		const { deps, log } = createFakes();
		const gate = createAacEncoderGate({ deps });
		await gate.ensure(STEREO_44K);
		log.length = 0;

		await gate.ensure({ sampleRate: 48000, numberOfChannels: 1, bitrate: 128_000 });

		expect(log).toEqual(["probe:48000/1"]);
	});

	test("concurrent calls register once, load once and trial once", async () => {
		const gateLoad = defer();
		const { deps, log } = createFakes({ gateLoad });
		const gate = createAacEncoderGate({ deps });

		const calls = [
			gate.ensure(STEREO_44K),
			gate.ensure(STEREO_44K),
			gate.ensure({ sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 }),
		];
		gateLoad.resolve();
		await Promise.all(calls);

		expect(count({ log, entry: "load" })).toBe(1);
		expect(count({ log, entry: "register" })).toBe(1);
		expect(count({ log, entry: "trial" })).toBe(1);
	});

	test("a parameter set the encoder cannot do is AAC_UNAVAILABLE for that call only", async () => {
		const { deps, log } = createFakes();
		const gate = createAacEncoderGate({ deps });
		await gate.ensure(STEREO_44K);

		const error = await rejection({
			promise: gate.ensure({ sampleRate: 12345, numberOfChannels: 2, bitrate: 128_000 }),
		});

		expect(isExportError(error) && error.code).toBe("AAC_UNAVAILABLE");
		await gate.ensure(STEREO_44K);
		expect(count({ log, entry: "trial" })).toBe(1);
	});

	test("the probe saying no after registration fails with AAC_UNAVAILABLE and skips the trial", async () => {
		const { deps, log } = createFakes({ failures: { probeFalse: true } });
		const gate = createAacEncoderGate({ deps });

		const error = await rejection({ promise: gate.ensure(STEREO_44K) });

		expect(error).toBeInstanceOf(ExportError);
		expect(count({ log, entry: "trial" })).toBe(0);
	});

	test("a failed trial encode is AAC_UNAVAILABLE with a plain-language message, the stage and the cause", async () => {
		const { deps } = createFakes({ failures: { trial: 1 } });
		const gate = createAacEncoderGate({ deps });

		const error = await rejection({ promise: gate.ensure(STEREO_44K) });

		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.code).toBe("AAC_UNAVAILABLE");
		expect(error.message).toContain("AAC audio encoder could not start");
		expect(error.message).toContain("WebM (Opus audio)");
		expect(error.message).toContain('turn off "Include audio"');
		expect(error.detail).toContain("trial encode");
		expect(error.detail).toContain("worker never answered");
		expect(error.cause).toBeInstanceOf(Error);
	});

	test("a failed trial is retryable: the next call tries again, registers nothing twice, and succeeds", async () => {
		const { deps, log } = createFakes({ failures: { trial: 1 } });
		const gate = createAacEncoderGate({ deps });
		await rejection({ promise: gate.ensure(STEREO_44K) });

		await gate.ensure(STEREO_44K);

		expect(count({ log, entry: "load" })).toBe(1);
		expect(count({ log, entry: "register" })).toBe(1);
		expect(count({ log, entry: "trial" })).toBe(2);
	});

	test("two callers that wait on a failing setup both get the error, and the next call is not stuck on the rejected promise", async () => {
		const gateLoad = defer();
		const { deps, log } = createFakes({ gateLoad, failures: { trial: 1 } });
		const gate = createAacEncoderGate({ deps });

		const first = outcomeOf({ promise: gate.ensure(STEREO_44K) });
		const second = outcomeOf({ promise: gate.ensure(STEREO_44K) });
		gateLoad.resolve();
		const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

		expect(errorOf({ outcome: firstOutcome })).toBeInstanceOf(ExportError);
		expect(errorOf({ outcome: secondOutcome })).toBeInstanceOf(ExportError);
		expect(count({ log, entry: "trial" })).toBe(1);
		await gate.ensure(STEREO_44K);
		expect(count({ log, entry: "trial" })).toBe(2);
	});

	test("a chunk that fails to load is AAC_UNAVAILABLE, and the retry imports again", async () => {
		const { deps, log } = createFakes({ failures: { load: 1 } });
		const gate = createAacEncoderGate({ deps });

		const error = await rejection({ promise: gate.ensure(STEREO_44K) });
		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.detail).toContain("loading the encoder");
		expect(error.detail).toContain("chunk failed to load");

		await gate.ensure(STEREO_44K);
		expect(count({ log, entry: "load" })).toBe(2);
		expect(count({ log, entry: "register" })).toBe(1);
	});

	test("a registration that throws is AAC_UNAVAILABLE, and the retry registers again", async () => {
		const { deps, log, isRegistered } = createFakes({ failures: { register: 1 } });
		const gate = createAacEncoderGate({ deps });

		const error = await rejection({ promise: gate.ensure(STEREO_44K) });
		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.detail).toContain("registering the encoder");
		expect(isRegistered()).toBe(false);

		await gate.ensure(STEREO_44K);
		expect(count({ log, entry: "register" })).toBe(2);
		expect(isRegistered()).toBe(true);
	});

	test("a trial encode that never answers (worker blocked, wasm stuck) times out as AAC_UNAVAILABLE, aborts the trial, and is retryable", async () => {
		const { deps, trialSignals, timers, log } = createFakes();
		const trialStarted = defer();
		const hang: AacEncoderDeps = {
			...deps,
			trialEncode: ({ signal }) => {
				trialSignals.push(signal);
				trialStarted.resolve();
				return new Promise<void>(() => {});
			},
		};
		const gate = createAacEncoderGate({ deps: hang });

		const pending = outcomeOf({ promise: gate.ensure(STEREO_44K) });
		await Promise.race([trialStarted.promise, pending]);
		expect(timers).toHaveLength(1);
		expect(timers[0]?.ms).toBe(20_000);
		timers[0]?.fire();
		expect(await settledWithin({ promise: pending, ms: 1_000 })).toBe("settled");
		const error = errorOf({ outcome: await pending });

		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.code).toBe("AAC_UNAVAILABLE");
		expect(error.detail).toContain("trial encode");
		expect(error.detail).toContain("did not answer within 20000 ms");
		expect(trialSignals).toHaveLength(1);
		expect(trialSignals[0]?.aborted).toBe(true);

		// A new gate with a working trial is fine, and the failed one is not poisoned either.
		const retry = createAacEncoderGate({ deps });
		await retry.ensure(STEREO_44K);
		expect(count({ log, entry: "trial" })).toBe(1);
	});

	test("the timeout timer is cancelled when the trial succeeds and when it fails, so none is left armed", async () => {
		const { deps, timers } = createFakes({ failures: { trial: 1 } });
		const gate = createAacEncoderGate({ deps });

		await rejection({ promise: gate.ensure(STEREO_44K) });
		await gate.ensure(STEREO_44K);

		expect(timers).toHaveLength(2);
		for (const timer of timers) {
			expect(timer.cancelled).toBe(true);
			expect(timer.fired).toBe(false);
		}
	});

	test("with the default timer the timeout is a real setTimeout of trialTimeoutMs, and clearTimeout gets that same handle when the trial ends", async () => {
		const setTimeoutSpy = spyOn(globalThis, "setTimeout");
		const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
		try {
			const { startTimeout: _fakeTimer, ...deps } = createFakes().deps;
			const gate = createAacEncoderGate({ deps: { ...deps, trialTimeoutMs: 54_321 } });

			await gate.ensure(STEREO_44K);

			const index = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 54_321);
			expect(index).toBeGreaterThan(-1);
			const handle = setTimeoutSpy.mock.results[index]?.value;
			expect(handle).toBeDefined();
			expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
		} finally {
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
		}
	});

	test("the default timer is cleared when the trial fails too", async () => {
		const setTimeoutSpy = spyOn(globalThis, "setTimeout");
		const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
		try {
			const { startTimeout: _fakeTimer, ...deps } = createFakes({ failures: { trial: 1 } }).deps;
			const gate = createAacEncoderGate({ deps: { ...deps, trialTimeoutMs: 65_432 } });

			await rejection({ promise: gate.ensure(STEREO_44K) });

			const index = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 65_432);
			expect(index).toBeGreaterThan(-1);
			expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[index]?.value);
		} finally {
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
		}
	});
});

function listSourceFiles({ directory }: { directory: string }): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			return name === "__tests__" || name === "node_modules"
				? []
				: listSourceFiles({ directory: path });
		}
		return /\.(ts|tsx)$/.test(name) ? [path] : [];
	});
}

describe("lazy import (the 997 KB encoder must not enter the main bundle)", () => {
	const sourceRoot = resolve(import.meta.dir, "../../..");
	const files = listSourceFiles({ directory: sourceRoot }).map((path) => ({
		path: relative(sourceRoot, path).split("\\").join("/"),
		text: readFileSync(path, "utf8"),
	}));

	test("only aac-encoder.ts mentions the package, and only as a dynamic import()", () => {
		const mentions = files.filter(({ text }) => text.includes("@mediabunny/aac-encoder"));
		expect(mentions.map(({ path }) => path)).toEqual(["services/renderer/aac-encoder.ts"]);

		const text = mentions[0]?.text ?? "";
		const staticImports = text.match(/^\s*(import|export)\b[^;(]*from\s+["']@mediabunny\/aac-encoder["']/gm);
		expect(staticImports).toBeNull();
		const dynamicImports = text.match(/\bimport\(\s*["']@mediabunny\/aac-encoder["']\s*\)/g);
		expect(dynamicImports).toHaveLength(1);
	});

	test("nothing statically imports the encoder through a side-effect import either", () => {
		for (const { path, text } of files) {
			expect(`${path}: ${/^\s*import\s+["']@mediabunny\/aac-encoder["']/m.test(text)}`).toBe(
				`${path}: false`,
			);
		}
	});
});

describe("runAacTrialEncode (real mediabunny, no fake)", () => {
	test("an abort while the trial runs cancels its Output, which releases the encoder worker", async () => {
		const start = spyOn(Output.prototype, "start").mockImplementation(() => new Promise<void>(() => {}));
		const cancel = spyOn(Output.prototype, "cancel").mockImplementation(async () => {});
		try {
			const controller = new AbortController();
			// Never settles: start() is held. Only its outcome is a promise that cannot reject.
			void outcomeOf({ promise: runAacTrialEncode({ params: STEREO_44K, signal: controller.signal }) });
			expect(cancel).not.toHaveBeenCalled();

			controller.abort();

			expect(cancel).toHaveBeenCalledTimes(1);
		} finally {
			start.mockRestore();
			cancel.mockRestore();
		}
	});

	test("an encode failure cancels the Output once, and the failure is what the caller gets", async () => {
		const failure = new Error("start failed");
		const start = spyOn(Output.prototype, "start").mockImplementation(async () => {
			throw failure;
		});
		const cancel = spyOn(Output.prototype, "cancel").mockImplementation(async () => {});
		try {
			const error = await rejection({
				promise: runAacTrialEncode({ params: STEREO_44K, signal: new AbortController().signal }),
			});

			expect(error).toBe(failure);
			expect(cancel).toHaveBeenCalledTimes(1);
		} finally {
			start.mockRestore();
			cancel.mockRestore();
		}
	});

	test("a cancel that fails is warned about as a possible leaked worker, and does not replace the encode failure", async () => {
		const failure = new Error("start failed again");
		const start = spyOn(Output.prototype, "start").mockImplementation(async () => {
			throw failure;
		});
		const cancel = spyOn(Output.prototype, "cancel").mockImplementation(async () => {
			throw new Error("cancel failed");
		});
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const error = await rejection({
				promise: runAacTrialEncode({ params: STEREO_44K, signal: new AbortController().signal }),
			});
			// The cancel is not awaited by the trial: let its failure surface.
			await Promise.resolve();
			await Promise.resolve();

			expect(error).toBe(failure);
			expect(warn).toHaveBeenCalledWith("output.cancel failed (possible leaked encoder worker)", expect.any(Error));
		} finally {
			start.mockRestore();
			cancel.mockRestore();
			warn.mockRestore();
		}
	});

	test("rejects with the encoder's own error when it cannot do the configuration: a failure is never swallowed", async () => {
		const error = await rejection({
			promise: runAacTrialEncode({
				params: { sampleRate: 12345, numberOfChannels: 2, bitrate: 128_000 },
				signal: new AbortController().signal,
			}),
		});

		expect(error).toBeInstanceOf(Error);
		// Not the file check that runs afterwards: the encode failure itself is what surfaces.
		expect(error instanceof Error && error.message).not.toMatch(/wrote no file|not AAC|no audio track|expected about/);
	});
});

describe("the real wasm encoder, running in a bun worker thread", () => {
	// Registers the real @mediabunny/aac-encoder (1.41.0). bun has no WebCodecs,
	// so this is the wasm FFmpeg AAC encoder and nothing else. It does not prove
	// the Electron window: CSP, Worker over a blob: URL and the real timeline
	// are for the e2e run (export-v2 X.1).
	// One gate for both tests: registering the real encoder twice makes mediabunny warn.
	const gate = createAacEncoderGate({});

	test("loads, registers, passes its own trial encode and mediabunny then reports AAC as encodable", async () => {
		await gate.ensure(STEREO_44K);
		await gate.ensure({ sampleRate: 48000, numberOfChannels: 1, bitrate: 96_000 });

		expect(await canEncodeAudio("aac", STEREO_44K)).toBe(true);
		expect(await canEncodeAudio("aac", { sampleRate: 12345, numberOfChannels: 2, bitrate: 128_000 })).toBe(false);
	}, 30_000);

	test("a parameter set AAC cannot do (12.345 kHz) is refused with AAC_UNAVAILABLE by the real probe", async () => {
		await gate.ensure(STEREO_44K);

		const error = await rejection({
			promise: gate.ensure({ sampleRate: 12345, numberOfChannels: 2, bitrate: 128_000 }),
		});

		expect(isExportError(error) && error.code).toBe("AAC_UNAVAILABLE");
	}, 30_000);

	async function encodeSilence({
		seconds,
		codec,
		sampleRate = 44100,
	}: {
		seconds: number;
		codec: AudioCodec;
		sampleRate?: number;
	}): Promise<ArrayBuffer> {
		const target = new BufferTarget();
		const output = new Output({ format: new Mp4OutputFormat(), target });
		const source = new AudioSampleSource({ codec, bitrate: 128_000 });
		output.addAudioTrack(source);
		await output.start();
		const silence = new AudioSample({
			data: new Float32Array(Math.round(sampleRate * seconds) * 2),
			format: "f32",
			numberOfChannels: 2,
			sampleRate,
			timestamp: 0,
		});
		await source.add(silence);
		silence.close();
		source.close();
		await output.finalize();
		if (!target.buffer) throw new Error("no buffer");
		return target.buffer;
	}

	test("the trial hands its real output to the verification, and a verification that throws fails the trial", async () => {
		await gate.ensure(STEREO_44K);
		const seen: { bytes: number | null; minimumSeconds: number }[] = [];

		await runAacTrialEncode({
			params: STEREO_44K,
			signal: new AbortController().signal,
			verifyOutput: async ({ buffer, minimumSeconds }) => {
				seen.push({ bytes: buffer?.byteLength ?? null, minimumSeconds });
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.bytes).toBeGreaterThan(500);
		expect(seen[0]?.minimumSeconds).toBeCloseTo(0.9, 5);

		const error = await rejection({
			promise: runAacTrialEncode({
				params: STEREO_44K,
				signal: new AbortController().signal,
				verifyOutput: async () => {
					throw new Error("verification said no");
				},
			}),
		});
		expect(error instanceof Error && error.message).toBe("verification said no");
	}, 30_000);

	test("assertAacMp4 accepts a real one-second AAC MP4 and refuses everything else", async () => {
		await gate.ensure(STEREO_44K);
		const aac = await encodeSilence({ seconds: 1, codec: "aac" });
		await assertAacMp4({ buffer: aac, minimumSeconds: 0.9 });

		const tooShort = await encodeSilence({ seconds: 0.2, codec: "aac" });
		const notAac = await encodeSilence({ seconds: 1, codec: "pcm-s16" });
		const garbage = new Uint8Array(4096).fill(7).buffer;

		const refusals = await Promise.all(
			[
				{ buffer: null, minimumSeconds: 0.9 },
				{ buffer: new ArrayBuffer(0), minimumSeconds: 0.9 },
				{ buffer: garbage, minimumSeconds: 0.9 },
				{ buffer: tooShort, minimumSeconds: 0.9 },
				{ buffer: notAac, minimumSeconds: 0.9 },
			].map(({ buffer, minimumSeconds }) => outcomeOf({ promise: assertAacMp4({ buffer, minimumSeconds }) })),
		);

		expect(refusals.map(({ rejected }) => rejected)).toEqual([true, true, true, true, true]);
		expect(String(errorOf({ outcome: refusals[3] }))).toContain("expected about");
		expect(String(errorOf({ outcome: refusals[4] }))).toContain("not AAC");
	}, 30_000);
});
