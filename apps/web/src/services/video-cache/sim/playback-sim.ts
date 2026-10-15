import { VideoCache } from "../service";
import {
	type DecoderModelParams,
	type SimCanvas,
	createDecoderStats,
	createModelCanvasSink,
	createModelSource,
} from "./decoder-model";
import { LegacyVideoCache } from "./legacy-cache";
import { VirtualClock } from "./virtual-clock";

/**
 * Before/after simulation of the frame cache during preview playback of the
 * owner's case: one video drawn twice per frame (blur backdrop + video, same
 * media, resolved in parallel), a preview loop on a 60 Hz display that skips
 * ticks while a draw is in flight, a wall-clock playhead, and a GPU part of the
 * draw that sometimes takes much longer. Every timing is an ASSUMPTION given in
 * the scenario, nothing here is measured on the owner's machine.
 */
export type PlaybackScenario = {
	name: string;
	seconds: number;
	projectFps: number;
	videoFps: number;
	keyframeSeconds: number;
	/** Decoder thread time per frame (software H.264 1080p: a few ms). */
	decodeMs: number;
	/** A new decoder's delay before its first frame. */
	startupMs: number;
	/** GPU part of every draw (blur, uploads), after the frames are resolved. */
	renderMs: number;
	/** Every that many seconds one draw takes `slowExtraMs` longer (GC, driver). */
	slowEverySeconds: number;
	slowExtraMs: number;
	/** The new cache's playback tolerance (preview: PLAYBACK_MAX_STALE_SECONDS). */
	maxStaleSeconds: number;
	/**
	 * GPU time of drawing one decoded 1080p frame into a canvas (YUV to RGB),
	 * paid by the next draw. 0 leaves GPU costs out of the model.
	 */
	canvasDrawGpuMs: number;
	/**
	 * GPU time of the old upload path's extra copy of every new video frame into
	 * a new OffscreenCanvas (the new cache hands out OffscreenCanvases).
	 */
	uploadCopyGpuMs: number;
};

export type PlaybackResult = {
	cache: "before" | "after";
	draws: number;
	/** Draws per 5 s since Play. */
	fpsPerBucket: number[];
	/** New decoders started (the first one included). */
	restarts: number;
	/** Time draws waited for their video frames: total, p95, max. */
	waitTotalMs: number;
	waitP95Ms: number;
	waitMaxMs: number;
	/** Frames decoded (also the ones a restart decodes to reach its start). */
	decoded: number;
	/** Frames drawn into canvases. */
	canvasDraws: number;
	/** Draws whose backdrop showed another frame than the video. */
	mismatched: number;
	/** Layers whose canvas held another frame than the one requested, at upload. */
	overwritten: number;
	/** Playhead minus start of the shown frame: mean and max (ms). */
	lagMeanMs: number;
	lagMaxMs: number;
	/** New cache only: frames shown slightly late instead of waiting. */
	stale: number;
};

type ShownFrame = { canvas: SimCanvas; timestamp: number } | null;

const VSYNC_MS = 1000 / 60;
const MAX_EVENTS = 2_000_000;

function percentile({ values, q }: { values: number[]; q: number }): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export async function runPlaybackScenario({
	scenario,
	cache,
}: {
	scenario: PlaybackScenario;
	cache: "before" | "after";
}): Promise<PlaybackResult> {
	const clock = new VirtualClock();
	const stats = createDecoderStats();
	const params: DecoderModelParams = {
		fps: scenario.videoFps,
		frameCount: Math.ceil((scenario.seconds + 5) * scenario.videoFps),
		keyframeInterval: Math.max(1, Math.round(scenario.keyframeSeconds * scenario.videoFps)),
		decodeMs: scenario.decodeMs,
		startupMs: scenario.startupMs,
		maxQueued: 8,
	};

	let requestPair: (time: number) => Promise<[ShownFrame, ShownFrame]>;
	let restarts: () => number;
	let stale: () => number;
	if (cache === "before") {
		const legacy = new LegacyVideoCache();
		legacy.addMedia({
			mediaId: "clip",
			sink: createModelCanvasSink({ clock, params, stats }),
		});
		requestPair = (time) =>
			Promise.all([
				legacy.getFrameAt({ mediaId: "clip", time }),
				legacy.getFrameAt({ mediaId: "clip", time }),
			]);
		restarts = () => legacy.counters.seeks;
		stale = () => 0;
	} else {
		const file = new File([], "sim.mp4");
		const videoCache = new VideoCache<SimCanvas>({
			openSource: async () => createModelSource({ clock, params, stats }),
			now: () => clock.now,
		});
		requestPair = (time) =>
			videoCache.withPlaybackTolerance({
				maxStaleSeconds: scenario.maxStaleSeconds,
				run: () =>
					Promise.all([
						videoCache.getFrameAt({ mediaId: "clip", file, time }),
						videoCache.getFrameAt({ mediaId: "clip", file, time }),
					]),
			});
		restarts = () => videoCache.getCounters().restarts;
		stale = () => videoCache.getCounters().stalePresents;
	}

	const endMs = scenario.seconds * 1000;
	const playStartMs = VSYNC_MS;
	const records: Array<{ endMs: number; waitedMs: number; lagMs: number }> = [];
	let mismatched = 0;
	let overwritten = 0;
	let rendering = false;
	let lastFrame = -1;
	let nextSlowAt = scenario.slowEverySeconds * 1000;
	let drawsPaid = 0;
	let lastMainTimestamp = Number.NaN;

	const holdsRequestedFrame = (frame: ShownFrame) =>
		!frame || frame.canvas.frame === Math.round(frame.timestamp * scenario.videoFps);

	const draw = async (time: number) => {
		const startMs = clock.now;
		const [backdrop, main] = await requestPair(time);
		const waitedMs = clock.now - startMs;
		// The upload reads the canvases now.
		if (!holdsRequestedFrame(backdrop)) overwritten += 1;
		if (!holdsRequestedFrame(main)) overwritten += 1;
		if (backdrop?.timestamp !== main?.timestamp) mismatched += 1;
		const lagMs = main ? (time - main.timestamp) * 1000 : 0;
		let gpuMs = scenario.renderMs;
		// GPU work queued by canvas draws since the last draw, and the old
		// path's extra copy of a new video frame before its upload.
		gpuMs += (stats.draws - drawsPaid) * scenario.canvasDrawGpuMs;
		drawsPaid = stats.draws;
		if (cache === "before" && main && main.timestamp !== lastMainTimestamp) {
			gpuMs += scenario.uploadCopyGpuMs;
		}
		lastMainTimestamp = main ? main.timestamp : Number.NaN;
		if (clock.now >= nextSlowAt) {
			gpuMs += scenario.slowExtraMs;
			nextSlowAt += scenario.slowEverySeconds * 1000;
		}
		await clock.sleep(gpuMs);
		records.push({ endMs: clock.now, waitedMs, lagMs });
		rendering = false;
	};

	const onTick = () => {
		if (rendering) return;
		const frame = Math.floor(
			((clock.now - playStartMs) / 1000) * scenario.projectFps + 1e-6,
		);
		if (frame === lastFrame) return;
		lastFrame = frame;
		rendering = true;
		void draw(frame / scenario.projectFps);
	};

	for (let tick = 1; tick * VSYNC_MS <= endMs; tick++) {
		clock.at({ time: tick * VSYNC_MS, run: onTick });
	}
	await clock.runUntil({ time: endMs, maxEvents: MAX_EVENTS });

	const buckets = Math.ceil(scenario.seconds / 5);
	const fpsPerBucket = Array.from({ length: buckets }, (_, bucket) => {
		const from = playStartMs + bucket * 5000;
		const to = Math.min(endMs, from + 5000);
		const count = records.filter((record) => record.endMs >= from && record.endMs < to).length;
		return count / ((to - from) / 1000);
	});
	const waits = records.map((record) => record.waitedMs);
	const lags = records.map((record) => record.lagMs);
	return {
		cache,
		draws: records.length,
		fpsPerBucket,
		restarts: restarts(),
		waitTotalMs: waits.reduce((sum, value) => sum + value, 0),
		waitP95Ms: percentile({ values: waits, q: 0.95 }),
		waitMaxMs: waits.length > 0 ? Math.max(...waits) : 0,
		decoded: stats.decoded,
		canvasDraws: stats.draws,
		mismatched,
		overwritten,
		lagMeanMs: lags.length > 0 ? lags.reduce((sum, value) => sum + value, 0) / lags.length : 0,
		lagMaxMs: lags.length > 0 ? Math.max(...lags) : 0,
		stale: stale(),
	};
}

export function formatResultRow({
	scenario,
	result,
}: {
	scenario: PlaybackScenario;
	result: PlaybackResult;
}): string {
	return [
		scenario.name,
		result.cache,
		result.draws,
		result.fpsPerBucket.map((fps) => fps.toFixed(1)).join(" / "),
		result.restarts,
		`${result.waitTotalMs.toFixed(0)} / ${result.waitP95Ms.toFixed(0)} / ${result.waitMaxMs.toFixed(0)}`,
		result.decoded,
		result.canvasDraws,
		result.mismatched,
		result.overwritten,
		`${result.lagMeanMs.toFixed(0)} / ${result.lagMaxMs.toFixed(0)}`,
		result.stale,
	].join(" | ");
}

export const RESULT_HEADER =
	"scenario | cache | draws | fps per 5 s | decoder starts | frame wait ms total / p95 / max | frames decoded | canvas draws | backdrop != video | canvas overwritten | lag ms mean / max | stale shown";
