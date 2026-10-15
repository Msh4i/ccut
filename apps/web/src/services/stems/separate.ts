import { abortable, isAbortError } from "@/services/beat-detection/abort";
import type { StemsBridge } from "./bridge";
import {
	STEM_CHUNK_BYTES,
	STEM_NAMES,
	type StemName,
	type StemSet,
} from "./types";

export type SeparationFailure =
	| "engine-missing"
	| "busy"
	| "too-long"
	| "separation-failed"
	| "out-of-memory"
	| "timeout";

export type SeparationResult =
	| { ok: true; stems: StemSet }
	| { ok: false; reason: SeparationFailure };

/** Interleaved stereo, 16-bit, at the clip's own rate. */
export type SeparationInput = {
	samples: Int16Array;
	sampleRate: number;
	frames: number;
};

const POLL_MS = 500;
// Where the 0..1 progress goes: sending the audio, the separation itself, reading the stems back.
const SEND_SHARE = 0.03;
const READ_SHARE = 0.03;

const delay = ({ ms, signal }: { ms: number; signal: AbortSignal }) =>
	abortable({ promise: new Promise<void>((resolve) => setTimeout(resolve, ms)), signal });

/**
 * Sends the audio to the main process, waits for the separator, reads the four stems back.
 * Aborting `signal` cancels the job and rejects with an `AbortError`. The job is always
 * released. Whatever the bridge answers that is not understood is "separation-failed".
 */
export async function separateStems({
	bridge,
	input,
	signal,
	onProgress,
	pollMs = POLL_MS,
}: {
	bridge: StemsBridge;
	input: SeparationInput;
	signal: AbortSignal;
	onProgress?: (fraction: number) => void;
	pollMs?: number;
}): Promise<SeparationResult> {
	signal.throwIfAborted();
	const begun = await bridge.begin({ frames: input.frames, sampleRate: input.sampleRate });
	if (!begun.ok) {
		switch (begun.code) {
			case "too-long":
			case "busy":
			case "engine-missing":
				return { ok: false, reason: begun.code };
			default:
				return { ok: false, reason: "separation-failed" };
		}
	}
	const { token } = begun;

	try {
		await send({ bridge, token, input, signal, onProgress });
		if (!(await bridge.run({ token }))) {
			return { ok: false, reason: "separation-failed" };
		}
		const samples = await waitForStems({ bridge, token, signal, onProgress, pollMs });
		if (typeof samples !== "number") return samples;
		const stems = await readStems({ bridge, token, samples, signal, onProgress });
		return { ok: true, stems };
	} catch (error) {
		if (isAbortError(error)) {
			await bridge.cancel({ token }).catch(() => false);
			throw error;
		}
		console.error("Stem separation failed:", error);
		return { ok: false, reason: "separation-failed" };
	} finally {
		await bridge.release({ token }).catch(() => false);
	}
}

async function send({
	bridge,
	token,
	input,
	signal,
	onProgress,
}: {
	bridge: StemsBridge;
	token: string;
	input: SeparationInput;
	signal: AbortSignal;
	onProgress?: (fraction: number) => void;
}): Promise<void> {
	const bytes = new Uint8Array(input.samples.buffer, input.samples.byteOffset, input.samples.byteLength);
	// A whole number of stereo frames per call.
	const chunk = STEM_CHUNK_BYTES - (STEM_CHUNK_BYTES % 4);
	for (let position = 0; position < bytes.byteLength; position += chunk) {
		signal.throwIfAborted();
		// A copy, not a view: the bridge sends a view's whole backing buffer, which must stay small.
		await bridge.write({ token, position, data: bytes.slice(position, position + chunk) });
		onProgress?.(SEND_SHARE * Math.min(1, (position + chunk) / bytes.byteLength));
	}
}

/** The length of each stem, or the failure. */
async function waitForStems({
	bridge,
	token,
	signal,
	onProgress,
	pollMs,
}: {
	bridge: StemsBridge;
	token: string;
	signal: AbortSignal;
	onProgress?: (fraction: number) => void;
	pollMs: number;
}): Promise<number | { ok: false; reason: SeparationFailure }> {
	for (;;) {
		signal.throwIfAborted();
		const status = await bridge.jobStatus({ token });
		switch (status.state) {
			case "done":
				return status.samples;
			case "failed":
				return {
					ok: false,
					reason:
						status.code === "timeout" || status.code === "out-of-memory" ? status.code : "separation-failed",
				};
			case "cancelled":
				return { ok: false, reason: "separation-failed" };
			default:
				onProgress?.(SEND_SHARE + (1 - SEND_SHARE - READ_SHARE) * (status.percent / 100));
		}
		await delay({ ms: pollMs, signal });
	}
}

async function readStems({
	bridge,
	token,
	samples,
	signal,
	onProgress,
}: {
	bridge: StemsBridge;
	token: string;
	samples: number;
	signal: AbortSignal;
	onProgress?: (fraction: number) => void;
}): Promise<StemSet> {
	const stems: Partial<Record<StemName, Int16Array>> = {};
	for (const [index, stem] of STEM_NAMES.entries()) {
		stems[stem] = await readStem({ bridge, token, stem, samples, signal });
		onProgress?.(1 - READ_SHARE + (READ_SHARE * (index + 1)) / STEM_NAMES.length);
	}
	const [drums, bass, vocals, other] = STEM_NAMES.map((name) => stems[name]);
	if (!drums || !bass || !vocals || !other) {
		throw new Error("a stem is missing after reading");
	}
	return { drums, bass, vocals, other };
}

async function readStem({
	bridge,
	token,
	stem,
	samples,
	signal,
}: {
	bridge: StemsBridge;
	token: string;
	stem: StemName;
	samples: number;
	signal: AbortSignal;
}): Promise<Int16Array> {
	const total = samples * Int16Array.BYTES_PER_ELEMENT;
	const bytes = new Uint8Array(total);
	let offset = 0;
	while (offset < total) {
		signal.throwIfAborted();
		const part = await bridge.read({
			token,
			stem,
			offset,
			length: Math.min(STEM_CHUNK_BYTES, total - offset),
		});
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return new Int16Array(bytes.buffer);
}
