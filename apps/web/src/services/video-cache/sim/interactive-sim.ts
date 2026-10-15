import { START_GATE_MAX_MS, waitForStartGate } from "@/core/playback-start";
import { shouldRenderPreview } from "@/preview/render-gate";
import { type MemorySource, type RenderLease, VideoCache } from "../service";
import {
	type DecoderModelParams,
	type SimCanvas,
	createDecoderStats,
	createModelSource,
} from "./decoder-model";
import type { SimAnswer, SimLayer } from "./timeline-sim";
import { VirtualClock } from "./virtual-clock";
import { planPreroll } from "../preroll-plan";

/**
 * Playback with the things the plain timeline simulation lacks: pause, play,
 * seek and a STALL (the main thread is blocked: no animation frame runs, and
 * the draw that is running takes `ms` longer to finish). The video cache is
 * the real `VideoCache` on a virtual clock; the decision to draw is the real
 * `shouldRenderPreview`. What is judged is the model of the SCREEN: per layer,
 * the answer of the last finished draw (null: that layer is black).
 */
export type InteractiveOp =
	| { at: number; op: "play" }
	| { at: number; op: "pause" }
	| { at: number; op: "seek"; time: number }
	| { at: number; op: "stall"; ms: number };

export type InteractiveScenario = {
	/** Timeline layers (clips): a long file cut into many, every cut continuing the source. */
	layers: SimLayer[];
	ops: InteractiveOp[];
	/** Milliseconds to simulate. */
	endMs: number;
	projectFps: number;
	videoFps: number;
	keyframeSeconds: number;
	decodeMs: number;
	startupMs: number;
	renderMs: number;
	maxStaleSeconds: number;
	/** The decoder process's first use takes this long for everyone (see `DecoderModelParams.firstUseMs`). */
	firstUseMs?: number;
	/**
	 * Nothing is drawn through the video cache before the first play: the picture at project
	 * open comes from another path, so the decoder's first use really is the first Space
	 * (what the Chrome trace of the real window shows).
	 */
	idleUntilPlay?: boolean;
	/** The owner's machine with room to spare (the budget grows to balanced mode's ceiling), as the desktop app reads it. */
	roomy?: boolean;
	/** Open the next clips' streams ahead of the playhead (the app's pre-roll across cuts). */
	preroll?: boolean;
	/** Decode the first frame of the file at t = 0 (the app's decoder warm-up at project open). */
	prewarmDecoder?: boolean;
	/** Space waits for the first decoded frames at the playhead (capped), as PlaybackManager does. */
	startGate?: boolean;
};

export type ScreenLayer = {
	layer: SimLayer;
	/** Source second the playhead asked for. */
	sourceTime: number;
	/** The frame the draw showed (null: black). */
	answer: SimAnswer;
};

export type ScreenSnapshot = {
	/** Virtual ms at which the draw finished. */
	atMs: number;
	/** Playhead (timeline seconds) the draw was made for. */
	time: number;
	playing: boolean;
	layers: ScreenLayer[];
};

export type InteractiveResult = {
	/** Every finished draw, in order. */
	screens: ScreenSnapshot[];
	/** The playhead (timeline seconds) at the end, and whether playback was on. */
	finalTime: number;
	finalPlaying: boolean;
	/** The last draw's snapshot (null: none). */
	last: ScreenSnapshot | null;
	/** Draws the gate asked for, and animation frames it let pass. */
	drawsStarted: number;
	gatedOut: number;
	/** Decoder streams the cache still holds when the run ends (before it is cleared). */
	openStreamsAtEnd: number;
	/** Virtual ms at which the playhead started to move for each play op, in order. */
	playheadStartedAt: number[];
};

const GiB = 1024 ** 3;
const ROOMY_MEMORY: MemorySource = {
	readMemory: async () => ({ totalBytes: 15.3 * GiB, availableBytes: 6 * GiB, swapTotalBytes: 8 * GiB, swapFreeBytes: 8 * GiB, appBytes: 1.2 * GiB }),
	mode: () => "balanced",
	deviceMemoryGiB: () => null,
};
/** Ticks that take the budget from the 256 MB start to the ceiling. */
const ROOMY_TICKS = 26;

const VSYNC_MS = 1000 / 60;
const MAX_EVENTS = 3_000_000;
const DRAIN_MS = 10_000;

function sourceTimeOf({ layer, time }: { layer: SimLayer; time: number }): number | null {
	const clipTime = time - layer.start;
	if (clipTime < 0 || clipTime >= layer.duration) return null;
	return layer.sourceStart + clipTime;
}

/** Whether `answer` shows `sourceTime` (within the tolerance the draw was made with). */
export function showsFrame({
	answer,
	sourceTime,
	maxStaleSeconds,
}: {
	answer: SimAnswer;
	sourceTime: number;
	maxStaleSeconds: number;
}): boolean {
	if (!answer) return false;
	if (answer.timestamp > sourceTime + 1e-9) return false;
	return sourceTime < answer.timestamp + answer.duration + maxStaleSeconds + 1e-9;
}

export async function runInteractiveScenario({
	scenario,
}: {
	scenario: InteractiveScenario;
}): Promise<InteractiveResult> {
	const clock = new VirtualClock();
	const stats = createDecoderStats();
	const maxSourceEnd = Math.max(...scenario.layers.map((l) => l.sourceStart + l.duration));
	const params: DecoderModelParams = {
		fps: scenario.videoFps,
		frameCount: Math.ceil((maxSourceEnd + 5) * scenario.videoFps),
		keyframeInterval: Math.max(1, Math.round(scenario.keyframeSeconds * scenario.videoFps)),
		decodeMs: scenario.decodeMs,
		startupMs: scenario.startupMs,
		maxQueued: 8,
		firstUseMs: scenario.firstUseMs,
	};
	const files = new Map<string, File>();
	for (const layer of scenario.layers) {
		if (!files.has(layer.mediaId)) files.set(layer.mediaId, new File([], layer.mediaId));
	}
	const cache = new VideoCache<SimCanvas>({
		openSource: async () => createModelSource({ clock, params, stats, lanes: null }),
		now: () => clock.now,
		...(scenario.roomy && { memory: ROOMY_MEMORY }),
	});
	if (scenario.roomy) {
		for (let tick = 0; tick < ROOMY_TICKS; tick++) await cache.tickMemory();
	}

	// The transport: the playhead is `baseTime` at `baseMs` and moves while playing.
	let playing = false;
	let baseTime = 0;
	let baseMs = 0;
	let sceneVersion = 0;
	let blockedUntil = 0;
	let extraDrawMs = 0;
	const playheadAt = (ms: number) => (playing ? baseTime + (ms - baseMs) / 1000 : baseTime);

	const screens: ScreenSnapshot[] = [];
	let drawsStarted = 0;
	let gatedOut = 0;
	let rendering = false;
	let lastFrame = -1;
	let lastScene = -1;
	let lastMaxStale = 0;

	const playheadStartedAt: number[] = [];

	const draw = async ({
		time,
		maxStaleSeconds,
		wasPlaying,
		record = true,
	}: {
		time: number;
		maxStaleSeconds: number;
		wasPlaying: boolean;
		record?: boolean;
	}) => {

		const visible = scenario.layers.flatMap((layer) => {
			const sourceTime = sourceTimeOf({ layer, time });
			return sourceTime === null ? [] : [{ layer, sourceTime }];
		});
		const lease: RenderLease = cache.beginRender();
		const answers = await cache.withPlaybackTolerance({
			maxStaleSeconds,
			run: () =>
				Promise.all(
					visible.map(({ layer, sourceTime }) =>
						cache.getFrameAt({
							mediaId: layer.mediaId,
							file: files.get(layer.mediaId) ?? new File([], layer.mediaId),
							time: sourceTime,
							lease,
							streamKey: layer.elementId,
						}),
					),
				),
		});
		// A stall that began while this draw was running makes it finish late.
		if (extraDrawMs > 0) {
			const extra = extraDrawMs;
			extraDrawMs = 0;
			await clock.sleep(extra);
		}
		await clock.sleep(scenario.renderMs);
		cache.endRender({ lease });
		if (record) {
			screens.push({
				atMs: clock.now,
				time,
				playing: wasPlaying,
				layers: visible.map((entry, index) => ({ ...entry, answer: answers[index] ?? null })),
			});
		}
		rendering = false;
	};

	let everPlayed = false;
	const onTick = () => {
		if (scenario.preroll) {
			const time = playheadAt(clock.now);
			const infos = scenario.layers.map((layer) => ({ key: layer.elementId, mediaId: layer.mediaId, start: layer.start, sourceStart: layer.sourceStart }));
			// playing: the next boundaries; at rest: only the next one (the first Space finds it ready)
			const upcoming = planPreroll({ clips: infos, time, maxClips: playing ? undefined : 1 });
			const current = scenario.layers.filter((layer) => layer.start <= time && time < layer.start + layer.duration).map((layer) => layer.elementId);
			// the same set every tick is cheap: already pre-rolled clips are skipped
			void cache.prefetchClips({
				clips: upcoming.map((clip) => ({ mediaId: clip.mediaId, file: files.get(clip.mediaId) ?? new File([], clip.mediaId), key: clip.key, time: clip.sourceStart })),
				keep: current,
			});
		}
		if (clock.now < blockedUntil || rendering) return;
		if (scenario.idleUntilPlay && !everPlayed) return;
		const time = playheadAt(clock.now);
		const ticksPerFrame = 1 / scenario.projectFps;
		const frame = Math.floor(time / ticksPerFrame + 1e-6);
		const maxStaleSeconds = playing ? scenario.maxStaleSeconds : 0;
		const go = shouldRenderPreview({
			isExporting: false,
			frame,
			lastFrame,
			scene: sceneVersion,
			lastScene: lastScene === -1 ? null : lastScene,
			compositorSerial: 0,
			lastOwnSerial: 0,
			maxStaleSeconds,
			lastMaxStaleSeconds: lastMaxStale,
		});
		if (!go) {
			gatedOut += 1;
			return;
		}
		rendering = true;
		lastFrame = frame;
		lastScene = sceneVersion;
		lastMaxStale = maxStaleSeconds;
		drawsStarted += 1;
		void draw({ time, maxStaleSeconds, wasPlaying: playing });
	};

	if (scenario.prewarmDecoder) {
		const first = scenario.layers[0];
		if (first) {
			const lease = cache.beginRender();
			void cache
				.getFrameAt({ mediaId: first.mediaId, file: files.get(first.mediaId) ?? new File([], first.mediaId), time: first.sourceStart, lease, streamKey: "prewarm" })
				.finally(() => cache.endRender({ lease }));
		}
	}
	for (let tick = 1; tick * VSYNC_MS <= scenario.endMs; tick++) {
		clock.at({ time: tick * VSYNC_MS, run: onTick });
	}
	for (const op of scenario.ops) {
		clock.at({
			time: op.at,
			run: () => {
				const now = clock.now;
				if (op.op === "play") {
					everPlayed = true;
					const start = () => {
						baseTime = playheadAt(clock.now);
						baseMs = clock.now;
						playing = true;
						playheadStartedAt.push(clock.now);
					};
					if (!scenario.startGate) {
						start();
					} else {
						// the first decoded frames at the playhead (not a draw)
						const gate = async () => {
							const lease = cache.beginRender();
							const time = playheadAt(clock.now);
							await Promise.all(
								scenario.layers.flatMap((layer) => {
									const sourceTime = sourceTimeOf({ layer, time });
									return sourceTime === null
										? []
										: [cache.getFrameAt({ mediaId: layer.mediaId, file: files.get(layer.mediaId) ?? new File([], layer.mediaId), time: sourceTime, lease, streamKey: layer.elementId })];
								}),
							);
							cache.endRender({ lease });
						};
						void waitForStartGate({ gate, maxMs: START_GATE_MAX_MS, sleep: (ms) => clock.sleep(ms) }).then(start);
					}
				} else if (op.op === "pause") {
					baseTime = playheadAt(now);
					playing = false;
				} else if (op.op === "seek") {
					baseTime = op.time;
					baseMs = now;
					sceneVersion += 1;
				} else {
					blockedUntil = Math.max(blockedUntil, now + op.ms);
					if (rendering) extraDrawMs += op.ms;
				}
			},
		});
	}

	await clock.runUntil({ time: scenario.endMs, maxEvents: MAX_EVENTS });
	await clock.runUntil({ time: scenario.endMs + DRAIN_MS, maxEvents: MAX_EVENTS });
	const finalTime = playheadAt(scenario.endMs);
	const openStreamsAtEnd = cache.getMemoryStats().streams;
	cache.clearAll();
	return {
		screens,
		finalTime,
		finalPlaying: playing,
		last: screens[screens.length - 1] ?? null,
		drawsStarted,
		gatedOut,
		openStreamsAtEnd,
		playheadStartedAt,
	};
}


/** A long file cut into `count` contiguous clips of `seconds` each, every cut continuing the source. */
export function cutFileLayers({
	count,
	seconds,
	sourceStart = 10.3,
}: {
	count: number;
	seconds: number;
	sourceStart?: number;
}): SimLayer[] {
	return Array.from({ length: count }, (_, index) => ({
		elementId: `cut-${index}`,
		mediaId: "m1",
		role: "video" as const,
		start: index * seconds,
		duration: seconds,
		sourceStart: sourceStart + index * seconds,
	}));
}

/**
 * The owner's cut project: 16 short clips (0.4-1.3 s) from two long files whose key frames are
 * 6 s apart, every clip starting in the middle of a GOP. Source starts of file 1 are the measured
 * ones (8.8 ... 42.7 s); file 2 interleaves every 4th clip.
 */
export function sparseCutLayers(): SimLayer[] {
	const durations = [0.9, 0.9, 1.0, 1.0, 1.3, 1.1, 0.9, 1.0, 0.6, 0.4, 1.0, 1.0, 0.9, 1.0, 0.8, 0.7];
	const file1 = [8.8, 11.3, 14.3, 17.3, 20.4, 23.5, 26.8, 29.9, 33.0, 36.0, 38.7, 42.7];
	const file2 = [3.0, 12.5, 25.0, 31.0];
	let start = 0;
	let next1 = 0;
	let next2 = 0;
	return durations.map((duration, index) => {
		const second = index % 4 === 3;
		const layer: SimLayer = {
			elementId: `cut-${index}`,
			mediaId: second ? "m2" : "m1",
			role: "video" as const,
			start,
			duration,
			sourceStart: second ? (file2[next2++] ?? 3) : (file1[next1++] ?? 8.8),
		};
		start += duration;
		return layer;
	});
}

/**
 * Per clip (after the first): ms between the moment the playhead reaches the clip and the first
 * finished draw that shows its picture. Null: it never showed (counted as a failure by the caller).
 */
export function firstPictureLags({
	result,
	layers,
	playAtMs,
	maxStaleSeconds,
}: {
	result: InteractiveResult;
	layers: SimLayer[];
	playAtMs: number;
	maxStaleSeconds: number;
}): Array<number | null> {
	return layers.slice(1).map((layer) => {
		const boundaryMs = playAtMs + layer.start * 1000;
		const shown = result.screens.find(
			(screen) =>
				screen.time >= layer.start - 1e-9 &&
				screen.layers.some(
					(entry) =>
						entry.layer.elementId === layer.elementId &&
						showsFrame({ answer: entry.answer, sourceTime: entry.sourceTime, maxStaleSeconds }),
				),
		);
		return shown ? shown.atMs - boundaryMs : null;
	});
}
