import { PRESSURE_AVAILABLE_BYTES } from "../memory-budget";
import { type MemorySource, type RenderLease, type StreamLimits, VideoCache } from "../service";
import {
	type DecoderModelParams,
	type SimCanvas,
	createDecodeLanes,
	createDecoderStats,
	createModelSource,
} from "./decoder-model";
import { VirtualClock } from "./virtual-clock";

/**
 * Playback of a timeline with several video layers on a virtual clock: which
 * frame every layer gets, how often decoders restart, how long draws wait.
 *
 * A draw asks for the frame of every visible layer synchronously, in scene
 * order, then awaits them all (as `resolve.ts` does: blur backdrops first,
 * then the main track, then the overlay tracks). Every timing is an
 * ASSUMPTION of the scenario; nothing here is measured.
 */
export type SimLayer = {
	/** Timeline element id of the clip; a blur backdrop carries its clip's id. */
	elementId: string;
	mediaId: string;
	role: "video" | "backdrop";
	/** Timeline second where the clip starts, and its length. */
	start: number;
	duration: number;
	/** Source second shown at the clip's start. */
	sourceStart: number;
};

export type TimelineScenario = {
	name: string;
	seconds: number;
	projectFps: number;
	videoFps: number;
	keyframeSeconds: number;
	decodeMs: number;
	startupMs: number;
	/** GPU part of every draw, after its frames are resolved. */
	renderMs: number;
	maxStaleSeconds: number;
	/** Decoders that may decode at the same time (1: one hardware engine); undefined: no limit. */
	decodeLanes?: number;
	/**
	 * "parallel" (default, what `resolve.ts` does): every layer is asked before
	 * the first await. "sequential": a layer is asked only after the previous
	 * one answered (no request overtakes another).
	 */
	requestOrder?: "parallel" | "sequential";
	/**
	 * GPU ms of the texture upload of a layer whose frame changed since the
	 * previous draw (the compositor skips an unchanged canvas and timestamp).
	 * Undefined: uploads are part of `renderMs`.
	 */
	uploadMs?: { video: number; backdrop: number };
	layers: SimLayer[];
};

export type TimelineVariant = {
	label: string;
	/** Pass the clip's element id with every request (the stream key). */
	keyed: boolean;
	/** Stream limits of the cache (`{ maxPerMedia: 1 }`: one decoder per media, as before). */
	streams?: Partial<StreamLimits>;
	/**
	 * The size every frame is asked for, as a share of the video's display size
	 * (default 1; a small preview while it plays asks for less, e.g. 0.25).
	 */
	scale?: number;
	/**
	 * One memory reading under pressure before playback: the budget plays at
	 * its floor and the read-ahead at its minimum.
	 */
	pressure?: boolean;
	/**
	 * Memory readings of the owner's machine (15.3 GB, 6 GB available) before
	 * playback, until the budget stops growing: 3 GB in balanced mode.
	 */
	roomy?: boolean;
	/** Decode engines shared by every decoder; overrides the scenario's `decodeLanes`. */
	decodeLanes?: number;
};

export type TimelineResult = {
	variant: string;
	/** Draws whose answers all settled (scored), and draws started. */
	draws: number;
	drawsStarted: number;
	/** A draw was waiting for its answers when the timeline ended (finished after it, then scored). */
	drawsInFlightAtEnd: number;
	/**
	 * Draws whose answers never settled, not even DRAIN_MS after the end: each
	 * of their layers counts as an answer and as wrong. Nothing draws after a
	 * draw that never settles, as in the renderer.
	 */
	drawsOpen: number;
	fps: number;
	/** Decoder starts (the first ones included) and starts per second of playback. */
	restarts: number;
	restartsPerSecond: number;
	/** Time draws waited for their frames: total, p95, max. */
	waitTotalMs: number;
	waitP95Ms: number;
	waitMaxMs: number;
	/** Frames decoded (also the ones a restart decodes to reach its start). */
	decoded: number;
	/** Frames drawn into canvases. */
	canvasDraws: number;
	/** (hits + read-ahead hits + kept-frame hits) / (stream requests + kept-frame hits), cache counters. */
	hitRate: number;
	/** Layer answers in total and the ones that did not show the layer's own frame. */
	layerAnswers: number;
	wrongFrames: number;
	/**
	 * Answers whose canvas did not hold the layer's own frame when the draw's
	 * answers had all settled (drawn over meanwhile, or another clip's frame).
	 */
	canvasMismatch: number;
	/**
	 * The most memory held by the simulator's own model (`DecoderStats`):
	 * decoded frames in the decoders' queues and handed out but not closed,
	 * plus every canvas created and not destroyed at drawn bytes x scale^2.
	 * Exact (updated on every change). The memory gate uses this figure.
	 */
	peakHeldBytes: number;
	/** The most the cache said it held (`usedBytes`), sampled after every event (for comparison). */
	peakUsedBytes: number;
	/** The smallest memory budget sampled (constant unless a frame could not be drawn). */
	budgetBytes: number;
	/** The most streams (decoder slots) open at once, sampled after every event. */
	streamsMax: number;
	/** The most decoders running at once (the model's count, exact). */
	decodersMax: number;
	/** Canvases created, and frames drawn into a destroyed canvas (the model's counts). */
	canvasesCreated: number;
	drawsIntoDestroyed: number;
	/** `close` called twice on one decoded frame (the model's count). */
	doubleClosed: number;
	/** Draws in which two layers of one clip (backdrop and video) showed different frames. */
	mismatched: number;
	/** Requested source time minus start of the shown frame, correct answers only (ms). */
	lagMaxMs: number;
};

/** What the cache answered for one layer. */
export type SimAnswer = { canvas: SimCanvas; timestamp: number; duration: number } | null;

/** A layer asked for in a draw, and the source second it shows there. */
export type VisibleLayer = { layer: SimLayer; sourceTime: number };

const VSYNC_MS = 1000 / 60;
const MAX_EVENTS = 3_000_000;
/**
 * After the end, a draw still waiting for its answers gets this much more
 * virtual time to finish (no new draw starts); one that does not is open.
 */
const DRAIN_MS = 10_000;
const GiB = 1024 ** 3;

/** The owner's machine with his other apps open: the budget grows to the 3 GB of the balanced mode. */
const ROOMY_MEMORY: MemorySource = {
	readMemory: async () => ({
		totalBytes: 15.3 * GiB,
		availableBytes: 6 * GiB,
		swapTotalBytes: 8 * GiB,
		swapFreeBytes: 8 * GiB,
		appBytes: 1.2 * GiB,
	}),
	mode: () => "balanced",
	deviceMemoryGiB: () => null,
};

/** Ticks that take the budget from the 256 MB start to the ceiling (128 MB a tick). */
const ROOMY_TICKS = 26;

/** A reading of a 4 GB machine with half the pressure threshold available. */
const PRESSURE_MEMORY: MemorySource = {
	readMemory: async () => ({
		totalBytes: 4 * GiB,
		availableBytes: PRESSURE_AVAILABLE_BYTES / 2,
		swapTotalBytes: 0,
		swapFreeBytes: 0,
		appBytes: 1 * GiB,
	}),
	mode: () => "balanced",
	deviceMemoryGiB: () => null,
};

function percentile({ values, q }: { values: number[]; q: number }): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function sourceTimeOf({ layer, time }: { layer: SimLayer; time: number }): number | null {
	const clipTime = time - layer.start;
	if (clipTime < 0 || clipTime >= layer.duration) return null;
	return layer.sourceStart + clipTime;
}

/** Whether `answer` is the frame to show at `sourceTime`, a stale frame within the tolerance included. */
function showsRequestedFrame({
	answer,
	sourceTime,
	maxStaleSeconds,
}: {
	answer: { timestamp: number; duration: number } | null;
	sourceTime: number;
	maxStaleSeconds: number;
}): boolean {
	if (!answer) return false;
	if (answer.timestamp > sourceTime + 1e-9) return false;
	return sourceTime < answer.timestamp + answer.duration + maxStaleSeconds + 1e-9;
}

export type DrawScore = {
	/** Answers that did not show the layer's own frame, by their timestamp (a missing one included). */
	wrong: number;
	/** Answers whose canvas does not hold the layer's own frame now (never drawn included). */
	canvasMismatch: number;
	/** Two layers of one clip (its backdrop and its video) showed different frames. */
	backdropMismatch: boolean;
	/** Requested source time minus the start of the shown frame, right answers only (ms). */
	lagMaxMs: number;
};

/**
 * Judges the answers of one draw (`answers[i]` for `visible[i]`), called when
 * they have all settled. The timestamp says which frame the cache meant to
 * hand out; the canvas (`SimCanvas.frame`, the frame index drawn into it last)
 * says what the renderer would upload. A stale frame within `maxStaleSeconds`
 * counts as right on both counts.
 */
export function scoreDraw({
	visible,
	answers,
	videoFps,
	maxStaleSeconds,
}: {
	visible: VisibleLayer[];
	answers: SimAnswer[];
	videoFps: number;
	maxStaleSeconds: number;
}): DrawScore {
	let wrong = 0;
	let canvasMismatch = 0;
	let lagMaxMs = 0;
	let backdropMismatch = false;
	const shownByElement = new Map<string, number | null>();
	for (let index = 0; index < visible.length; index++) {
		const { layer, sourceTime } = visible[index];
		const answer = answers[index] ?? null;
		if (showsRequestedFrame({ answer, sourceTime, maxStaleSeconds })) {
			lagMaxMs = Math.max(lagMaxMs, (sourceTime - (answer?.timestamp ?? 0)) * 1000);
		} else {
			wrong += 1;
		}
		if (answer) {
			const drawn = answer.canvas.destroyed ? -1 : answer.canvas.frame;
			const content =
				drawn >= 0 ? { timestamp: drawn / videoFps, duration: 1 / videoFps } : null;
			if (!showsRequestedFrame({ answer: content, sourceTime, maxStaleSeconds })) {
				canvasMismatch += 1;
			}
		}
		const shown = answer ? answer.timestamp : null;
		const previous = shownByElement.get(layer.elementId);
		if (previous !== undefined && previous !== shown) backdropMismatch = true;
		shownByElement.set(layer.elementId, shown);
	}
	return { wrong, canvasMismatch, backdropMismatch, lagMaxMs };
}

/** Replaces the answer of a layer (tests: a cache that never answers some layers). */
export type AnswerIntercept = ({
	layer,
	answer,
}: {
	layer: SimLayer;
	answer: Promise<SimAnswer>;
}) => Promise<SimAnswer>;

export async function runTimelineScenario({
	scenario,
	variant,
	intercept,
	afterAnswers,
}: {
	scenario: TimelineScenario;
	variant: TimelineVariant;
	intercept?: AnswerIntercept;
	/** Called with a draw's answers right after they were judged (tests: a canvas drawn over before the upload). */
	afterAnswers?: (answers: SimAnswer[]) => void;
}): Promise<TimelineResult> {
	const clock = new VirtualClock();
	const stats = createDecoderStats();
	const laneCount = variant.decodeLanes ?? scenario.decodeLanes;
	const lanes = laneCount === undefined ? null : createDecodeLanes({ count: laneCount });
	const maxSourceEnd = Math.max(
		...scenario.layers.map((layer) => layer.sourceStart + layer.duration),
	);
	const params: DecoderModelParams = {
		fps: scenario.videoFps,
		frameCount: Math.ceil((maxSourceEnd + 5) * scenario.videoFps),
		keyframeInterval: Math.max(1, Math.round(scenario.keyframeSeconds * scenario.videoFps)),
		decodeMs: scenario.decodeMs,
		startupMs: scenario.startupMs,
		maxQueued: 8,
	};
	const files = new Map<string, File>();
	for (const layer of scenario.layers) {
		if (!files.has(layer.mediaId)) files.set(layer.mediaId, new File([], layer.mediaId));
	}
	const cache = new VideoCache<SimCanvas>({
		// Every media is its own file with the same timings.
		openSource: async () => createModelSource({ clock, params, stats, lanes }),
		now: () => clock.now,
		streams: variant.streams,
		...(variant.pressure && { memory: PRESSURE_MEMORY }),
		...(variant.roomy && { memory: ROOMY_MEMORY }),
	});
	if (variant.pressure) await cache.tickMemory();
	if (variant.roomy) {
		for (let tick = 0; tick < ROOMY_TICKS; tick++) await cache.tickMemory();
	}

	const request = ({ layer, sourceTime, lease }: VisibleLayer & { lease: RenderLease }): Promise<SimAnswer> => {
		const file = files.get(layer.mediaId) ?? new File([], layer.mediaId);
		const answer = cache.getFrameAt({
			mediaId: layer.mediaId,
			file,
			time: sourceTime,
			lease,
			...(variant.keyed && { streamKey: layer.elementId }),
			...(variant.scale !== undefined && { scale: variant.scale }),
		});
		return intercept ? intercept({ layer, answer }) : answer;
	};

	const endMs = scenario.seconds * 1000;
	const playStartMs = VSYNC_MS;
	const waits: number[] = [];
	let draws = 0;
	let drawsStarted = 0;
	/** The draw running (waiting for its answers, or its GPU part), if any. */
	const running: {
		draw: { visible: VisibleLayer[]; startMs: number; scored: boolean } | null;
	} = { draw: null };
	let layerAnswers = 0;
	let wrongFrames = 0;
	let canvasMismatch = 0;
	let mismatched = 0;
	let lagMaxMs = 0;
	let peakUsedBytes = 0;
	let budgetBytes = Number.POSITIVE_INFINITY;
	let streamsMax = 0;
	const sample = () => {
		const memory = cache.getMemoryStats();
		peakUsedBytes = Math.max(peakUsedBytes, memory.usedBytes);
		budgetBytes = Math.min(budgetBytes, memory.budgetBytes);
		streamsMax = Math.max(streamsMax, memory.streams);
	};
	sample();
	let rendering = false;
	let lastFrame = -1;
	/** Canvas and timestamp each layer uploaded last (the compositor's skip rule). */
	const uploaded = new Map<SimLayer, { canvas: SimCanvas; timestamp: number }>();

	const askAll = async ({
		visible,
		lease,
	}: {
		visible: VisibleLayer[];
		lease: RenderLease;
	}): Promise<SimAnswer[]> => {
		const withTolerance = (run: () => Promise<SimAnswer[]>) =>
			cache.withPlaybackTolerance({ maxStaleSeconds: scenario.maxStaleSeconds, run });
		if (scenario.requestOrder !== "sequential") {
			return withTolerance(() => Promise.all(visible.map((entry) => request({ ...entry, lease }))));
		}
		const answers: SimAnswer[] = [];
		for (const entry of visible) {
			const [answer] = await withTolerance(() => Promise.all([request({ ...entry, lease })]));
			answers.push(answer);
		}
		return answers;
	};

	const uploadCostMs = ({ layer, answer }: { layer: SimLayer; answer: SimAnswer }): number => {
		if (!scenario.uploadMs || !answer) return 0;
		const previous = uploaded.get(layer);
		if (previous && previous.canvas === answer.canvas && previous.timestamp === answer.timestamp) {
			return 0;
		}
		uploaded.set(layer, { canvas: answer.canvas, timestamp: answer.timestamp });
		return layer.role === "backdrop" ? scenario.uploadMs.backdrop : scenario.uploadMs.video;
	};

	const draw = async (time: number) => {
		const startMs = clock.now;
		const visible = scenario.layers.flatMap((layer) => {
			const sourceTime = sourceTimeOf({ layer, time });
			return sourceTime === null ? [] : [{ layer, sourceTime }];
		});
		drawsStarted += 1;
		const current = { visible, startMs, scored: false };
		running.draw = current;
		// As the renderer: the draw's frames are held until its GPU part (the uploads) is over.
		const lease = cache.beginRender();
		const answers = await askAll({ visible, lease });
		current.scored = true;
		waits.push(clock.now - startMs);
		// Judged now, before the GPU part: what the renderer would upload.
		const score = scoreDraw({
			visible,
			answers,
			videoFps: scenario.videoFps,
			maxStaleSeconds: scenario.maxStaleSeconds,
		});
		layerAnswers += visible.length;
		wrongFrames += score.wrong;
		canvasMismatch += score.canvasMismatch;
		lagMaxMs = Math.max(lagMaxMs, score.lagMaxMs);
		if (score.backdropMismatch) mismatched += 1;
		const heldAtSettle = answers.map((answer) => (answer ? answer.canvas.frame : null));
		afterAnswers?.(answers);
		let gpuMs = scenario.renderMs;
		for (let index = 0; index < visible.length; index++) {
			gpuMs += uploadCostMs({ layer: visible[index].layer, answer: answers[index] });
		}
		await clock.sleep(gpuMs);
		// The uploads happened during the GPU part: a canvas drawn over before its
		// end showed another picture than the one judged at settle.
		for (let index = 0; index < answers.length; index++) {
			const answer = answers[index];
			if (answer && (answer.canvas.destroyed || answer.canvas.frame !== heldAtSettle[index])) {
				canvasMismatch += 1;
			}
		}
		cache.endRender({ lease });
		draws += 1;
		running.draw = null;
		rendering = false;
	};

	const onTick = () => {
		if (rendering) return;
		const frame = Math.floor(((clock.now - playStartMs) / 1000) * scenario.projectFps + 1e-6);
		if (frame === lastFrame) return;
		lastFrame = frame;
		rendering = true;
		void draw(frame / scenario.projectFps);
	};

	for (let tick = 1; tick * VSYNC_MS <= endMs; tick++) {
		clock.at({ time: tick * VSYNC_MS, run: onTick });
	}
	await clock.runUntil({ time: endMs, maxEvents: MAX_EVENTS, observe: sample });
	const drawsInFlightAtEnd = running.draw ? 1 : 0;
	if (running.draw) {
		await clock.runUntil({ time: endMs + DRAIN_MS, maxEvents: MAX_EVENTS, observe: sample });
	}
	// Answers that never settled: every layer of that draw is a wrong answer.
	const unsettled = running.draw && !running.draw.scored ? running.draw : null;
	if (unsettled) {
		layerAnswers += unsettled.visible.length;
		wrongFrames += unsettled.visible.length;
		waits.push(clock.now - unsettled.startMs);
	}
	cache.clearAll();

	const counters = cache.getCounters();
	const playedSeconds = (endMs - playStartMs) / 1000;
	return {
		variant: variant.label,
		draws,
		drawsStarted,
		drawsInFlightAtEnd,
		drawsOpen: unsettled ? 1 : 0,
		fps: draws / playedSeconds,
		restarts: counters.restarts,
		restartsPerSecond: counters.restarts / playedSeconds,
		waitTotalMs: waits.reduce((sum, value) => sum + value, 0),
		waitP95Ms: percentile({ values: waits, q: 0.95 }),
		waitMaxMs: waits.length > 0 ? Math.max(...waits) : 0,
		decoded: stats.decoded,
		canvasDraws: stats.draws,
		hitRate:
			counters.requests + counters.lruHits > 0
				? (counters.hits + counters.readAheadHits + counters.lruHits) /
					(counters.requests + counters.lruHits)
				: 0,
		layerAnswers,
		wrongFrames,
		canvasMismatch,
		peakHeldBytes: stats.peakHeldBytes,
		peakUsedBytes,
		budgetBytes,
		streamsMax,
		decodersMax: stats.peakLiveRuns,
		canvasesCreated: stats.canvasesCreated,
		drawsIntoDestroyed: stats.drawsIntoDestroyed,
		doubleClosed: stats.doubleClosed,
		mismatched,
		lagMaxMs,
	};
}

/**
 * What breaks "every clip shows its own frame" in a run, one line per kind:
 * a draw that never finished, wrong answers, canvas mismatches, answers that
 * are not `layersPerDraw` per finished draw (when every layer is visible in
 * every draw), no draw at all.
 */
export function ownFrameViolations({
	result,
	layersPerDraw,
}: {
	result: TimelineResult;
	layersPerDraw?: number;
}): string[] {
	const violations: string[] = [];
	if (result.drawsOpen > 0 || result.draws !== result.drawsStarted - result.drawsOpen) {
		violations.push(`${result.drawsOpen} draw${result.drawsOpen === 1 ? "" : "s"} never finished`);
	}
	if (result.wrongFrames > 0) violations.push(`${result.wrongFrames} wrong`);
	if (result.canvasMismatch > 0) violations.push(`${result.canvasMismatch} canvas mismatches`);
	if (layersPerDraw !== undefined && result.layerAnswers !== result.draws * layersPerDraw) {
		violations.push(`${result.layerAnswers} answers for ${result.draws} draws`);
	}
	if (!(result.fps > 0)) violations.push("no draw");
	return violations;
}

/** Over the budget by the simulator's own memory model (not the cache's own count). */
export function memoryViolations({ result }: { result: TimelineResult }): string[] {
	return result.peakHeldBytes > result.budgetBytes
		? [`model peak ${result.peakHeldBytes} B over the budget ${result.budgetBytes} B`]
		: [];
}

export const TIMELINE_RESULT_HEADER =
	"scenario | variant | draws | fps | decoder starts (per s) | frame wait ms total / p95 / max | frames decoded | canvas draws | stream hit rate | wrong frames / layer answers | canvas mismatch | open draws | backdrop != video | lag max ms | model peak / cache peak / budget MB | streams / decoders max";

const MiB = 1024 ** 2;

function megabytes(bytes: number): string {
	return (bytes / MiB).toFixed(0);
}

export function formatTimelineRow({
	scenario,
	result,
}: {
	scenario: TimelineScenario;
	result: TimelineResult;
}): string {
	return [
		scenario.name,
		result.variant,
		result.draws,
		result.fps.toFixed(1),
		`${result.restarts} (${result.restartsPerSecond.toFixed(2)})`,
		`${result.waitTotalMs.toFixed(0)} / ${result.waitP95Ms.toFixed(0)} / ${result.waitMaxMs.toFixed(0)}`,
		result.decoded,
		result.canvasDraws,
		`${(result.hitRate * 100).toFixed(1)} %`,
		`${result.wrongFrames} / ${result.layerAnswers}`,
		result.canvasMismatch,
		result.drawsOpen,
		result.mismatched,
		result.lagMaxMs.toFixed(0),
		`${megabytes(result.peakHeldBytes)} / ${megabytes(result.peakUsedBytes)} / ${megabytes(result.budgetBytes)}`,
		`${result.streamsMax} / ${result.decodersMax}`,
	].join(" | ");
}

export const SAME_FILE_RESULT_HEADER =
	"shape | clips | variant | wrong / answers | canvas mismatch | open draws | decoder starts (per s) | fps | frame wait ms p95 / max | model peak / cache peak / budget MB | streams / decoders max";

/** One row of the N-clips-of-one-file sweep. */
export function formatSameFileRow({
	shape,
	clips,
	result,
}: {
	shape: string;
	clips: number;
	result: TimelineResult;
}): string {
	return [
		shape,
		clips,
		result.variant,
		`${result.wrongFrames} / ${result.layerAnswers}`,
		result.canvasMismatch,
		result.drawsOpen,
		`${result.restarts} (${result.restartsPerSecond.toFixed(2)})`,
		result.fps.toFixed(1),
		`${result.waitP95Ms.toFixed(0)} / ${result.waitMaxMs.toFixed(0)}`,
		`${megabytes(result.peakHeldBytes)} / ${megabytes(result.peakUsedBytes)} / ${megabytes(result.budgetBytes)}`,
		`${result.streamsMax} / ${result.decodersMax}`,
	].join(" | ");
}
