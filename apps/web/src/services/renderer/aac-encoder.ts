import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	Input,
	Mp4OutputFormat,
	Output,
	canEncodeAudio,
} from "mediabunny";
import { ExportError, createAacUnavailableError } from "@/export/errors";
import { cancelOutputQuietly } from "./output-cancel";

// MP4 audio is AAC-LC from `@mediabunny/aac-encoder` (FFmpeg's `aac`, as wasm) on
// every platform; mediabunny uses a registered encoder before a native one. The
// native WebCodecs AAC encoder is deliberately not used: Electron 44 has none
// (export-v2 M1), and a native one would need its own, unmeasured priming delay on
// Windows. Opening it is a separate decision that needs that measurement
// (decision 2026-10-03, point 3).

export type AacEncoderParams = {
	sampleRate: number;
	numberOfChannels: number;
	bitrate: number;
};

export interface AacEncoderDeps {
	/** The only place the 997 KB package is loaded: a dynamic import, so it is its own chunk. */
	loadEncoderModule: () => Promise<{ registerAacEncoder: () => void }>;
	/** mediabunny's `canEncodeAudio("aac", ...)`: true only once an encoder is registered. */
	canEncodeAac: (params: AacEncoderParams) => Promise<boolean>;
	/**
	 * A real encode; rejects if the worker, wasm or encoder fails. It should give
	 * up when `signal` aborts. The default cancels its Output, but mediabunny 1.41.0
	 * queues `close()` behind an `encode()` call that is stuck, so a stuck trial can
	 * still leave its encoder worker behind.
	 */
	trialEncode: (args: { params: AacEncoderParams; signal: AbortSignal }) => Promise<void>;
	trialTimeoutMs: number;
	/** Starts a timer and returns its canceller (replaced by a fake in tests). */
	startTimeout: (args: { ms: number; onTimeout: () => void }) => () => void;
}

const TRIAL_SECONDS = 1;
const TRIAL_TIMEOUT_MS = 20_000;

/**
 * Encodes one second of silence to AAC in an MP4 in memory, then reads the file
 * back and checks that it holds an AAC track of about one second. This runs the
 * very path an export takes (worker, wasm, packets, muxer), so a worker that a
 * CSP blocks, a wasm that fails to start, or an encoder that emits nothing show
 * up here, in one second, and not halfway through a long export.
 */
export async function runAacTrialEncode({
	params,
	signal,
	verifyOutput = assertAacMp4,
}: {
	params: AacEncoderParams;
	signal: AbortSignal;
	verifyOutput?: typeof assertAacMp4;
}): Promise<void> {
	const { sampleRate, numberOfChannels, bitrate } = params;
	const target = new BufferTarget();
	const output = new Output({ format: new Mp4OutputFormat(), target });
	const source = new AudioSampleSource({ codec: "aac", bitrate });
	output.addAudioTrack(source);

	let finalizing = false;
	const releaseEncoder = () => {
		if (!finalizing) {
			// Stops the encoder worker. The error that got us here is what is reported;
			// a cancel that fails is only warned about.
			void cancelOutputQuietly({ output });
		}
	};
	signal.addEventListener("abort", releaseEncoder, { once: true });
	try {
		await output.start();
		const silence = new AudioSample({
			data: new Float32Array(sampleRate * TRIAL_SECONDS * numberOfChannels),
			format: "f32",
			numberOfChannels,
			sampleRate,
			timestamp: 0,
		});
		try {
			await source.add(silence);
		} finally {
			silence.close();
		}
		source.close();
		finalizing = true;
		await output.finalize();
	} catch (error) {
		releaseEncoder();
		throw error;
	} finally {
		signal.removeEventListener("abort", releaseEncoder);
	}

	await verifyOutput({ buffer: target.buffer, minimumSeconds: TRIAL_SECONDS * 0.9 });
}

/** Throws unless `buffer` is an MP4 holding an AAC track of at least `minimumSeconds`. */
export async function assertAacMp4({
	buffer,
	minimumSeconds,
}: {
	buffer: ArrayBuffer | null;
	minimumSeconds: number;
}): Promise<void> {
	if (!buffer || buffer.byteLength === 0) {
		throw new Error("the trial encode wrote no file");
	}
	const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track || track.codec !== "aac") {
			throw new Error(`the trial encode produced ${track?.codec ?? "no audio track"}, not AAC`);
		}
		const seconds = await track.computeDuration();
		if (!(seconds >= minimumSeconds)) {
			throw new Error(`the trial encode produced ${seconds} s of audio, expected about ${TRIAL_SECONDS} s`);
		}
	} finally {
		input.dispose();
	}
}

const defaultDeps: AacEncoderDeps = {
	loadEncoderModule: () => import("@mediabunny/aac-encoder"),
	canEncodeAac: (params) => canEncodeAudio("aac", params),
	trialEncode: runAacTrialEncode,
	trialTimeoutMs: TRIAL_TIMEOUT_MS,
	startTimeout: ({ ms, onTimeout }) => {
		const handle = setTimeout(onTimeout, ms);
		return () => clearTimeout(handle);
	},
};

/**
 * Runs `run` at most once successfully. Concurrent callers share the one
 * attempt; if it fails the cache is cleared first, so the next call tries
 * again instead of replaying the failure (or a rejected promise) forever.
 */
function createRetryableOnce<Args>({
	run,
}: {
	run: (args: Args) => Promise<void>;
}): (args: Args) => Promise<void> {
	let cached: Promise<void> | null = null;
	return (args) => {
		if (!cached) {
			const attempt: Promise<void> = run(args).catch((error: unknown) => {
				if (cached === attempt) cached = null;
				throw error;
			});
			cached = attempt;
		}
		return cached;
	};
}

async function atStage<T>({
	stage,
	run,
}: {
	stage: string;
	run: () => Promise<T> | T;
}): Promise<T> {
	try {
		return await run();
	} catch (cause) {
		throw cause instanceof ExportError ? cause : createAacUnavailableError({ stage, cause });
	}
}

/**
 * Makes mediabunny able to encode AAC, or throws `ExportError`
 * `AAC_UNAVAILABLE`. The steps:
 *
 * 1. Load `@mediabunny/aac-encoder` (dynamic import) and register it once.
 *    mediabunny prefers a registered encoder over a native one, so this is
 *    also what makes the wasm encoder the one in use.
 * 2. `canEncodeAudio("aac", params)` must be true AFTER registration, for the
 *    caller's own sample rate, channels and bitrate (checked on every call).
 * 3. One real trial encode of about a second, once (see `runAacTrialEncode`),
 *    bounded by a timeout so a worker that never answers cannot hang an export.
 *
 * A failed step is not cached: the next call repeats it. The registration is
 * kept, so a retry never registers twice.
 */
export function createAacEncoderGate({
	deps: overrides = {},
}: {
	deps?: Partial<AacEncoderDeps>;
} = {}): { ensure: (params: AacEncoderParams) => Promise<void> } {
	const deps: AacEncoderDeps = { ...defaultDeps, ...overrides };

	const register = createRetryableOnce<void>({
		run: async () => {
			const encoderModule = await atStage({
				stage: "loading the encoder",
				run: () => deps.loadEncoderModule(),
			});
			await atStage({
				stage: "registering the encoder",
				run: () => encoderModule.registerAacEncoder(),
			});
		},
	});

	const trial = createRetryableOnce<AacEncoderParams>({
		run: (params) =>
			atStage({ stage: "trial encode", run: () => runTrialWithTimeout({ deps, params }) }),
	});

	return {
		async ensure(params) {
			await register();
			const supported = await atStage({
				stage: "checking AAC support",
				run: () => deps.canEncodeAac(params),
			});
			if (!supported) {
				throw createAacUnavailableError({
					stage: `no AAC encoder for ${params.sampleRate} Hz, ${params.numberOfChannels} channel(s), ${params.bitrate} bit/s after registration`,
				});
			}
			await trial(params);
		},
	};
}

async function runTrialWithTimeout({
	deps,
	params,
}: {
	deps: AacEncoderDeps;
	params: AacEncoderParams;
}): Promise<void> {
	const controller = new AbortController();
	let cancelTimer: () => void = () => {};
	const timedOut = new Promise<never>((_, reject) => {
		cancelTimer = deps.startTimeout({
			ms: deps.trialTimeoutMs,
			onTimeout: () => {
				controller.abort();
				reject(new Error(`did not answer within ${deps.trialTimeoutMs} ms`));
			},
		});
	});
	try {
		await Promise.race([deps.trialEncode({ params, signal: controller.signal }), timedOut]);
	} finally {
		cancelTimer();
	}
}

const defaultGate = createAacEncoderGate();

/** The app's gate: see `createAacEncoderGate`. */
export function ensureAacEncoder(params: AacEncoderParams): Promise<void> {
	return defaultGate.ensure(params);
}
