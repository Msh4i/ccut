import type { StemName } from "@/services/stems/types";
import type {
	BeatDetectionResult,
	HitBand,
	OnsetDetectionResult,
} from "./detect";
import type { BeatMode, BeatWorkerRequest, BeatWorkerResponse } from "./worker";

/** 30 min of audio takes seconds; this only catches a worker that hangs. */
const DETECTION_TIMEOUT_MS = 5 * 60 * 1000;

type WorkerResult = BeatDetectionResult | OnsetDetectionResult;

type DetectArgs = {
	samples: Float32Array;
	sampleRate: number;
	onProgress?: (fraction: number) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
};

export const beatDetectionService = {
	/**
	 * Runs beat detection in a fresh worker. `samples` is transferred, so it is
	 * empty for the caller afterwards. Aborting `signal` terminates the worker
	 * and rejects with an `AbortError`; a worker that errors or runs past
	 * `timeoutMs` is terminated and rejects with an `Error`.
	 */
	detect(args: DetectArgs): Promise<BeatDetectionResult> {
		return runInWorker({ ...args, mode: "beats" }).then((result) => {
			if (!isBeatResult(result)) {
				throw new Error("Beat detection worker answered with hits");
			}
			return result;
		});
	},

	/**
	 * Same contract, but finds every hit in any rhythm: no tempo, no bpm. `band`
	 * picks the part of the sound to listen to (default: all of it).
	 */
	detectHits(
		args: DetectArgs & { band?: HitBand; stem?: StemName },
	): Promise<OnsetDetectionResult> {
		return runInWorker({ ...args, mode: "hits" });
	},
};

/** A grid has a tempo; a failure is the same for both modes. */
function isBeatResult(result: WorkerResult): result is BeatDetectionResult {
	return !result.ok || "bpm" in result;
}

function runInWorker({
	samples,
	sampleRate,
	mode,
	band,
	stem,
	onProgress,
	signal,
	timeoutMs = DETECTION_TIMEOUT_MS,
}: DetectArgs & {
	mode: BeatMode;
	band?: HitBand;
	stem?: StemName;
}): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});
		const settle = () => {
			clearTimeout(watchdog);
			signal?.removeEventListener("abort", handleAbort);
			worker.terminate();
		};
		const fail = (error: Error) => {
			settle();
			reject(error);
		};
		const handleAbort = () => fail(createAbortError());
		const watchdog = setTimeout(
			() => fail(new Error("Beat detection timed out")),
			timeoutMs,
		);

		signal?.addEventListener("abort", handleAbort, { once: true });
		worker.onmessage = (event: MessageEvent<BeatWorkerResponse>) => {
			if (event.data.type === "progress") {
				onProgress?.(event.data.fraction);
				return;
			}
			settle();
			resolve(event.data.result);
		};
		worker.onmessageerror = () =>
			fail(new Error("Beat detection worker sent an unreadable message"));
		worker.onerror = (event) =>
			fail(new Error(event.message || "Beat detection worker failed"));

		worker.postMessage(
			{ samples, sampleRate, mode, band, stem } satisfies BeatWorkerRequest,
			[samples.buffer],
		);
	});
}

function createAbortError(): DOMException {
	return new DOMException("Beat detection cancelled", "AbortError");
}
