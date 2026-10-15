import { describe, expect, test } from "bun:test";
import { DEFAULT_FRAME_BYTES } from "../frame-stream";
import { BUDGET_FLOOR_BYTES, FALLBACK_BUDGET_BYTES } from "../memory-budget";
import type { SimCanvas } from "../sim/decoder-model";
import {
	SAME_FILE_MAX_CLIPS,
	SAME_FILE_SHAPES,
	SAME_FILE_SPACING_SECONDS,
	SAME_FILE_VARIANTS,
	type SameFileShape,
	TIMELINE_SCENARIOS,
	sameFileScenario,
} from "../sim/timeline-scenarios";
import {
	type SimAnswer,
	type TimelineResult,
	type TimelineScenario,
	type TimelineVariant,
	memoryViolations,
	ownFrameViolations,
	runTimelineScenario,
	scoreDraw,
} from "../sim/timeline-sim";

// Multi-clip playback on the virtual clock (sim/timeline-sim.ts), shortened to
// 4 s. "one stream per media" is the cache before streams.

function scenario(prefix: string): TimelineScenario {
	const found = TIMELINE_SCENARIOS.find((candidate) => candidate.name.startsWith(prefix));
	if (!found) throw new Error(`no scenario ${prefix}`);
	return { ...found, seconds: 4 };
}

const ONE_STREAM: TimelineVariant = {
	label: "one stream per media",
	keyed: false,
	streams: { maxPerMedia: 1 },
};
const KEYED: TimelineVariant = { label: "streams, element id key", keyed: true };

describe("timeline simulation: two clips of one asset", () => {
	test("one stream per media shows the wrong picture on the first clip (parallel requests) or restarts per draw (sequential)", async () => {
		const parallel = await runTimelineScenario({ scenario: scenario("(a) "), variant: ONE_STREAM });
		expect(parallel.wrongFrames).toBeGreaterThanOrEqual(parallel.layerAnswers / 2 - 1);
		const sequential = await runTimelineScenario({ scenario: scenario("(a-seq)"), variant: ONE_STREAM });
		expect(sequential.restartsPerSecond).toBeGreaterThan(sequential.fps);
	});

	test("one stream per clip: every layer shows its own frame and each decoder starts once", async () => {
		for (const prefix of ["(a) ", "(a-seq)", "(a2)", "(a3)"]) {
			const result = await runTimelineScenario({ scenario: scenario(prefix), variant: KEYED });
			expect(result.wrongFrames).toBe(0);
			expect(result.mismatched).toBe(0);
			expect(result.restarts).toBe(2);
			expect(result.fps).toBeGreaterThan(29);
		}
	});

	test("a split clip and a clip with its own backdrop keep one decoder", async () => {
		for (const prefix of ["(d)", "(e)"]) {
			const result = await runTimelineScenario({ scenario: scenario(prefix), variant: KEYED });
			expect(result.restarts).toBe(1);
			expect(result.wrongFrames).toBe(0);
		}
	});
});

// The simulator's own metrics: an answer is judged by its timestamp (wrong)
// and by what its canvas holds when the draw's answers settled (canvas
// mismatch); memory comes from the simulator's model of decoders and canvases.

const FPS = 30;
const LAYER = {
	elementId: "a",
	mediaId: "m1",
	role: "video" as const,
	start: 0,
	duration: 10,
	sourceStart: 10,
};
const DECODED = DEFAULT_FRAME_BYTES.decoded;

function canvasOf(overrides: Partial<SimCanvas> = {}): SimCanvas {
	return { id: 1, frame: -1, scale: 1, destroyed: false, ...overrides };
}

function answerOf({ index, canvasFrame = index }: { index: number; canvasFrame?: number }): SimAnswer {
	return {
		canvas: canvasOf({ frame: canvasFrame }),
		timestamp: index / FPS,
		duration: 1 / FPS,
	};
}

function score({
	sourceTime,
	answer,
}: {
	sourceTime: number;
	answer: SimAnswer;
}) {
	return scoreDraw({
		visible: [{ layer: LAYER, sourceTime }],
		answers: [answer],
		videoFps: FPS,
		maxStaleSeconds: 0.09,
	});
}

describe("timeline simulation: metrics of one draw", () => {
	test("an answer whose canvas holds its own frame counts nothing", () => {
		const result = score({ sourceTime: 300 / FPS, answer: answerOf({ index: 300 }) });
		expect(result).toMatchObject({ wrong: 0, canvasMismatch: 0, backdropMismatch: false });
	});

	test("a canvas drawn over with another clip's frame is a canvas mismatch, not a wrong answer", () => {
		const result = score({
			sourceTime: 300 / FPS,
			answer: answerOf({ index: 300, canvasFrame: 351 }),
		});
		expect(result.wrong).toBe(0);
		expect(result.canvasMismatch).toBe(1);
	});

	test("another clip's frame is a wrong answer and a canvas mismatch", () => {
		const result = score({ sourceTime: 300 / FPS, answer: answerOf({ index: 351 }) });
		expect(result.wrong).toBe(1);
		expect(result.canvasMismatch).toBe(1);
	});

	test("a missing answer is wrong; there is no canvas to check", () => {
		const result = score({ sourceTime: 300 / FPS, answer: null });
		expect(result).toMatchObject({ wrong: 1, canvasMismatch: 0 });
	});

	test("a canvas never drawn into is a canvas mismatch", () => {
		const result = score({
			sourceTime: 0,
			answer: answerOf({ index: 0, canvasFrame: -1 }),
		});
		expect(result).toMatchObject({ wrong: 0, canvasMismatch: 1 });
	});

	test("a destroyed canvas is a canvas mismatch, whatever frame it last held", () => {
		const result = score({
			sourceTime: 300 / FPS,
			answer: { canvas: canvasOf({ frame: 300, destroyed: true }), timestamp: 10, duration: 1 / FPS },
		});
		expect(result).toMatchObject({ wrong: 0, canvasMismatch: 1 });
	});

	test("a frame within the playback tolerance is right on both counts, an older one wrong on both", () => {
		// Frame 300 ends at 301/30 s; 0.09 s later is the last time it may stand for.
		const within = score({ sourceTime: 301 / FPS + 0.08, answer: answerOf({ index: 300 }) });
		expect(within).toMatchObject({ wrong: 0, canvasMismatch: 0 });
		expect(within.lagMaxMs).toBeCloseTo((1 / FPS + 0.08) * 1000, 6);
		const older = score({ sourceTime: 301 / FPS + 0.1, answer: answerOf({ index: 300 }) });
		expect(older).toMatchObject({ wrong: 1, canvasMismatch: 1 });
	});

	test("a backdrop and the video of one clip showing different frames mark the draw", () => {
		const backdrop = { ...LAYER, role: "backdrop" as const };
		const same = scoreDraw({
			visible: [
				{ layer: backdrop, sourceTime: 300 / FPS },
				{ layer: LAYER, sourceTime: 300 / FPS },
			],
			answers: [answerOf({ index: 300 }), answerOf({ index: 300 })],
			videoFps: FPS,
			maxStaleSeconds: 0.09,
		});
		expect(same.backdropMismatch).toBe(false);
		const different = scoreDraw({
			visible: [
				{ layer: backdrop, sourceTime: 300 / FPS },
				{ layer: LAYER, sourceTime: 300 / FPS },
			],
			answers: [answerOf({ index: 299 }), answerOf({ index: 300 })],
			videoFps: FPS,
			maxStaleSeconds: 0.09,
		});
		expect(different.backdropMismatch).toBe(true);
	});
});

describe("timeline simulation: N clips of one file, the scenario", () => {
	test("sameFileScenario lays out N clips of one media at 10.3 + 1.7 i s, visible for the whole run", () => {
		const result = sameFileScenario({ count: 3, seconds: 6 });
		expect(result.seconds).toBe(6);
		expect(result.layers.map((layer) => layer.sourceStart)).toEqual([10.3, 12, 13.7]);
		expect(new Set(result.layers.map((layer) => layer.mediaId))).toEqual(new Set(["m1"]));
		expect(new Set(result.layers.map((layer) => layer.elementId)).size).toBe(3);
		for (const layer of result.layers) {
			expect(layer).toMatchObject({ role: "video", start: 0, duration: 6 });
		}
		expect(sameFileScenario({ count: 12 }).layers).toHaveLength(12);
	});

	test("sameFileScenario refuses a clip count that is not a whole number from 1", () => {
		for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => sameFileScenario({ count })).toThrow(RangeError);
		}
	});

	test("clips stay further apart than a frame plus the playback tolerance, so another clip's frame is never 'right'", () => {
		const base = sameFileScenario({ count: 2 });
		const tolerance = base.maxStaleSeconds + 1 / base.videoFps;
		expect(SAME_FILE_SPACING_SECONDS).toBeGreaterThan(tolerance);
		for (const shape of SAME_FILE_SHAPES) {
			const layers = sameFileScenario({ count: 2, ...shape }).layers.filter(
				(layer) => layer.role === "video",
			);
			expect(Math.abs(layers[1].sourceStart - layers[0].sourceStart)).toBeGreaterThan(tolerance);
		}
		expect(() => sameFileScenario({ count: 2, spacingSeconds: tolerance })).toThrow(RangeError);
		expect(() => sameFileScenario({ count: 2, spacingSeconds: 0.3 })).not.toThrow();
	});

	test("backdrops: every clip also has a blur backdrop, asked before every video (as the root's blur nodes)", () => {
		const result = sameFileScenario({ count: 3, seconds: 6, backdrops: true });
		expect(result.layers.map((layer) => `${layer.role}:${layer.elementId}`)).toEqual([
			"backdrop:clip-1",
			"backdrop:clip-2",
			"backdrop:clip-3",
			"video:clip-1",
			"video:clip-2",
			"video:clip-3",
		]);
		expect(result.layers[1]).toMatchObject({ start: 0, duration: 6, sourceStart: 12 });
	});

	test("stagger: clip i enters at i x seconds / 2N and stays half the run, so clips enter and leave", () => {
		const result = sameFileScenario({ count: 4, seconds: 8, stagger: true });
		expect(result.layers.map((layer) => [layer.start, layer.duration])).toEqual([
			[0, 4],
			[1, 4],
			[2, 4],
			[3, 4],
		]);
	});

	test("files: clips alternate between that many media", () => {
		const result = sameFileScenario({ count: 4, files: 2 });
		expect(result.layers.map((layer) => layer.mediaId)).toEqual(["m1", "m2", "m1", "m2"]);
	});
});

describe("timeline simulation: N clips of one file, metrics of a run", () => {
	test("one stream per media: the canvases of the first clip's answers hold the other clip's frame", async () => {
		const result = await runTimelineScenario({ scenario: scenario("(a) "), variant: ONE_STREAM });
		expect(result.canvasMismatch).toBeGreaterThanOrEqual(result.layerAnswers / 2 - 1);
	});

	test("a draw whose answers never settle is scored all wrong at the end, and no draw follows it", async () => {
		const stalled = await runTimelineScenario({
			scenario: sameFileScenario({ count: 6, seconds: 2 }),
			variant: KEYED,
			// The reviewer's mutant: getFrameAt never resolves for clips 5 and up.
			intercept: ({ layer, answer }) => {
				if (Number(layer.elementId.replace("clip-", "")) < 5) return answer;
				return answer.then(() => new Promise<SimAnswer>(() => {}));
			},
		});
		expect(stalled).toMatchObject({
			draws: 0,
			drawsStarted: 1,
			drawsOpen: 1,
			layerAnswers: 6,
			wrongFrames: 6,
			fps: 0,
		});
		expect(stalled.waitMaxMs).toBeGreaterThan(2000);
		expect(ownFrameViolations({ result: stalled, layersPerDraw: 6 })).toEqual([
			"1 draw never finished",
			"6 wrong",
			"6 answers for 0 draws",
			"no draw",
		]);
	});

	test("a draw still in flight at the end is finished and scored", async () => {
		const result = await runTimelineScenario({
			scenario: sameFileScenario({ count: 2, seconds: 2.01 }),
			variant: KEYED,
		});
		expect(result.drawsInFlightAtEnd).toBe(1);
		expect(result.drawsOpen).toBe(0);
		expect(result.draws).toBe(result.drawsStarted);
		expect(result.layerAnswers).toBe(result.draws * 2);
		expect(ownFrameViolations({ result, layersPerDraw: 2 })).toEqual([]);
	});

	test("the memory figure is the simulator's model: every decoder's queue counts, whatever the cache counts", async () => {
		const result = await runTimelineScenario({
			scenario: sameFileScenario({ count: 4, seconds: 2 }),
			variant: sweepVariant("keyed, scale 1"),
		});
		expect(result.decodersMax).toBe(4);
		expect(result.peakHeldBytes).toBeGreaterThanOrEqual(4 * 8 * DECODED);
		expect(memoryViolations({ result: { ...result, budgetBytes: result.peakHeldBytes } })).toEqual([]);
		expect(memoryViolations({ result: { ...result, budgetBytes: result.peakHeldBytes - 1 } })).toEqual([
			`model peak ${result.peakHeldBytes} B over the budget ${result.peakHeldBytes - 1} B`,
		]);
	});

	test("a canvas drawn over between the answers and the end of the render (the upload) is a canvas mismatch", async () => {
		// The cache answers right, then something draws over the first clip's
		// canvas while the render's GPU part (its uploads) still runs.
		let drawnOver = false;
		const result = await runTimelineScenario({
			scenario: sameFileScenario({ count: 2, seconds: 1 }),
			variant: KEYED,
			afterAnswers: (answers) => {
				const first = answers[0];
				if (first && !drawnOver) {
					drawnOver = true;
					first.canvas.frame = 0;
				}
			},
		});
		expect(result.wrongFrames).toBe(0);
		expect(result.canvasMismatch).toBe(1);
	});

	test("memory, budget and streams are sampled while the run plays", async () => {
		const one = await runTimelineScenario({
			scenario: sameFileScenario({ count: 1, seconds: 2 }),
			variant: KEYED,
		});
		expect(one.streamsMax).toBe(1);
		expect(one.decodersMax).toBe(1);
		expect(one.budgetBytes).toBe(FALLBACK_BUDGET_BYTES);
		// At least the shown 1080p canvas; read-ahead, spare canvases and kept
		// frames (the drawn-frame cache fills up to its share) on top.
		expect(one.peakUsedBytes).toBeGreaterThan(DEFAULT_FRAME_BYTES.drawn);
		expect(one.peakHeldBytes).toBeGreaterThan(DEFAULT_FRAME_BYTES.drawn);

		const three = await runTimelineScenario({
			scenario: sameFileScenario({ count: 3, seconds: 2 }),
			variant: KEYED,
		});
		expect(three.streamsMax).toBe(3);
		expect(three.decodersMax).toBe(3);
	});

	test("the preview scale draws smaller canvases", async () => {
		const full = await runTimelineScenario({
			scenario: sameFileScenario({ count: 1, seconds: 2 }),
			variant: KEYED,
		});
		const preview = await runTimelineScenario({
			scenario: sameFileScenario({ count: 1, seconds: 2 }),
			variant: { ...KEYED, scale: 0.25 },
		});
		expect(preview.wrongFrames).toBe(0);
		expect(preview.peakHeldBytes).toBeLessThan(full.peakHeldBytes);
		// The canvases shrink by 16, the decoded frames do not.
		expect(full.peakHeldBytes - preview.peakHeldBytes).toBeGreaterThanOrEqual(
			DEFAULT_FRAME_BYTES.drawn * (1 - 1 / 16),
		);
	});

	test("the roomy variant plays at the owner's machine's budget (3 GiB, balanced)", async () => {
		const result = await runTimelineScenario({
			scenario: sameFileScenario({ count: 1, seconds: 1 }),
			variant: { ...KEYED, roomy: true },
		});
		expect(result.budgetBytes).toBe(3 * 1024 ** 3);
	});

	test("the pressure variant plays at the budget's floor", async () => {
		const result = await runTimelineScenario({
			scenario: sameFileScenario({ count: 1, seconds: 2 }),
			variant: { ...KEYED, pressure: true },
		});
		expect(result.budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		expect(result.wrongFrames).toBe(0);
	});

	test("the one-lane variant makes decoders take turns", async () => {
		const parallel = await runTimelineScenario({
			scenario: sameFileScenario({ count: 4, seconds: 2 }),
			variant: KEYED,
		});
		const oneLane = await runTimelineScenario({
			scenario: sameFileScenario({ count: 4, seconds: 2 }),
			variant: { ...KEYED, decodeLanes: 1 },
		});
		expect(oneLane.waitTotalMs).toBeGreaterThan(parallel.waitTotalMs);
	});
});

/**
 * Runs of the sweep (4 s each), by shape, variant and clip count. The runs
 * are deterministic, so one run serves every rule checked on it.
 */
const sweepRuns = new Map<string, Promise<TimelineResult>>();

function sweepRun({
	variant,
	shape,
	count,
}: {
	variant: TimelineVariant;
	shape: SameFileShape;
	count: number;
}): Promise<TimelineResult> {
	const key = `${shape.label}|${variant.label}|${count}`;
	const known = sweepRuns.get(key);
	if (known) return known;
	const { label: _label, ...options } = shape;
	const run = runTimelineScenario({
		scenario: sameFileScenario({ count, seconds: 4, ...options }),
		variant,
	});
	sweepRuns.set(key, run);
	return run;
}

/** The clip counts of the sweep whose run breaks a rule. */
async function failingCounts({
	variant,
	shape = PLAIN,
	counts = ALL_COUNTS,
	breaks,
}: {
	variant: TimelineVariant;
	shape?: SameFileShape;
	counts?: number[];
	breaks: ({ count, result }: { count: number; result: TimelineResult }) => boolean;
}): Promise<number[]> {
	const failing: number[] = [];
	for (const count of counts) {
		const result = await sweepRun({ variant, shape, count });
		if (breaks({ count, result })) failing.push(count);
	}
	return failing;
}

const PLAIN: SameFileShape = { label: "plain" };

const ALL_COUNTS = Array.from({ length: SAME_FILE_MAX_CLIPS }, (_, index) => index + 1);

function sweepVariant(label: string): TimelineVariant {
	const found = SAME_FILE_VARIANTS.find((variant) => variant.label === label);
	if (!found) throw new Error(`no variant ${label}`);
	return found;
}

function sweepShape(label: string): SameFileShape {
	const found = SAME_FILE_SHAPES.find((shape) => shape.label === label);
	if (!found) throw new Error(`no shape ${label}`);
	return found;
}

/** Every clip shows its own frame in every draw, and every draw finishes. */
function breaksOwnFrames({ count, result }: { count: number; result: TimelineResult }): boolean {
	return ownFrameViolations({ result, layersPerDraw: count }).length > 0;
}

function breaksMemory({ result }: { result: TimelineResult }): boolean {
	return memoryViolations({ result }).length > 0;
}

// The rules of the stream sharing work, as the cache meets them: each list
// names the clip counts that break a rule. They are exact, so a list cannot
// stay right for the wrong reason (a throw fails the test, a new kind of
// failure changes the list). Own frames: met since C3 (streams are borrowed,
// never taken from a clip on screen). One stream at the pressure floor: met
// since C4 (the budget caps the streams of a media). Memory: see the list.
describe("timeline simulation: N clips of one file, rules", () => {
	test("up to 4 clips at full size: each keeps its own decoder, every answer shows its own frame", async () => {
		const failing = await failingCounts({
			variant: sweepVariant("keyed, scale 1"),
			counts: [1, 2, 3, 4],
			breaks: ({ count, result }) =>
				breaksOwnFrames({ count, result }) || result.restarts !== count,
		});
		expect(failing).toEqual([]);
	});

	test("own frames: 1..12 clips, every variant, every answer and canvas is the clip's own frame", async () => {
		for (const variant of SAME_FILE_VARIANTS) {
			expect({ variant: variant.label, failing: await failingCounts({ variant, breaks: breaksOwnFrames }) }).toEqual({
				variant: variant.label,
				failing: [],
			});
		}
	});

	test("every draw finishes, in every shape and variant (a cache that stops answering breaks it)", async () => {
		for (const shape of SAME_FILE_SHAPES) {
			for (const variant of SAME_FILE_VARIANTS) {
				const failing = await failingCounts({
					variant,
					shape,
					breaks: ({ result }) =>
						result.drawsOpen > 0 || result.draws !== result.drawsStarted || !(result.fps > 0),
				});
				expect({ shape: shape.label, variant: variant.label, failing }).toEqual({
					shape: shape.label,
					variant: variant.label,
					failing: [],
				});
			}
		}
		// It takes 4.5-4.9 s on a laptop (the default limit of 5 s failed it in the cloud and in the
		// owner's full runs): the limit is the only thing changed.
	}, 30_000);

	test("own frames with backdrops, staggered clips, clips 0.3 s apart and two files, every variant", async () => {
		for (const shape of SAME_FILE_SHAPES.filter((candidate) => candidate.label !== "plain")) {
			for (const variant of SAME_FILE_VARIANTS) {
				const failing = await failingCounts({
					variant,
					shape,
					breaks: ({ count, result }) =>
						ownFrameViolations({
							result,
							...(!shape.stagger && { layersPerDraw: count * (shape.backdrops ? 2 : 1) }),
						}).length > 0,
				});
				expect({ shape: shape.label, variant: variant.label, failing }).toEqual({
					shape: shape.label,
					variant: variant.label,
					failing: [],
				});
			}
		}
	});

	test("memory by the simulator's model: within the budget except the rows that cannot fit (see the list)", async () => {
		for (const shape of SAME_FILE_SHAPES) {
			for (const variant of SAME_FILE_VARIANTS) {
				const failing = await failingCounts({ variant, shape, breaks: breaksMemory });
				expect({ shape: shape.label, variant: variant.label, failing }).toEqual({
					shape: shape.label,
					variant: variant.label,
					failing: knownMemoryFailures({ shape: shape.label, variant: variant.label }),
				});
			}
		}
	});

	test("at the pressure floor at most two streams, and two clips play at full speed within the budget", async () => {
		const floor = sweepVariant("keyed, pressure floor, scale 0.25");
		for (const shape of SAME_FILE_SHAPES) {
			const failing = await failingCounts({
				variant: floor,
				shape,
				breaks: ({ result }) => result.decodersMax > 2 || result.streamsMax > 2,
			});
			expect({ shape: shape.label, failing }).toEqual({ shape: shape.label, failing: [] });
		}
		for (const label of ["plain", "staggered", "two files"]) {
			const result = await sweepRun({ variant: floor, shape: sweepShape(label), count: 2 });
			expect({ label, fast: result.fps >= 29, fits: result.peakHeldBytes <= result.budgetBytes }).toEqual({
				label,
				fast: true,
				fits: true,
			});
		}
	});

	test("the sweep shapes exist", () => {
		expect(SAME_FILE_SHAPES.map((shape) => shape.label)).toEqual([
			"plain",
			"backdrops",
			"staggered",
			"0.3 s apart",
			"two files",
		]);
		expect(sweepShape("0.3 s apart").spacingSeconds).toBe(0.3);
	});
});

/**
 * The rows over the budget by the simulator's model (4 s runs), with the
 * canvas quarantine at one render (render leases hold the rest) and the
 * stream cap counting what streams hold at the scale drawn:
 * - staggered at 256 MB (full size 12 clips, 1/4 size 8-12): the streams opened
 *   while fewer clips were on screen, and the canvases; at most 5 MB (2 %) over;
 * - two files at the 64 MB floor, 10 and more clips: a media on screen keeps
 *   one stream, and two decoders' queue and minimum read-ahead are 62 MB.
 */
function knownMemoryFailures({ shape, variant }: { shape: string; variant: string }): number[] {
	// 8 streams per media (C5): at the 256 MB fallback 7 streams fit by the cap's count and the
	// model's peak ends 1-5 MB (0.4-2 %) over, in these rows only.
	if (variant === "keyed, one decode lane, scale 0.25") {
		if (shape === "plain" || shape === "backdrops") return [11, 12];
		if (shape === "0.3 s apart") return [12];
	}
	if (shape === "staggered" && variant === "keyed, scale 0.25") return [8, 9, 10, 11, 12];
	if (shape === "staggered" && variant === "keyed, scale 1") return [12];
	if (shape === "two files" && variant === "keyed, pressure floor, scale 0.25") {
		return ALL_COUNTS.filter((count) => count >= 10);
	}
	return [];
}
