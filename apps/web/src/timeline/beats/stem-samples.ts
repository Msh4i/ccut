import { decodeElementForSeparation } from "@/media/stem-audio";
import { isAbortError } from "@/services/beat-detection/abort";
import type { StemsBridge } from "@/services/stems/bridge";
import type { StemCache } from "@/services/stems/cache";
import { separateStems } from "@/services/stems/separate";
import {
	STEM_MODEL_ID,
	STEM_SAMPLE_RATE,
	type StemInstallCode,
	type StemName,
} from "@/services/stems/types";
import type { BeatFailureReason } from "./run-summary";
import type { BeatTarget } from "./targets";

/** What the job shows while a source is being prepared (before the detectors run). */
export type StemStage =
	| { kind: "installing"; percent: number }
	/** The installed separator no longer matches this app (an update, a changed file): it is installed again. */
	| { kind: "repairing" }
	| { kind: "reading" }
	| { kind: "separating"; percent: number };

export type StemAudio =
	/** `offsetSeconds`: where in the source the samples start (only part of it may be separated). */
	| { ok: true; samples: Float32Array; sampleRate: number; offsetSeconds?: number }
	| { ok: false; reason: BeatFailureReason };

export type StemDeps = {
	bridge: StemsBridge | null;
	cache: StemCache | null;
	decode: typeof decodeElementForSeparation;
	separate: typeof separateStems;
	/** How often the install and the separation are polled (ms). */
	pollMs?: number;
};

const INSTALL_POLL_MS = 500;
// Separating takes ~0.7 s per second of audio after a ~13 s start (measured), so
// a 10 s clip of a 10 minute video is separated alone, with this much audio on
// each side so a hit right at a cut still has its attack.
const RANGE_PADDING_SECONDS = 2;

/** One cache entry per source file and model; null for a source with no stable identity. */
export function stemCacheKey({ target }: { target: BeatTarget }): string | null {
	const { element, mediaAsset } = target;
	if (element.type === "audio" && element.sourceType === "library") {
		return `${STEM_MODEL_ID}:library:${element.sourceUrl}`;
	}
	if (!mediaAsset) return null;
	return `${STEM_MODEL_ID}:${target.sourceKey}:${mediaAsset.file.size}:${mediaAsset.file.lastModified}`;
}

/** Stems are stored as 16-bit; the detectors read floats in [-1, 1). */
export function stemToFloat({ samples }: { samples: Int16Array }): Float32Array {
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
	return out;
}

const INSTALL_FAILURES: Record<StemInstallCode, BeatFailureReason> = {
	unsupported: "stems-unavailable",
	"pins-missing": "stems-pins-missing",
	"consent-declined": "stems-declined",
	busy: "stems-busy",
	"download-failed": "stems-install-failed",
	"verify-failed": "stems-install-failed",
	"install-failed": "stems-install-failed",
	"no-disk-space": "stems-no-disk-space",
	"bridge-failed": "stems-install-failed",
};

/** Makes sure the separator is installed (asking the user once, in the main process). */
async function ensureEngine({
	bridge,
	signal,
	onStage,
	pollMs,
}: {
	bridge: StemsBridge;
	signal: AbortSignal;
	onStage: (stage: StemStage) => void;
	pollMs: number;
}): Promise<{ ok: true } | { ok: false; reason: BeatFailureReason }> {
	const first = await bridge.status();
	if (!first || !first.supported) return { ok: false, reason: "stems-unavailable" };
	if (first.engine === "ready") return { ok: true };

	if (first.engine !== "installing") {
		// "missing" or "broken": the main process asks, downloads, verifies. A cancel that came
		// while the status was being read must not open the consent dialog afterwards.
		signal.throwIfAborted();
		if (first.engine === "broken") onStage({ kind: "repairing" });
		const installing = bridge.install();
		let finished = false;
		const abort = () => void bridge.cancelInstall();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		void installing.finally(() => {
			finished = true;
		});
		try {
			while (!finished) {
				const status = await bridge.status();
				if (status?.engine === "installing") {
					onStage({ kind: "installing", percent: status.installPercent ?? 0 });
				}
				await Promise.race([installing, delay({ ms: pollMs })]);
			}
			signal.throwIfAborted();
			const result = await installing;
			return result.ok ? { ok: true } : { ok: false, reason: INSTALL_FAILURES[result.code] };
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	// Someone else (another window of the app) is installing: wait for it.
	for (;;) {
		signal.throwIfAborted();
		await delay({ ms: pollMs });
		const status = await bridge.status();
		if (!status) return { ok: false, reason: "stems-install-failed" };
		if (status.engine === "ready") return { ok: true };
		if (status.engine !== "installing") return { ok: false, reason: "stems-install-failed" };
		onStage({ kind: "installing", percent: status.installPercent ?? 0 });
	}
}

const delay = ({ ms }: { ms: number }) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One stem of the clip's own audio, as floats at 22.05 kHz: from the cache when this media was
 * separated before, otherwise installed-if-needed, decoded, separated and cached. There is no
 * fallback to the mixed audio: a failure is a reason the page shows.
 */
export async function getStemAudio({
	target,
	stem,
	range,
	signal,
	onStage,
	deps,
}: {
	target: BeatTarget;
	stem: StemName;
	/** Source seconds the clips play; without it the whole source is separated. */
	range?: { startSeconds: number; endSeconds: number };
	signal: AbortSignal;
	onStage: (stage: StemStage) => void;
	deps: StemDeps;
}): Promise<StemAudio> {
	const { bridge, cache } = deps;
	const fullKey = stemCacheKey({ target });
	if (!fullKey) return { ok: false, reason: "unreadable" };
	const windowStart = range ? Math.max(0, Math.floor(range.startSeconds - RANGE_PADDING_SECONDS)) : 0;
	const windowEnd = range ? Math.ceil(range.endSeconds + RANGE_PADDING_SECONDS) : null;
	const windowKey = windowEnd === null ? null : `${fullKey}:range:${windowStart}-${windowEnd}`;

	if (cache) {
		// A whole-source stem from before still covers any range.
		for (const [key, offsetSeconds] of [[fullKey, 0], [windowKey, windowStart]] as const) {
			if (!key) continue;
			try {
				const hit = await cache.get({ key, stem });
				if (hit) {
					return { ok: true, samples: stemToFloat({ samples: hit }), sampleRate: STEM_SAMPLE_RATE, offsetSeconds };
				}
			} catch (error) {
				console.warn("Stem cache read failed:", error);
			}
		}
	}
	if (!bridge) return { ok: false, reason: "stems-unavailable" };
	const pollMs = deps.pollMs ?? INSTALL_POLL_MS;

	const engine = await ensureEngine({ bridge, signal, onStage, pollMs });
	if (!engine.ok) return engine;

	onStage({ kind: "reading" });
	const audio = await deps.decode({
		element: target.element,
		mediaAsset: target.mediaAsset,
		signal,
	});
	if (!audio.ok) {
		return { ok: false, reason: audio.reason === "too-long" ? "stems-too-long" : audio.reason };
	}

	// Only the clips' part (plus padding) goes to the separator, unless that is most of it.
	const firstFrame = Math.min(audio.frames, Math.round(windowStart * audio.sampleRate));
	const endFrame =
		windowEnd === null ? audio.frames : Math.min(audio.frames, Math.round(windowEnd * audio.sampleRate));
	const useWindow = windowKey !== null && endFrame - firstFrame < 0.9 * audio.frames;
	const key = useWindow && windowKey ? windowKey : fullKey;
	const offsetSeconds = useWindow ? firstFrame / audio.sampleRate : 0;
	const input = useWindow
		? {
				samples: audio.samples.subarray(firstFrame * 2, endFrame * 2),
				sampleRate: audio.sampleRate,
				frames: endFrame - firstFrame,
			}
		: { samples: audio.samples, sampleRate: audio.sampleRate, frames: audio.frames };

	const separated = await deps.separate({
		bridge,
		input,
		signal,
		pollMs,
		onProgress: (fraction) => onStage({ kind: "separating", percent: Math.floor(fraction * 100) }),
	});
	if (!separated.ok) {
		switch (separated.reason) {
			case "too-long":
				return { ok: false, reason: "stems-too-long" };
			case "busy":
				return { ok: false, reason: "stems-busy" };
			case "out-of-memory":
				return { ok: false, reason: "stems-out-of-memory" };
			case "engine-missing":
				return { ok: false, reason: "stems-install-failed" };
			default:
				return { ok: false, reason: "separation-failed" };
		}
	}

	if (cache) {
		try {
			await cache.put({ key, stems: separated.stems });
		} catch (error) {
			// A full disk or a storage that is gone must not throw the result away.
			if (isAbortError(error)) throw error;
			console.warn("Stem cache write failed:", error);
		}
	}
	return {
		ok: true,
		samples: stemToFloat({ samples: separated.stems[stem] }),
		sampleRate: STEM_SAMPLE_RATE,
		offsetSeconds,
	};
}
