/**
 * From the scene motion to the five channels of an element (slice T3, plan
 * sections b1 and c "Pivot / yapisma matematigi", measurements M3).
 *
 * Every check plays the produced channels through `renderedCorners`, an
 * independent simulation of the renderer (images rotate after scaling, text
 * scales after rotating), and compares the element's four corners with where
 * a world-space marker puts them. Two kinds of input:
 *  - exact maps (the generator's ground truth, no tracker) test the
 *    conversion on its own and must be exact for similarity cameras;
 *  - maps solved from tracked frames reproduce the plan's measured numbers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import { perspectiveSuspected } from "../classify";
import { solvePin } from "../solve-pin";
import type { PinSolution } from "../types";
import {
	buildCameraPinChannels,
	elementCorners,
	maxCornerGap,
	type CameraPinChannels,
} from "../to-channels";
import type { SequenceOptions } from "../camera-synth";
import {
	analyse,
	analyseHomography,
	cachedAnalysis,
	FG_COMBO,
	getWorld,
	releaseCaches,
	report,
	type Analysis,
} from "./camera-fixtures";
import {
	CANVAS,
	CANVAS_PER_FRAME_PX,
	cornerErrors,
	exactHomographySolution,
	exactSimilaritySolution,
	fillHost,
	FRAME,
	frameTimeAt,
	homographyWorldTruth,
	kenBurnsHost,
	lookAt,
	mirroredHost,
	mirroredRotatedHost,
	posePath,
	renderedCorners,
	shiftedHost,
	similarityWorldTruth,
	spinPath,
	stretchedHost,
	zoomPath,
	type ElementSpec,
	type HostFn,
	type Look,
	type PathKind,
} from "./pin-fixtures";

afterAll(releaseCaches);

const N = 240;

const IMAGE: ElementSpec = {
	rect: { left: -300, top: -150, width: 600, height: 300 },
	isText: false,
};
const TEXT: ElementSpec = {
	rect: { left: -200, top: -45, width: 400, height: 90 },
	isText: true,
};

const look = ({
	x = 0,
	y = 0,
	scaleX = 1,
	scaleY = scaleX,
	rotate = 0,
}: {
	x?: number;
	y?: number;
	scaleX?: number;
	scaleY?: number;
	rotate?: number;
}): Look => ({ position: { x, y }, scaleX, scaleY, rotate });

interface Case {
	spec: ElementSpec;
	overlay: Look;
}

const CASES: Record<string, Case> = {
	"image 600x300, scale 1.3x0.7, turned 23 degrees": {
		spec: IMAGE,
		overlay: look({ x: 120, y: -80, scaleX: 1.3, scaleY: 0.7, rotate: 23 }),
	},
	"image mirrored by a negative scaleX, turned -17 degrees": {
		spec: IMAGE,
		overlay: look({ x: -240, y: 150, scaleX: -1.1, scaleY: 0.9, rotate: -17 }),
	},
	"text with uniform scale 1.2, turned 15 degrees": {
		spec: TEXT,
		overlay: look({ x: 60, y: 200, scaleX: 1.2, rotate: 15 }),
	},
	"left-aligned text (its origin at the left edge), scale 1.4, turned 25 degrees": {
		spec: { rect: { left: 0, top: -30, width: 420, height: 60 }, isText: true },
		overlay: look({ x: -300, y: 120, scaleX: 1.4, rotate: 25 }),
	},
	"text partly outside the canvas, scale 2, turned -35 degrees": {
		spec: TEXT,
		overlay: look({ x: 760, y: -430, scaleX: 2, rotate: -35 }),
	},
};

const HOSTS: Record<string, HostFn> = {
	"fills the canvas": fillHost,
	"scaled 1.2x, shifted, turned 5 degrees": shiftedHost,
	"Ken Burns (its own zoom, drift and turn)": kenBurnsHost,
	"mirrored": mirroredHost,
	"mirrored, scaled and turned -4 degrees": mirroredRotatedHost,
};

const PATHS: PathKind[] = ["pan", "zoom", "roll", "shake", "combo"];
/** Measured worst error of unequal-scale text under a 10 degree roll (41 px), times about 2. */
const LIMIT_TEXT_ROLL = 80;

function build({
	solution,
	host,
	spec,
	overlay,
	first = 0,
	last = solution.frameCount - 1,
}: {
	solution: PinSolution;
	host: HostFn;
	spec: ElementSpec;
	overlay: Look;
	first?: number;
	last?: number;
}): CameraPinChannels {
	return buildCameraPinChannels({
		maps: solution,
		first,
		last,
		frameTimeAt,
		frameSize: FRAME,
		hostAt: host,
		overlay,
		bounds: spec.rect,
		isText: spec.isText,
		canvasSize: CANVAS,
	});
}

describe("exact similarity maps: the element stays glued to the scene", () => {
	for (const [hostName, host] of Object.entries(HOSTS)) {
		for (const [caseName, { spec, overlay }] of Object.entries(CASES)) {
			test(`${caseName}, host ${hostName}: corners within 0.05 px@1920 on every camera path`, () => {
				let worst = 0;
				for (const kind of PATHS) {
					const poses = posePath({ kind, n: N });
					for (const f0 of [0, 120]) {
						const channels = build({
							solution: exactSimilaritySolution({ poses, f0 }),
							host,
							spec,
							overlay,
						});
						const result = cornerErrors({
							spec,
							overlay,
							channels,
							frames: channels.frames,
							truth: similarityWorldTruth({ poses, f0, host }),
							onlyVisible: false,
						});
						expect(result.frames).toBe(N);
						worst = Math.max(worst, result.max);
					}
				}
				report({ label: `exact S ${caseName} / ${hostName}`, values: { "worst px@1920": worst } });
				expect(worst).toBeLessThanOrEqual(0.05);
			});
		}
	}
});

describe("the pin frame keeps the element exactly as it was", () => {
	test("the channels at the pin frame equal the element's own transform", () => {
		const poses = posePath({ kind: "combo", n: N });
		for (const { spec, overlay } of Object.values(CASES)) {
			const f0 = 90;
			const channels = build({
				solution: exactSimilaritySolution({ poses, f0 }),
				host: shiftedHost,
				spec,
				overlay,
			});
			const i = f0;
			expect(channels.frames[i]).toBe(f0);
			expect(channels.x[i]).toBeCloseTo(overlay.position.x, 9);
			expect(channels.y[i]).toBeCloseTo(overlay.position.y, 9);
			expect(channels.scaleX[i]).toBeCloseTo(overlay.scaleX, 9);
			expect(channels.scaleY[i]).toBeCloseTo(overlay.scaleY, 9);
			expect(channels.rotate[i]).toBeCloseTo(overlay.rotate, 9);
		}
	});

	test("a rotation outside -180..180 at the pin frame is kept, not folded", () => {
		const poses = posePath({ kind: "roll", n: N });
		const overlay = look({ scaleX: 1.2, rotate: 400 });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 0 }),
			host: fillHost,
			spec: TEXT,
			overlay,
		});
		expect(channels.rotate[0]).toBeCloseTo(400, 9);
		for (let i = 0; i < N; i++) {
			expect(Math.abs(channels.rotate[i] - 400)).toBeLessThan(11);
		}
	});

	test("a still camera writes constant channels", () => {
		const poses = Array.from({ length: 60 }, () => posePath({ kind: "pan", n: 2 })[0]);
		const overlay = CASES["text with uniform scale 1.2, turned 15 degrees"].overlay;
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 30 }),
			host: fillHost,
			spec: TEXT,
			overlay,
		});
		for (let i = 0; i < 60; i++) {
			expect(channels.x[i]).toBeCloseTo(overlay.position.x, 9);
			expect(channels.y[i]).toBeCloseTo(overlay.position.y, 9);
			expect(channels.scaleX[i]).toBeCloseTo(overlay.scaleX, 9);
			expect(channels.rotate[i]).toBeCloseTo(overlay.rotate, 9);
		}
	});
});

describe("rotation is unwrapped, never folded back into -180..180", () => {
	const spec = IMAGE;
	for (const [name, { startDeg, totalDeg, host }] of Object.entries({
		"clockwise 430 degrees from 170": { startDeg: 170, totalDeg: 430, host: fillHost },
		"anticlockwise 430 degrees from -175": { startDeg: -175, totalDeg: -430, host: fillHost },
		"clockwise 430 degrees seen through a mirrored host (reversed)": {
			startDeg: 20,
			totalDeg: 430,
			host: mirroredHost,
		},
	})) {
		test(`${name}: continuous, adds up and still on the scene`, () => {
			const poses = spinPath({ n: N, totalDeg });
			const overlay = look({ x: 200, y: -90, scaleX: 0.8, rotate: startDeg });
			const channels = build({
				solution: exactSimilaritySolution({ poses, f0: 0 }),
				host,
				spec,
				overlay,
			});
			let biggestStep = 0;
			for (let i = 1; i < N; i++) {
				biggestStep = Math.max(biggestStep, Math.abs(channels.rotate[i] - channels.rotate[i - 1]));
			}
			const mirrored = host === mirroredHost;
			const expectedEnd = startDeg + (mirrored ? -totalDeg : totalDeg);
			// 430 degrees in 239 steps is 1.8 degrees a step; a folded angle jumps by 360
			expect(biggestStep).toBeLessThan(2.5);
			expect(channels.rotate[N - 1]).toBeCloseTo(expectedEnd, 4);
			expect(Math.abs(channels.rotate[N - 1] - channels.rotate[0])).toBeGreaterThanOrEqual(400);
			const result = cornerErrors({
				spec,
				overlay,
				channels,
				frames: channels.frames,
				truth: similarityWorldTruth({ poses, f0: 0, host }),
				onlyVisible: false,
			});
			expect(result.max).toBeLessThanOrEqual(0.05);
		});
	}

	test("unwrapping runs outward from the pin frame, so a pin in the middle is continuous both ways", () => {
		const poses = spinPath({ n: N, totalDeg: 430 });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 120 }),
			host: fillHost,
			spec,
			overlay: look({ scaleX: 1, rotate: 90 }),
		});
		expect(channels.rotate[120]).toBeCloseTo(90, 9);
		for (let i = 1; i < N; i++) {
			expect(Math.abs(channels.rotate[i] - channels.rotate[i - 1])).toBeLessThan(2.5);
		}
		// a quarter of 430 degrees either side of the pin frame, in the camera's direction
		expect(channels.rotate[N - 1]).toBeCloseTo(90 + (430 * (N - 1 - 120)) / (N - 1), 3);
		expect(channels.rotate[0]).toBeCloseTo(90 - (430 * 120) / (N - 1), 3);
	});
});

describe("text scales after it rotates, images rotate after they scale", () => {
	const nonUniformText: Case = {
		spec: TEXT,
		overlay: look({ x: 80, y: -120, scaleX: 1.5, scaleY: 0.8, rotate: 15 }),
	};

	test("text with scale 1.5 x 0.8 turned 15 degrees is exact on a pan and a zoom", () => {
		for (const kind of ["pan", "zoom"] as const) {
			const poses = posePath({ kind, n: N });
			const channels = build({
				solution: exactSimilaritySolution({ poses, f0: 60 }),
				host: fillHost,
				spec: nonUniformText.spec,
				overlay: nonUniformText.overlay,
			});
			const result = cornerErrors({
				spec: nonUniformText.spec,
				overlay: nonUniformText.overlay,
				channels,
				frames: channels.frames,
				truth: similarityWorldTruth({ poses, f0: 60, host: fillHost }),
				onlyVisible: false,
			});
			expect(result.max).toBeLessThanOrEqual(0.05);
			// the scales keep their ratio, the rotation only follows the camera
			expect(channels.scaleY[N - 1] / channels.scaleX[N - 1]).toBeCloseTo(0.8 / 1.5, 9);
		}
	});

	test("a hand shake turns the camera a fraction of a degree, which unequal scales feel a little", () => {
		const poses = posePath({ kind: "shake", n: N });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 60 }),
			host: fillHost,
			spec: nonUniformText.spec,
			overlay: nonUniformText.overlay,
		});
		const result = cornerErrors({
			spec: nonUniformText.spec,
			overlay: nonUniformText.overlay,
			channels,
			frames: channels.frames,
			truth: similarityWorldTruth({ poses, f0: 60, host: fillHost }),
			onlyVisible: false,
		});
		report({ label: "text 1.5x0.8 under a shake", values: { "worst px@1920": result.max } });
		// measured 1.44
		expect(result.max).toBeLessThanOrEqual(3);
	});

	test("the same element drawn as an image would need other numbers: text is not an image", () => {
		const poses = posePath({ kind: "pan", n: N });
		const solution = exactSimilaritySolution({ poses, f0: 60 });
		const asText = build({ solution, host: fillHost, spec: nonUniformText.spec, overlay: nonUniformText.overlay });
		const asImage = build({
			solution,
			host: fillHost,
			spec: { ...nonUniformText.spec, isText: false },
			overlay: nonUniformText.overlay,
		});
		// at the pin frame both are the element as given, but a rotated 1.5 x 0.8 box
		// is a different picture under each rule: compare where the first corner is
		const atPinText = renderedCorners({ spec: nonUniformText.spec, look: lookAt({ channels: asText, i: 60 }) });
		const atPinImage = renderedCorners({ spec: { ...nonUniformText.spec, isText: false }, look: lookAt({ channels: asImage, i: 60 }) });
		expect(Math.hypot(atPinText[0].x - atPinImage[0].x, atPinText[0].y - atPinImage[0].y)).toBeGreaterThan(20);
		// and each is exact under its own rule on a camera that scales and shifts
		for (const [channels, isText] of [[asText, true], [asImage, false]] as const) {
			const spec = { ...nonUniformText.spec, isText };
			const result = cornerErrors({
				spec,
				overlay: nonUniformText.overlay,
				channels,
				frames: channels.frames,
				truth: similarityWorldTruth({ poses, f0: 60, host: fillHost }),
				onlyVisible: false,
			});
			expect(result.max).toBeLessThanOrEqual(0.05);
		}
	});

	test("an image with scale 1.5 x 0.8 is exact on every camera path, roll included", () => {
		const overlay = look({ x: 80, y: -120, scaleX: 1.5, scaleY: 0.8, rotate: 15 });
		for (const kind of PATHS) {
			const poses = posePath({ kind, n: N });
			const channels = build({
				solution: exactSimilaritySolution({ poses, f0: 60 }),
				host: fillHost,
				spec: IMAGE,
				overlay,
			});
			const result = cornerErrors({
				spec: IMAGE,
				overlay,
				channels,
				frames: channels.frames,
				truth: similarityWorldTruth({ poses, f0: 60, host: fillHost }),
				onlyVisible: false,
			});
			expect(result.max).toBeLessThanOrEqual(0.05);
		}
	});

	test("under a roll, text with unequal scales cannot keep its shape: the error is bounded, not zero", () => {
		const poses = posePath({ kind: "roll", n: N });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 60 }),
			host: fillHost,
			spec: nonUniformText.spec,
			overlay: nonUniformText.overlay,
		});
		const result = cornerErrors({
			spec: nonUniformText.spec,
			overlay: nonUniformText.overlay,
			channels,
			frames: channels.frames,
			truth: similarityWorldTruth({ poses, f0: 60, host: fillHost }),
			onlyVisible: false,
		});
		report({ label: "text 1.5x0.8 under a 10 degree roll", values: { "worst px@1920": result.max } });
		// diag(sx, sy) R(theta) is a three-parameter family and the scene asks for four: measured below
		expect(result.max).toBeGreaterThan(0.5);
		expect(result.max).toBeLessThanOrEqual(LIMIT_TEXT_ROLL);
	});
});

describe("scale is never smaller than the renderer's minimum", () => {
	test("a camera zooming out to 0.2 percent is held at 0.01", () => {
		const poses = zoomPath({ n: N, finalScale: 0.002 });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 0 }),
			host: fillHost,
			spec: IMAGE,
			overlay: look({ scaleX: 1.2, scaleY: 0.9 }),
		});
		const smallest = Math.min(...channels.scaleX, ...channels.scaleY);
		expect(smallest).toBeGreaterThanOrEqual(MIN_TRANSFORM_SCALE);
		expect(channels.scaleX[N - 1]).toBeCloseTo(MIN_TRANSFORM_SCALE, 12);
		// before the limit it follows the zoom exactly
		expect(channels.scaleX[10]).toBeCloseTo(1.2 * 0.002 ** (10 / (N - 1)), 9);
	});

	test("a mirrored element keeps its sign and the minimum applies to the size", () => {
		const poses = zoomPath({ n: N, finalScale: 0.002 });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 0 }),
			host: fillHost,
			spec: IMAGE,
			overlay: look({ scaleX: -1, scaleY: 1 }),
		});
		for (let i = 0; i < N; i++) {
			expect(channels.scaleX[i]).toBeLessThanOrEqual(-MIN_TRANSFORM_SCALE);
			expect(channels.scaleY[i]).toBeGreaterThanOrEqual(MIN_TRANSFORM_SCALE);
		}
	});

	test("text clamps the same way", () => {
		const poses = zoomPath({ n: N, finalScale: 0.002 });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 0 }),
			host: fillHost,
			spec: TEXT,
			overlay: look({ scaleX: 1.5, rotate: 10 }),
		});
		expect(Math.min(...channels.scaleX, ...channels.scaleY)).toBeGreaterThanOrEqual(
			MIN_TRANSFORM_SCALE,
		);
	});
});

describe("mirrored host", () => {
	test("the scene's roll appears reversed, because the picture is a mirror image", () => {
		const poses = posePath({ kind: "roll", n: N });
		const overlay = look({ x: 150, scaleX: 1, rotate: 0 });
		const plain = build({
			solution: exactSimilaritySolution({ poses, f0: 0 }),
			host: fillHost,
			spec: IMAGE,
			overlay,
		});
		const mirrored = build({
			solution: exactSimilaritySolution({ poses, f0: 0 }),
			host: mirroredHost,
			spec: IMAGE,
			overlay,
		});
		for (let i = 0; i < N; i += 7) {
			expect(mirrored.rotate[i]).toBeCloseTo(-plain.rotate[i], 6);
		}
		expect(Math.max(...plain.rotate)).toBeGreaterThan(9);
		expect(Math.min(...mirrored.rotate)).toBeLessThan(-9);
	});
});

describe("a host that flips while it is on screen", () => {
	// the picture is mirrored from frame 120 on: what the camera sees turns into its mirror image
	const flipsHost: HostFn = (seconds) =>
		seconds >= frameTimeAt(120) ? mirroredHost(seconds) : fillHost(seconds);

	test("the element flips with it and stays on the scene, images and text alike", () => {
		const poses = posePath({ kind: "combo", n: N });
		for (const name of [
			"image 600x300, scale 1.3x0.7, turned 23 degrees",
			"text with uniform scale 1.2, turned 15 degrees",
			"image mirrored by a negative scaleX, turned -17 degrees",
		]) {
			const { spec, overlay } = CASES[name];
			const channels = build({
				solution: exactSimilaritySolution({ poses, f0: 60 }),
				host: flipsHost,
				spec,
				overlay,
			});
			const result = cornerErrors({
				spec,
				overlay,
				channels,
				frames: channels.frames,
				truth: similarityWorldTruth({ poses, f0: 60, host: flipsHost }),
				onlyVisible: false,
			});
			expect(result.max).toBeLessThanOrEqual(0.05);
			// after the flip one of the scales has the other sign than the element's own
			const before = Math.sign(channels.scaleX[100]) * Math.sign(channels.scaleY[100]);
			const after = Math.sign(channels.scaleX[200]) * Math.sign(channels.scaleY[200]);
			expect(after).toBe(-before);
		}
	});
});

describe("a picture stretched wider than tall breaks the similarity (rare)", () => {
	// A stretched picture turns a roll into a shear, which no scale-and-rotate
	// element can show; the plan measured 3-5 px for the similarity path and did
	// not measure the combined fit. Measured here on the combined path: 4.3 px
	// (image 200x100) and 9.4 px (text 400x90), 0 on pan and zoom.
	const poses = posePath({ kind: "combo", n: N });
	const items: { name: string; spec: ElementSpec; overlay: Look; limit: number }[] = [
		{
			name: "image 200x100",
			spec: { rect: { left: -100, top: -50, width: 200, height: 100 }, isText: false },
			overlay: look({ scaleX: 1 }),
			limit: 9,
		},
		{
			name: "text 400x90 scale 1.2 turned 15 degrees",
			spec: TEXT,
			overlay: look({ x: 30, y: 100, scaleX: 1.2, rotate: 15 }),
			limit: 20,
		},
	];
	for (const { name, spec, overlay, limit } of items) {
		test(`${name}: the error stays where the shear puts it, no larger`, () => {
			const channels = build({
				solution: exactSimilaritySolution({ poses, f0: 60 }),
				host: stretchedHost,
				spec,
				overlay,
			});
			const result = cornerErrors({
				spec,
				overlay,
				channels,
				frames: channels.frames,
				truth: similarityWorldTruth({ poses, f0: 60, host: stretchedHost }),
				onlyVisible: false,
			});
			report({ label: `stretched host ${name}`, values: { "worst px@1920": result.max } });
			expect(result.max).toBeLessThanOrEqual(limit);
		});
	}

	test("a pan or a zoom has no shear, so it is exact even then", () => {
		for (const kind of ["pan", "zoom"] as const) {
			const path = posePath({ kind, n: N });
			const overlay = look({ x: 30, scaleX: 1.4, scaleY: 0.8, rotate: 23 });
			const channels = build({
				solution: exactSimilaritySolution({ poses: path, f0: 60 }),
				host: stretchedHost,
				spec: IMAGE,
				overlay,
			});
			const result = cornerErrors({
				spec: IMAGE,
				overlay,
				channels,
				frames: channels.frames,
				truth: similarityWorldTruth({ poses: path, f0: 60, host: stretchedHost }),
				onlyVisible: false,
			});
			expect(result.max).toBeLessThanOrEqual(0.05);
		}
	});
});

describe("frame range and timing", () => {
	test("only the asked frames are written, with their timeline times", () => {
		const poses = posePath({ kind: "pan", n: N });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 100 }),
			host: fillHost,
			spec: IMAGE,
			overlay: look({ scaleX: 1 }),
			first: 40,
			last: 130,
		});
		expect(channels.frames.length).toBe(91);
		expect(channels.frames[0]).toBe(40);
		expect(channels.frames[90]).toBe(130);
		expect(channels.times[0]).toBeCloseTo(frameTimeAt(40), 12);
		expect(channels.times[90]).toBeCloseTo(frameTimeAt(130), 12);
		for (const array of [channels.x, channels.y, channels.scaleX, channels.scaleY, channels.rotate]) {
			expect(array.length).toBe(91);
		}
		expect(channels.rotate[100 - 40]).toBeCloseTo(0, 9);
	});

	test("a single-frame range is one sample at the pin frame", () => {
		const poses = posePath({ kind: "pan", n: 20 });
		const channels = build({
			solution: exactSimilaritySolution({ poses, f0: 5 }),
			host: fillHost,
			spec: IMAGE,
			overlay: look({ x: 10, y: 20, scaleX: 2 }),
			first: 5,
			last: 5,
		});
		expect(channels.frames.length).toBe(1);
		expect(channels.x[0]).toBeCloseTo(10, 9);
		expect(channels.scaleX[0]).toBeCloseTo(2, 9);
	});

	test("the output is deterministic", () => {
		const poses = posePath({ kind: "combo", n: 100 });
		const args = {
			solution: exactSimilaritySolution({ poses, f0: 30 }),
			host: kenBurnsHost,
			spec: TEXT,
			overlay: look({ x: 5, scaleX: 1.4, rotate: 12 }),
		};
		const a = build(args);
		const b = build(args);
		expect(Array.from(a.x)).toEqual(Array.from(b.x));
		expect(Array.from(a.rotate)).toEqual(Array.from(b.rotate));
	});
});

describe("bad input is refused, not guessed", () => {
	const poses = posePath({ kind: "pan", n: 30 });
	const solution = exactSimilaritySolution({ poses, f0: 10 });
	const ok = { host: fillHost, spec: IMAGE, overlay: look({ scaleX: 1 }) };

	test("a range that does not hold the pin frame", () => {
		expect(() => build({ solution, ...ok, first: 12, last: 20 })).toThrow(RangeError);
		expect(() => build({ solution, ...ok, first: 0, last: 9 })).toThrow(RangeError);
	});

	test("a range outside the solution", () => {
		expect(() => build({ solution, ...ok, first: -1, last: 20 })).toThrow(RangeError);
		expect(() => build({ solution, ...ok, first: 0, last: 30 })).toThrow(RangeError);
	});

	test("an element box without area", () => {
		expect(() =>
			build({ solution, ...ok, spec: { rect: { left: 0, top: 0, width: 0, height: 50 }, isText: false } }),
		).toThrow(RangeError);
		expect(() =>
			build({ solution, ...ok, spec: { rect: { left: 0, top: 0, width: Number.NaN, height: 50 }, isText: true } }),
		).toThrow(RangeError);
	});

	test("an element scaled to nothing", () => {
		expect(() => build({ solution, ...ok, overlay: look({ scaleX: 0, scaleY: 1 }) })).toThrow(RangeError);
	});

	test("a host picture without size", () => {
		expect(() =>
			build({ solution, ...ok, host: () => ({ cx: 0, cy: 0, width: 0, height: 100, rotation: 0 }) }),
		).toThrow(RangeError);
	});
});

describe("a broken homography frame cannot poison the channels", () => {
	test("a map that divides by zero holds the previous sample", () => {
		const poses = posePath({ kind: "pan", n: 20 });
		const solution = exactSimilaritySolution({ poses, f0: 0 });
		const h = {
			...solution,
			model: "H" as const,
			stride: 9 as const,
			maps: new Float64Array(9 * 20),
		};
		for (let t = 0; t < 20; t++) {
			h.maps.set([1, 0, 0, 0, 1, 0, 0, 0, 1], 9 * t);
		}
		// frame 7 divides by zero everywhere
		h.maps.set([1, 0, 0, 0, 1, 0, 0, 0, 0], 9 * 7);
		const channels = build({
			solution: h,
			host: fillHost,
			spec: IMAGE,
			overlay: look({ x: 30, scaleX: 1.1, rotate: 5 }),
		});
		for (const array of [channels.x, channels.y, channels.scaleX, channels.scaleY, channels.rotate]) {
			for (const value of array) expect(Number.isFinite(value)).toBe(true);
		}
		expect(channels.x[7]).toBeCloseTo(channels.x[6], 9);
	});
});

describe("elementCorners agrees with the renderer simulation", () => {
	test("images and text, flipped, rotated, off centre", () => {
		const looks = [
			look({ x: 10, y: -20, scaleX: 1.5, scaleY: 0.8, rotate: 33 }),
			look({ x: -300, y: 120, scaleX: -0.7, scaleY: 1.2, rotate: -75 }),
			look({ x: 0, y: 0, scaleX: 0.9, scaleY: -1.1, rotate: 200 }),
		];
		for (const spec of [IMAGE, TEXT]) {
			for (const l of looks) {
				const mine = elementCorners({ bounds: spec.rect, look: l, isText: spec.isText, canvasSize: CANVAS });
				const theirs = renderedCorners({ spec, look: l });
				expect(mine.length).toBe(4);
				for (let k = 0; k < 4; k++) {
					expect(mine[k].x).toBeCloseTo(theirs[k].x, 8);
					expect(mine[k].y).toBeCloseTo(theirs[k].y, 8);
				}
			}
		}
	});

	test("maxCornerGap is the worst corner distance between two channel sets", () => {
		const poses = posePath({ kind: "combo", n: 50 });
		const solution = exactSimilaritySolution({ poses, f0: 0 });
		const a = build({ solution, host: fillHost, spec: IMAGE, overlay: look({ scaleX: 1 }) });
		const same = maxCornerGap({ a, b: a, bounds: IMAGE.rect, isText: false, canvasSize: CANVAS });
		expect(same).toBe(0);
		const shifted: CameraPinChannels = { ...a, x: a.x.map((v) => v + 3) };
		expect(maxCornerGap({ a, b: shifted, bounds: IMAGE.rect, isText: false, canvasSize: CANVAS })).toBeCloseTo(3, 9);
	});
});

// ---------------------------------------------------------------------------
// With tracked frames (the plan's measured numbers)
// ---------------------------------------------------------------------------

const TRACKED_FRAMES = 150;
const mainWorld = () => getWorld({ key: "main", seed: 1 });

describe("tracked similarity camera, hosts and pin frames (plan M3: worst 0.84 px@1920)", () => {
	// the four single-motion cameras of the tracker's own accuracy tests, 120 frames each
	const SINGLE: Record<string, SequenceOptions> = {
		pan: { kind: "pan", frameCount: 120 },
		zoom: { kind: "zoom", frameCount: 120, extra: { zoom: 1.5 } },
		rotation: { kind: "rot", frameCount: 120, extra: { deg: 10 } },
		handheld: { kind: "hand", frameCount: 120 },
	};
	const COMBINED: SequenceOptions = {
		kind: "combo",
		frameCount: TRACKED_FRAMES,
		foregrounds: FG_COMBO,
	};
	const analysisOf = ({ name, options }: { name: string; options: SequenceOptions }) =>
		cachedAnalysis({
			key: `t3-${name}`,
			make: () => analyse({ world: mainWorld(), options: { seed: 5, ...options } }),
		});

	// the plan's element sizes: 200x100 and 400x200
	const small: ElementSpec = {
		rect: { left: -100, top: -50, width: 200, height: 100 },
		isText: false,
	};
	const large: ElementSpec = {
		rect: { left: -200, top: -100, width: 400, height: 200 },
		isText: true,
	};
	const tracked: Case[] = [
		{ spec: small, overlay: look({ x: 60, y: -40, scaleX: 1.5, scaleY: 1.2, rotate: 23 }) },
		{ spec: small, overlay: look({ x: -120, y: 75, scaleX: -1.1, scaleY: 0.9, rotate: -17 }) },
		{ spec: large, overlay: look({ x: 30, y: 50, scaleX: 1, rotate: 15 }) },
	];

	function worstOver({
		analysis,
		host,
	}: {
		analysis: Analysis;
		host: HostFn;
	}): { worst: number; frames: number } {
		let worst = 0;
		let frames = 0;
		const half = Math.floor(analysis.tracks.frameCount / 2);
		for (const f0 of [0, half]) {
			const solution = solvePin({ tracks: analysis.tracks, f0, model: "S", mode: "scene" });
			for (const { spec, overlay } of tracked) {
				const channels = build({ solution, host, spec, overlay });
				const result = cornerErrors({
					spec,
					overlay,
					channels,
					frames: channels.frames,
					truth: similarityWorldTruth({ poses: analysis.truth.truth, f0, host }),
				});
				worst = Math.max(worst, result.max);
				frames += result.frames;
			}
		}
		return { worst, frames };
	}

	for (const [hostName, host] of Object.entries(HOSTS)) {
		test(`host ${hostName}: pan, zoom, rotation and hand shake within 1.5 px@1920`, () => {
			for (const [name, options] of Object.entries(SINGLE)) {
				const { worst, frames } = worstOver({ analysis: analysisOf({ name, options }), host });
				report({ label: `tracked S ${name}, host ${hostName}`, values: { "worst px@1920": worst, frames } });
				expect(frames).toBeGreaterThan(150);
				expect(worst).toBeLessThanOrEqual(1.5);
			}
		});

		test(`host ${hostName}: all four motions together (zoom 1.3, roll, shake, a moving object) within 2.5 px@1920`, () => {
			const { worst, frames } = worstOver({
				analysis: analysisOf({ name: "combined", options: COMBINED }),
				host,
			});
			report({ label: `tracked S combined, host ${hostName}`, values: { "worst px@1920": worst, frames } });
			expect(frames).toBeGreaterThan(300);
			// the tracker's own corner error on this clip is up to 0.4 px@480, 1.6 px@1920
			expect(worst).toBeLessThanOrEqual(2.5);
		});
	}
});

let homographyCache: ReturnType<typeof analyseHomography> | null = null;
/** Yaw 10 degrees at 60 degrees field of view, 240 frames: shared by the two perspective suites. */
const homographyAnalysis = () =>
	(homographyCache ??= analyseHomography({
		world: getWorld({ key: "main", seed: 1 }),
		hfovDeg: 60,
		yawMaxDeg: 10,
		pitchMaxDeg: 3,
		frameCount: 240,
	}));

describe("tracked perspective pan, yaw 10 degrees at 60 degrees field of view (plan M3)", () => {
	const analysis = homographyAnalysis;

	const small = { spec: IMAGE, overlay: look({ x: 0, y: 0, scaleX: 1 / 3, scaleY: 1 / 3 }) };
	const textLarge: Case = {
		spec: { rect: { left: -200, top: -100, width: 400, height: 200 }, isText: true },
		overlay: look({ x: 0, y: 0, scaleX: 1, rotate: 15 }),
	};
	const textBaseScale: Case = {
		spec: { rect: { left: -130, top: -65, width: 260, height: 130 }, isText: true },
		overlay: look({ x: 0, y: 0, scaleX: 1.5, scaleY: 0.8, rotate: 0 }),
	};

	function errors({
		solution,
		host,
		item,
	}: {
		solution: PinSolution;
		host: HostFn;
		item: Case;
	}) {
		const { truth } = analysis();
		const channels = build({ solution, host, spec: item.spec, overlay: item.overlay });
		return cornerErrors({
			spec: item.spec,
			overlay: item.overlay,
			channels,
			frames: channels.frames,
			truth: homographyWorldTruth({ truthPoint: truth.truthPoint, host }),
		});
	}

	test("a small image: the rotation-scale fit of H stays within 3.5 px, the similarity does not", () => {
		const { tracks } = analysis();
		const rs = errors({ solution: solvePin({ tracks, f0: 0, model: "H", mode: "scene" }), host: fillHost, item: small });
		const s = errors({ solution: solvePin({ tracks, f0: 0, model: "S", mode: "scene" }), host: fillHost, item: small });
		report({ label: "yaw 10 image 200x100", values: { "RS px@1920": rs.max, "S px@1920": s.max, frames: rs.frames } });
		expect(rs.frames).toBeGreaterThan(100);
		// the plan measured 1.5-1.7
		expect(rs.max).toBeLessThanOrEqual(3.5);
		expect(s.max).toBeGreaterThan(2 * rs.max);
	});

	test("large text turned 15 degrees stays within 12 px", () => {
		const { tracks } = analysis();
		const rs = errors({ solution: solvePin({ tracks, f0: 0, model: "H", mode: "scene" }), host: fillHost, item: textLarge });
		const s = errors({ solution: solvePin({ tracks, f0: 0, model: "S", mode: "scene" }), host: fillHost, item: textLarge });
		report({ label: "yaw 10 text 400x200 15deg", values: { "RS px@1920": rs.max, "S px@1920": s.max, frames: rs.frames } });
		expect(rs.frames).toBeGreaterThan(100);
		// the plan measured 4.1-6.6
		expect(rs.max).toBeLessThanOrEqual(12);
		expect(s.max).toBeGreaterThan(2 * rs.max);
	});

	test("text with base scale 1.5 x 0.8 (scale after rotate) stays within 12 px, in three hosts", () => {
		const { tracks } = analysis();
		const solution = solvePin({ tracks, f0: 0, model: "H", mode: "scene" });
		for (const host of [fillHost, shiftedHost, kenBurnsHost]) {
			const rs = errors({ solution, host, item: textBaseScale });
			report({ label: "yaw 10 text 1.5x0.8", values: { "RS px@1920": rs.max, frames: rs.frames } });
			expect(rs.frames).toBeGreaterThan(100);
			// the plan measured 8.4 for the combined fit
			expect(rs.max).toBeLessThanOrEqual(12);
		}
	});

	test("the residual gate opens, and the model the pin uses is H for this camera", () => {
		const { tracks } = analysis();
		const similarity = solvePin({ tracks, f0: 0, model: "S", mode: "scene" });
		expect(perspectiveSuspected({ solution: similarity }).suspected).toBe(true);
		const homography = solvePin({ tracks, f0: 0, model: "H", mode: "scene" });
		const gap = maxCornerGap({
			a: build({ solution: similarity, host: fillHost, spec: small.spec, overlay: small.overlay }),
			b: build({ solution: homography, host: fillHost, spec: small.spec, overlay: small.overlay }),
			bounds: small.spec.rect,
			isText: false,
			canvasSize: CANVAS,
		});
		// the plan's rule: more than 2 px@480 apart at the element's corners picks H
		expect(gap).toBeGreaterThan(2 * CANVAS_PER_FRAME_PX);
	});
});

describe("exact homography maps: only the rotation-scale family limits the result", () => {
	test("a 200x100 image and a 400x200 text, with the conversion free of tracking error", () => {
		const { truth } = homographyAnalysis();
		const solution = exactHomographySolution({ truthPoint: truth.truthPoint, frameCount: truth.frameCount });
		const items: Case[] = [
			{ spec: IMAGE, overlay: look({ scaleX: 1 / 3, scaleY: 1 / 3 }) },
			{
				spec: { rect: { left: -200, top: -100, width: 400, height: 200 }, isText: true },
				overlay: look({ scaleX: 1, rotate: 15 }),
			},
		];
		const limits = [3, 8];
		items.forEach((item, index) => {
			for (const host of [fillHost, mirroredHost]) {
				const channels = build({ solution, host, spec: item.spec, overlay: item.overlay });
				const result = cornerErrors({
					spec: item.spec,
					overlay: item.overlay,
					channels,
					frames: channels.frames,
					truth: homographyWorldTruth({ truthPoint: truth.truthPoint, host }),
				});
				report({ label: `exact H item ${index}`, values: { "px@1920": result.max, frames: result.frames } });
				expect(result.frames).toBeGreaterThan(100);
				expect(result.max).toBeLessThanOrEqual(limits[index]);
			}
		});
	});
});

describe("lookAt helper used by the other tests", () => {
	test("reads one sample as a look", () => {
		const l = lookAt({
			channels: { x: [1, 2], y: [3, 4], scaleX: [5, 6], scaleY: [7, 8], rotate: [9, 10] },
			i: 1,
		});
		expect(l).toEqual({ position: { x: 2, y: 4 }, scaleX: 6, scaleY: 8, rotate: 10 });
		expect(FRAME.w).toBe(480);
	});
});
