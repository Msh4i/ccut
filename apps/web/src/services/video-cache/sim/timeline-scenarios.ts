import type { SimLayer, TimelineScenario, TimelineVariant } from "./timeline-sim";

/**
 * The multi-clip scenarios of `docs/ccut/playback-streams-report.md`. Every
 * timing is an assumption (30 fps video in a 60 fps project, key frame every
 * second, 6 ms per decoded frame, 20 ms decoder start, 25 ms GPU per draw),
 * the same family as `run-playback-sim.ts`.
 */
const BASE: Omit<TimelineScenario, "name" | "layers"> = {
	seconds: 20,
	projectFps: 60,
	videoFps: 30,
	keyframeSeconds: 1,
	decodeMs: 6,
	startupMs: 20,
	renderMs: 25,
	maxStaleSeconds: 0.09,
};

function clip({
	elementId,
	mediaId,
	start,
	duration,
	sourceStart,
	role = "video",
}: {
	elementId: string;
	mediaId: string;
	start: number;
	duration: number;
	sourceStart: number;
	role?: SimLayer["role"];
}): SimLayer {
	return { elementId, mediaId, role, start, duration, sourceStart };
}

/** A/B cut every 2 s: even segments show source t, odd ones t + 10 s (cuts land mid-GOP). */
function abCutLayers({ seconds }: { seconds: number }): SimLayer[] {
	const layers: SimLayer[] = [];
	for (let segment = 0; segment * 2 < seconds; segment++) {
		const start = segment * 2;
		layers.push(
			clip({
				elementId: `cut-${segment}`,
				mediaId: "m1",
				start,
				duration: 2,
				sourceStart: 10.5 + start + (segment % 2 === 1 ? 10 : 0),
			}),
		);
	}
	return layers;
}

export const TIMELINE_SCENARIOS: TimelineScenario[] = [
	{
		...BASE,
		name: "(a) same asset, picture-in-picture at t and t+5 s",
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
			clip({ elementId: "pip", mediaId: "m1", start: 0, duration: 20, sourceStart: 15 }),
		],
	},
	{
		...BASE,
		name: "(a-seq) as (a), each layer asked after the previous answered",
		requestOrder: "sequential",
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
			clip({ elementId: "pip", mediaId: "m1", start: 0, duration: 20, sourceStart: 15 }),
		],
	},
	{
		...BASE,
		name: "(a1) as (a), one shared decode engine",
		decodeLanes: 1,
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
			clip({ elementId: "pip", mediaId: "m1", start: 0, duration: 20, sourceStart: 15 }),
		],
	},
	{
		...BASE,
		name: "(a2) as (a), blur backdrop of the main clip on",
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10, role: "backdrop" }),
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
			clip({ elementId: "pip", mediaId: "m1", start: 0, duration: 20, sourceStart: 15 }),
		],
	},
	{
		...BASE,
		name: "(a3) same asset, picture-in-picture at t and t+1 s",
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
			clip({ elementId: "pip", mediaId: "m1", start: 0, duration: 20, sourceStart: 11 }),
		],
	},
	{
		...BASE,
		name: "(b) two different assets overlapping",
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
			clip({ elementId: "pip", mediaId: "m2", start: 0, duration: 20, sourceStart: 10 }),
		],
	},
	{
		...BASE,
		name: "(c) same asset, A/B hard cut every 2 s (t / t+10 s)",
		layers: abCutLayers({ seconds: BASE.seconds }),
	},
	{
		...BASE,
		name: "(d) one clip with its own blur backdrop",
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10, role: "backdrop" }),
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
		],
	},
	{
		...BASE,
		name: "(e) split clip: two adjacent clips, continuous source",
		layers: [
			clip({ elementId: "left", mediaId: "m1", start: 0, duration: 10, sourceStart: 10 }),
			clip({ elementId: "right", mediaId: "m1", start: 10, duration: 10, sourceStart: 20 }),
		],
	},
];

/**
 * Upload cost x layers: the GPU part of a draw is 5 ms plus 21 ms for every
 * video layer whose frame changed (the 1920x1080 upload wait measured in
 * `docs/ccut/playback-perf-report.md`, "upload per frame", taken here as an
 * ASSUMED cost per layer; the 2-clip numbers are an extrapolation).
 */
const UPLOAD_BASE: Omit<TimelineScenario, "name" | "layers"> = {
	...BASE,
	renderMs: 5,
	uploadMs: { video: 21, backdrop: 0 },
};

export const UPLOAD_SCENARIOS: TimelineScenario[] = [
	{
		...UPLOAD_BASE,
		name: "(u1) one 1080p clip, upload 21 ms per new frame",
		layers: [clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 })],
	},
	{
		...UPLOAD_BASE,
		name: "(u2) two different 1080p assets overlapping, upload 21 ms each",
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
			clip({ elementId: "pip", mediaId: "m2", start: 0, duration: 20, sourceStart: 10 }),
		],
	},
	{
		...UPLOAD_BASE,
		name: "(u3) same asset twice (picture-in-picture t / t+5 s), upload 21 ms each",
		layers: [
			clip({ elementId: "main", mediaId: "m1", start: 0, duration: 20, sourceStart: 10 }),
			clip({ elementId: "pip", mediaId: "m1", start: 0, duration: 20, sourceStart: 15 }),
		],
	},
];

/** Source second the first clip of `sameFileScenario` shows when it enters. */
export const SAME_FILE_SOURCE_START = 10.3;
/**
 * Source seconds between two clips of `sameFileScenario`: off the 1 s key
 * frames, more than a split clip's 0.5 s and less than the decoder's 3 s
 * forward window. It must stay above a frame plus the playback tolerance
 * (1/30 + 0.09 s), or another clip's frame would pass for the right one.
 */
export const SAME_FILE_SPACING_SECONDS = 1.7;
/** The sweep of `run-timeline-sim.ts` goes up to this many clips. */
export const SAME_FILE_MAX_CLIPS = 12;

/** How the clips of `sameFileScenario` are laid out (the shapes of the sweep). */
export type SameFileShape = {
	label: string;
	/**
	 * Every clip also has a blur backdrop, asked before every video (the
	 * root's blur nodes come first). A stress beyond the renderer, which adds
	 * backdrops for main-track clips only (scene-builder.ts): two requests per
	 * clip per draw, a backdrop and its video sharing one answer.
	 */
	backdrops?: boolean;
	/**
	 * Clip i enters at i x seconds / 2N and stays for half the run: clips
	 * enter and leave while others play (streams change owner, go idle).
	 */
	stagger?: boolean;
	/** Source seconds between two clips (default SAME_FILE_SPACING_SECONDS). */
	spacingSeconds?: number;
	/** Clips alternate between this many files (default 1). */
	files?: number;
};

export const SAME_FILE_SHAPES: SameFileShape[] = [
	{ label: "plain" },
	{ label: "backdrops", backdrops: true },
	{ label: "staggered", stagger: true },
	// Within a split clip's 0.5 s window.
	{ label: "0.3 s apart", spacingSeconds: 0.3 },
	{ label: "two files", files: 2 },
];

/**
 * `count` clips of ONE file on screen together (tiles of a grid, or
 * picture-in-picture copies), clip i showing source second
 * 10.3 + spacing x i when it enters. Without `stagger` every clip is on
 * screen for the whole run.
 */
export function sameFileScenario({
	count,
	seconds = BASE.seconds,
	backdrops = false,
	stagger = false,
	spacingSeconds = SAME_FILE_SPACING_SECONDS,
	files = 1,
}: Omit<SameFileShape, "label"> & {
	count: number;
	seconds?: number;
}): TimelineScenario {
	if (!Number.isInteger(count) || count < 1) {
		throw new RangeError(`sameFileScenario needs a whole number of clips from 1, got ${count}`);
	}
	if (!(spacingSeconds > BASE.maxStaleSeconds + 1 / BASE.videoFps)) {
		throw new RangeError(
			`clips ${spacingSeconds} s apart cannot be told apart within the playback tolerance`,
		);
	}
	if (!Number.isInteger(files) || files < 1) {
		throw new RangeError(`sameFileScenario needs a whole number of files from 1, got ${files}`);
	}
	const videos = Array.from({ length: count }, (_, index) =>
		clip({
			elementId: `clip-${index + 1}`,
			mediaId: `m${(index % files) + 1}`,
			start: stagger ? (index * seconds) / (2 * count) : 0,
			duration: stagger ? seconds / 2 : seconds,
			// Rounded to the millisecond so 10.3 + 1.7 i stays readable.
			sourceStart: Math.round((SAME_FILE_SOURCE_START + spacingSeconds * index) * 1000) / 1000,
		}),
	);
	const shape = [
		...(backdrops ? ["backdrops"] : []),
		...(stagger ? ["staggered"] : []),
		...(files > 1 ? [`${files} files`] : []),
	];
	return {
		...BASE,
		seconds,
		name: `(n${count}) ${count} clip${count === 1 ? "" : "s"} ${spacingSeconds} s apart${shape.length > 0 ? `, ${shape.join(", ")}` : ""}`,
		layers: [
			...(backdrops ? videos.map((video): SimLayer => ({ ...video, role: "backdrop" })) : []),
			...videos,
		],
	};
}

/** The scale a small preview tile asks for while it plays. */
export const PREVIEW_SCALE = 0.25;

/**
 * Variants of the N-clip sweep, every one with the element id as stream key
 * (what the renderer passes): the preview while it plays, full size (paused
 * preview, export), one decode engine for every decoder (hardware decode),
 * and the memory budget at its floor.
 */
export const SAME_FILE_VARIANTS: TimelineVariant[] = [
	{ label: "keyed, scale 0.25", keyed: true, scale: PREVIEW_SCALE },
	{ label: "keyed, scale 1", keyed: true, scale: 1 },
	{ label: "keyed, one decode lane, scale 0.25", keyed: true, scale: PREVIEW_SCALE, decodeLanes: 1 },
	{ label: "keyed, pressure floor, scale 0.25", keyed: true, scale: PREVIEW_SCALE, pressure: true },
	{ label: "keyed, 3 GB budget, scale 0.25", keyed: true, scale: PREVIEW_SCALE, roomy: true },
];
