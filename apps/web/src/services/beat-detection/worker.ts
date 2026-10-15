import type { StemName } from "@/services/stems/types";
import {
	detectBeats,
	detectOnsets,
	type BeatDetectionResult,
	type HitBand,
	type OnsetDetectionResult,
} from "./detect";

/** "beats": one tempo and its beat grid. "hits": every hit, in any rhythm. */
export type BeatMode = "beats" | "hits";

export type BeatWorkerRequest = {
	samples: Float32Array;
	sampleRate: number;
	mode: BeatMode;
	/** Only for "hits": which part of the sound to listen to. */
	band?: HitBand;
	/** Only for "hits": the audio is this separated stem, not a full mix. */
	stem?: StemName;
};

export type BeatWorkerResponse =
	| { type: "progress"; fraction: number }
	| { type: "result"; result: BeatDetectionResult | OnsetDetectionResult };

self.onmessage = (event: MessageEvent<BeatWorkerRequest>) => {
	const { samples, sampleRate, mode, band, stem } = event.data;
	const onProgress = (fraction: number) =>
		self.postMessage({ type: "progress", fraction } satisfies BeatWorkerResponse);
	const result =
		mode === "hits"
			? detectOnsets({ samples, sampleRate, band, stem, onProgress })
			: detectBeats({ samples, sampleRate, onProgress });
	self.postMessage({ type: "result", result } satisfies BeatWorkerResponse);
};
