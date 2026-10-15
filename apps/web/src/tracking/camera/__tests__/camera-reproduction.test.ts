/**
 * Reproduces the numbers of the plan (`Plans/camera-tracking-v2.md`, tables M1
 * and M4 and the seed sweep) at the prototype's own sizes (300 frames, 900 for
 * the 30 s clip) and with the prototype's exact noise stream, twice:
 *
 *  - with the plan's own seeding (half the room per pass, scan order, 10 px
 *    margin): it must come out the same, errors within 20 percent of the plan
 *    (a hair of absolute slack for the smallest) and counts equal;
 *  - with the production defaults (all the room, strongest first, a margin the
 *    coarsest level can follow): no error may be worse than 1.2 times the plan.
 *    Being better is not a deviation.
 *
 * Slow (a few minutes), so it only runs with `CAMTRACK_FULL=1`; the everyday
 * suite checks the same quantities against thresholds of about twice the
 * measured values on shorter clips.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { SequenceOptions } from "../camera-synth";
import { classifyPin } from "../classify";
import { mapPoint, solvePin } from "../solve-pin";
import type { TrackerOptions } from "../tracker";
import {
	analyse as analyseWith,
	analyseHomography as analyseHomographyWith,
	compareModelsOnBox,
	evaluatePins,
	FG_COMBO,
	FG_LONG,
	getWorld,
	releaseCaches,
	standardPins,
	type Analysis,
	type PinSpec,
	type WorstOfPins,
} from "./camera-fixtures";

afterAll(releaseCaches);

const full = process.env.CAMTRACK_FULL === "1" ? describe : describe.skip;

const mainWorld = () => getWorld({ key: "main", seed: 1 });

/** The seeding the plan's numbers were measured with. */
const PLAN_PROFILE: Partial<TrackerOptions> = {
	margin: 10,
	seedShare: 0.5,
	budgetOrder: "first",
	maxFeatures: 110,
};

/**
 * Checks where the production defaults come out worse than the plan's seeding
 * on the plan's own clips, measured at full size. They are kept as
 * `test.failing`: green while the difference stands, red the day it is gone.
 *
 * The seed sweep used to be one of them (1.16 px and 106 frames over 1 px
 * against 0.61 and 0): a few frames after the pin, features on a slowly moving
 * object were still inside the Tukey cutoff, the first fits leaned towards
 * them and the first re-anchoring locked that in. `solvePin` now looks ahead
 * from the pin frame (`lookahead`) and leaves such features out (0.41 px, 0).
 *
 * The rest have other causes:
 *  - blur 6 px/frame (0.26 against 0.18) and texture 0.25 (0.89 against 0.64):
 *    the tracks drift as a random walk and every re-anchoring keeps the drift
 *    of its frame. Over 8 noise seeds of the same clips the two seedings come
 *    out alike (blur: mean 0.245 against 0.250, worst 0.31 against 0.35;
 *    texture: 0.76 against 0.71, worst 1.01 against 0.92); seed 5 happens to
 *    be a good draw for the plan's seeding.
 *  - classification (5 of 71 false alarms against 3): the scene solution is
 *    right there (within 0.005 px/frame of the truth); with all the room seeded
 *    the pins 20 to 30 px from a moving disk have object features among their
 *    nearest long-lived tracks, where the plan's seeding has too few features
 *    and the classifier stays quiet.
 *  - two objects (0.32 against 0.21): the pin on frame 100 re-anchors every 25
 *    to 35 frames and collects track drift on the way. Looking ahead from every
 *    re-anchoring as well fixes it (0.21) but makes the plan's seeding 0.49
 *    there, because the support the decay is measured against no longer counts
 *    the moving features and the anchors are kept longer.
 */
const KNOWN_WORSE_WITH_DEFAULTS = new Set([
	"two objects r=40 + r=60",
	"blur 6 px/frame, shutter 1",
	"classification: 12 of 12 objects found, 3 of 71 background pins wrongly",
	"low texture: 93 / 23 / 15 / 9 live features at 0.5 / 0.25 / 0.12 / 0.06 of the detail",
]);

interface Profile {
	name: string;
	/** The plan's own seeding reproduces its numbers; the defaults may only be better. */
	exact: boolean;
	trackerOptions: Partial<TrackerOptions> | undefined;
}

const PROFILES: Profile[] = [
	{ name: "the plan's seeding", exact: true, trackerOptions: PLAN_PROFILE },
	{ name: "production defaults", exact: false, trackerOptions: undefined },
];

/** `analyse` and `analyseHomography` with the profile's tracker options, for the tests of one profile. */
function forProfiles({
	title,
	define,
}: {
	title: string;
	define: (context: {
		profile: Profile;
		test: typeof test;
		analyse: (args: Omit<Parameters<typeof analyseWith>[0], "trackerOptions">) => Analysis;
		analyseHomography: (
			args: Omit<Parameters<typeof analyseHomographyWith>[0], "trackerOptions">,
		) => ReturnType<typeof analyseHomographyWith>;
	}) => void;
}) {
	for (const profile of PROFILES) {
		full(`${title} [${profile.name}] (CAMTRACK_FULL=1)`, () =>
			define({
				profile,
				test: Object.assign(
					(name: string, fn: () => void) =>
						!profile.exact && KNOWN_WORSE_WITH_DEFAULTS.has(name) ? test.failing(name, fn) : test(name, fn),
					test,
				),
				analyse: (args) => analyseWith({ ...args, trackerOptions: profile.trackerOptions }),
				analyseHomography: (args) => analyseHomographyWith({ ...args, trackerOptions: profile.trackerOptions }),
			}),
		);
	}
}

function solveAll({ analysis, pins }: { analysis: Analysis; pins: PinSpec[] }): WorstOfPins {
	return evaluatePins({
		analysis,
		pins,
		solve: (spec) => solvePin({ tracks: analysis.tracks, f0: spec.f0, model: "S", mode: "scene" }),
	});
}

/** An error may be up to 1.2 times the plan's (or the plan's plus 0.03 px for the smallest); less is better. */
function atMost({ got, plan }: { got: number; plan: number }) {
	expect(got).toBeLessThanOrEqual(Math.max(1.2 * plan, plan + 0.03));
}

/** Within 20 percent of the plan's value, or 0.03 absolute, either way: for counts and other numbers that are not errors. */
function close({ got, plan }: { got: number; plan: number }) {
	expect(Math.abs(got - plan)).toBeLessThanOrEqual(Math.max(0.2 * plan, 0.03));
}

interface M1Row {
	name: string;
	options: SequenceOptions;
	posRms: number;
	posMax: number;
	cornerMax: number;
	scaleMaxPct: number;
	rotMaxDeg: number;
	drift: number;
}

const M1: M1Row[] = [
	{ name: "pan 2 px/frame", options: { kind: "pan", frameCount: 300 }, posRms: 0.04, posMax: 0.1, cornerMax: 0.13, scaleMaxPct: 0.05, rotMaxDeg: 0.03, drift: 0.06 },
	{ name: "zoom 1 to 1.5x", options: { kind: "zoom", frameCount: 300, extra: { zoom: 1.5 } }, posRms: 0.09, posMax: 0.26, cornerMax: 0.31, scaleMaxPct: 0.07, rotMaxDeg: 0.04, drift: 0.24 },
	{ name: "rotation +-10 deg", options: { kind: "rot", frameCount: 300, extra: { deg: 10 } }, posRms: 0.07, posMax: 0.18, cornerMax: 0.24, scaleMaxPct: 0.06, rotMaxDeg: 0.06, drift: 0.17 },
	{ name: "handheld", options: { kind: "hand", frameCount: 300 }, posRms: 0.07, posMax: 0.27, cornerMax: 0.33, scaleMaxPct: 0.07, rotMaxDeg: 0.06, drift: 0.26 },
	{ name: "combo + object + noise", options: { kind: "combo", frameCount: 300, foregrounds: FG_COMBO }, posRms: 0.1, posMax: 0.29, cornerMax: 0.35, scaleMaxPct: 0.1, rotMaxDeg: 0.07, drift: 0.3 },
	{ name: "30 s", options: { kind: "long", frameCount: 900, foregrounds: FG_LONG }, posRms: 0.1, posMax: 0.36, cornerMax: 0.41, scaleMaxPct: 0.16, rotMaxDeg: 0.07, drift: 0.31 },
];

forProfiles({ title: "plan table M1 at the prototype sizes", define: ({ analyse, test }) => {
	for (const row of M1) {
		test(`${row.name}`, () => {
			const analysis = analyse({
				world: mainWorld(),
				options: { seed: 5, noiseModel: "exact", ...row.options },
			});
			const worst = solveAll({ analysis, pins: standardPins({ frameCount: row.options.frameCount }) });
			console.log(
				`M1 ${row.name}: pos rms ${worst.posRms.toFixed(2)} max ${worst.posMax.toFixed(2)} | corner max ${worst.cornerMax.toFixed(2)} | scale ${worst.scaleMaxPct.toFixed(2)} % | rot ${worst.rotMaxDeg.toFixed(2)} deg | drift ${worst.drift.toFixed(2)}`,
			);
			atMost({ got: worst.posRms, plan: row.posRms });
			atMost({ got: worst.posMax, plan: row.posMax });
			atMost({ got: worst.cornerMax, plan: row.cornerMax });
			atMost({ got: worst.scaleMaxPct, plan: row.scaleMaxPct });
			atMost({ got: worst.rotMaxDeg, plan: row.rotMaxDeg });
			atMost({ got: worst.drift, plan: row.drift });
		});
	}
} });

interface M4Row {
	name: string;
	options: SequenceOptions;
	pins: PinSpec[];
	cornerMax: number;
}

const CENTRE: PinSpec[] = [
	{ f0: 0, pin: { x: 240, y: 135 } },
	{ f0: 0, pin: { x: 120, y: 180 } },
];
const RIGHT: PinSpec[] = [
	{ f0: 0, pin: { x: 400, y: 135 } },
	{ f0: 0, pin: { x: 300, y: 80 } },
];

const M4: M4Row[] = [
	{ name: "fast pan 32 px/frame", options: { kind: "fastpan", frameCount: 90, extra: { speed: 32 } }, pins: RIGHT, cornerMax: 0.09 },
	{ name: "blur 20 px/frame, shutter 0.5", options: { kind: "fastpan", frameCount: 60, blur: 0.5, extra: { speed: 20 } }, pins: RIGHT, cornerMax: 0.47 },
	{ name: "noise sigma 6", options: { kind: "hand", frameCount: 300, noise: 6 }, pins: CENTRE, cornerMax: 0.78 },
	{ name: "r=70 object crosses the pin", options: { kind: "hand", frameCount: 200, foregrounds: [{ x0: 20, y0: 135, vx: 3.2, vy: 0, radius: 70 }] }, pins: CENTRE, cornerMax: 0.22 },
	{
		name: "two objects r=40 + r=60",
		options: { kind: "combo", frameCount: 300, seed: 11, foregrounds: [{ x0: 40, y0: 50, vx: 1.4, vy: 0.6, radius: 40 }, { x0: 440, y0: 220, vx: -1.2, vy: -0.5, radius: 60 }] },
		pins: [...CENTRE, { f0: 100, pin: { x: 300, y: 90 } }],
		cornerMax: 0.21,
	},
	{ name: "fast pan 4 px/frame", options: { kind: "fastpan", frameCount: 90, extra: { speed: 4 } }, pins: RIGHT, cornerMax: 0.14 },
	{ name: "fast pan 16 px/frame", options: { kind: "fastpan", frameCount: 90, extra: { speed: 16 } }, pins: RIGHT, cornerMax: 0.07 },
	{ name: "fast pan 24 px/frame", options: { kind: "fastpan", frameCount: 90, extra: { speed: 24 } }, pins: RIGHT, cornerMax: 0.07 },
	{ name: "blur 3 px/frame, shutter 1", options: { kind: "fastpan", frameCount: 60, blur: 1, extra: { speed: 3 } }, pins: RIGHT, cornerMax: 0.15 },
	{ name: "blur 6 px/frame, shutter 1", options: { kind: "fastpan", frameCount: 60, blur: 1, extra: { speed: 6 } }, pins: RIGHT, cornerMax: 0.18 },
	{ name: "blur 12 px/frame, shutter 0.5", options: { kind: "fastpan", frameCount: 60, blur: 0.5, extra: { speed: 12 } }, pins: RIGHT, cornerMax: 0.2 },
	{ name: "zoom in 2.0x", options: { kind: "zoom", frameCount: 300, extra: { zoom: 2 } }, pins: CENTRE, cornerMax: 0.26 },
	{ name: "zoom out 1.6x", options: { kind: "zoomout", frameCount: 300, extra: { zoom: 1.6 } }, pins: CENTRE, cornerMax: 0.17 },
	{ name: "rotation +-25 deg", options: { kind: "rot", frameCount: 300, extra: { deg: 25 } }, pins: CENTRE, cornerMax: 0.27 },
	{ name: "rotation +-45 deg", options: { kind: "rot", frameCount: 300, extra: { deg: 45 } }, pins: CENTRE, cornerMax: 0.62 },
	{
		name: "flash + exposure step",
		options: { kind: "hand", frameCount: 300, exposure: [{ t0: 150, t1: 300, gain: 1.25, offset: 15 }, { t0: 60, t1: 62, gain: 1.6, offset: 30 }] },
		pins: CENTRE,
		cornerMax: 0.17,
	},
];

forProfiles({ title: "plan table M4 at the prototype sizes", define: ({ analyse, test }) => {
	for (const row of M4) {
		test(row.name, () => {
			const analysis = analyse({
				world: mainWorld(),
				options: { seed: 5, noiseModel: "exact", ...row.options },
			});
			const worst = solveAll({ analysis, pins: row.pins });
			console.log(`M4 ${row.name}: corner max ${worst.cornerMax.toFixed(2)}`);
			atMost({ got: worst.cornerMax, plan: row.cornerMax });
		});
	}
} });

forProfiles({ title: "seed sweep at the prototype sizes", define: ({ analyse, test }) => {
	test("9 sequences x 4 pins: worst corner 0.61 px, none over 1 px", () => {
		const kinds = ["combo", "hand", "zoom", "rot", "combo", "long", "combo", "pan", "combo"] as const;
		let worst = 0;
		let over1px = 0;
		let rows = 0;
		for (let i = 0; i < 9; i++) {
			const rr = (k: number) => ((i * 7919 + k * 104729) % 1000) / 1000;
			const objects = i % 3 === 0 ? 2 : 1;
			const options: SequenceOptions = {
				kind: kinds[i],
				frameCount: kinds[i] === "long" ? 600 : 300,
				seed: 100 + i,
				noiseModel: "exact",
				extra: kinds[i] === "zoom" ? { zoom: 1.6 } : {},
				foregrounds: Array.from({ length: objects }, (_, j) => ({
					x0: 30 + rr(j) * 380,
					y0: 30 + rr(j + 5) * 200,
					vx: (rr(j + 9) - 0.5) * 2.4,
					vy: (rr(j + 13) - 0.5) * 1.2,
					radius: 30 + Math.floor(rr(j + 17) * 40),
					ax: 30 * rr(j + 21),
					ay: 25 * rr(j + 25),
				})),
			};
			const analysis = analyse({ world: getWorld({ key: `sweep${i % 3}`, seed: (i % 3) * 13 + 14 }), options });
			const result = solveAll({
				analysis,
				pins: [
					{ f0: 0, pin: { x: 240, y: 135 } },
					{ f0: 0, pin: { x: 150, y: 190 } },
					{ f0: Math.floor(options.frameCount / 2), pin: { x: 320, y: 100 } },
					{ f0: Math.floor(options.frameCount / 3), pin: { x: 200, y: 80 } },
				],
			});
			worst = Math.max(worst, result.cornerMax);
			over1px += result.over1px;
			rows += result.rows;
		}
		console.log(`sweep: ${rows} frame-pin samples, worst corner ${worst.toFixed(2)}, over 1 px ${over1px}`);
		atMost({ got: worst, plan: 0.61 });
		expect(over1px).toBe(0);
		// the plan counted 9093 samples; the same clips, so the same count
		expect(Math.abs(rows - 9093) / 9093).toBeLessThan(0.05);
	});
} });

forProfiles({ title: "classification, cuts, noise, texture, perspective", define: ({ profile, analyse, analyseHomography, test }) => {
	test("classification: 12 of 12 objects found, 3 of 71 background pins wrongly", () => {
		const worlds = [getWorld({ key: "main", seed: 1 }), getWorld({ key: "w14", seed: 14 })];
		let objects = 0;
		let found = 0;
		let background = 0;
		let falseAlarms = 0;
		for (let i = 0; i < 12; i++) {
			const radius = 28 + (i % 3) * 12;
			const analysis = analyse({
				world: worlds[i % 2],
				options: {
					kind: (["static", "hand", "pan", "combo"] as const)[i % 4],
					frameCount: 240,
					seed: 300 + i,
					noiseModel: "exact",
					foregrounds: [{ x0: 100 + 30 * (i % 4), y0: 90 + 10 * (i % 3), vx: 0.7 + 0.15 * (i % 3), vy: 0.3, ax: 30, ay: 20, radius }],
				},
			});
			const disk = (f: number) => analysis.truth.foregroundTruth[f][0];
			const pins: [boolean, number, { x: number; y: number }][] = [[true, 0, { x: disk(0).x, y: disk(0).y }]];
			for (const [f0, pin] of [
				[0, { x: 380, y: 200 }],
				[0, { x: 60, y: 220 }],
				[60, { x: disk(60).x + 60, y: disk(60).y + 10 }],
				[0, { x: 240, y: 135 }],
				[30, { x: 300, y: 60 }],
				[30, { x: 150, y: 210 }],
			] as const) {
				if (Math.hypot(pin.x - disk(f0).x, pin.y - disk(f0).y) < radius + 8) continue;
				if (pin.x < 20 || pin.x > 460 || pin.y < 20 || pin.y > 250) continue;
				pins.push([false, f0, pin]);
			}
			for (const [isObject, f0, pin] of pins) {
				const solution = solvePin({ tracks: analysis.tracks, f0, model: "S", mode: "scene" });
				const verdict = classifyPin({ tracks: analysis.tracks, solution, pin }).isObject;
				if (isObject) {
					objects++;
					if (verdict) found++;
				} else {
					background++;
					if (verdict) falseAlarms++;
				}
			}
		}
		console.log(`classification: objects ${found}/${objects}, background false alarms ${falseAlarms}/${background}`);
		// the plan: 12 of 12 found, 3 of 71 background pins wrongly (4 percent); a bound, not a count
		expect(objects).toBe(12);
		expect(found).toBe(12);
		expect(background).toBeGreaterThan(65);
		expect(background).toBeLessThan(80);
		expect(falseAlarms / background).toBeLessThanOrEqual(0.06);
	});

	test("scene cuts: frame 150 and frame 100, thumbnail NCC about -0.04 and 0.08", () => {
		const other = getWorld({ key: "w9", seed: 9 });
		const hand = analyse({
			world: getWorld({ key: "main", seed: 1 }),
			options: { kind: "hand", frameCount: 300, seed: 5, noiseModel: "exact", cutAt: 150, worldAfterCut: other },
		});
		const pan = analyse({
			world: getWorld({ key: "main", seed: 1 }),
			options: { kind: "pan", frameCount: 200, seed: 5, noiseModel: "exact", cutAt: 100, worldAfterCut: other },
		});
		console.log(`cuts: hand ${JSON.stringify(hand.tracks.cuts)} ncc ${hand.tracks.stats.cutNcc[0]?.ncc.toFixed(2)}, pan ${JSON.stringify(pan.tracks.cuts)} ncc ${pan.tracks.stats.cutNcc[0]?.ncc.toFixed(2)}`);
		expect(hand.tracks.cuts).toEqual([150]);
		expect(pan.tracks.cuts).toEqual([100]);
		expect(Math.abs(hand.tracks.stats.cutNcc[0].ncc - -0.04)).toBeLessThan(0.05);
		expect(Math.abs(pan.tracks.stats.cutNcc[0].ncc - 0.08)).toBeLessThan(0.05);
	});

	test("noise sigma 12: about 47 features, error about 4.6 px", () => {
		const analysis = analyse({
			world: getWorld({ key: "main", seed: 1 }),
			options: { seed: 5, noiseModel: "exact", kind: "hand", frameCount: 300, noise: 12 },
		});
		const worst = solveAll({ analysis, pins: CENTRE });
		let live = 0;
		for (let f = 0; f < 300; f++) live += analysis.tracks.liveOffsets[f + 1] - analysis.tracks.liveOffsets[f];
		console.log(`noise 12: live ${(live / 300).toFixed(0)}, corner max ${worst.cornerMax.toFixed(2)}`);
		if (profile.exact) close({ got: live / 300, plan: 47 });
		atMost({ got: worst.cornerMax, plan: 4.58 });
	});

	test("no camera motion: 0.08 px, 0.03 percent, 0.016 degrees", () => {
		const analysis = analyse({
			world: getWorld({ key: "main", seed: 1 }),
			options: { seed: 5, noiseModel: "exact", kind: "static", frameCount: 120 },
		});
		const solution = solvePin({ tracks: analysis.tracks, f0: 0, model: "S", mode: "scene" });
		let shift = 0;
		let scale = 0;
		let rotation = 0;
		for (let t = 0; t < 120; t++) {
			const p = mapPoint({ solution, t, x: 240, y: 135 });
			shift = Math.max(shift, Math.hypot(p.x - 240, p.y - 135));
			const ar = solution.maps[4 * t];
			const ai = solution.maps[4 * t + 1];
			scale = Math.max(scale, Math.abs(Math.hypot(ar, ai) - 1) * 100);
			rotation = Math.max(rotation, (Math.abs(Math.atan2(ai, ar)) * 180) / Math.PI);
		}
		console.log(`static: shift ${shift.toFixed(2)} px, scale ${scale.toFixed(3)} %, rotation ${rotation.toFixed(3)} deg`);
		atMost({ got: shift, plan: 0.08 });
		atMost({ got: scale, plan: 0.032 });
		atMost({ got: rotation, plan: 0.019 });
	});

	test("low texture: 93 / 23 / 15 / 9 live features at 0.5 / 0.25 / 0.12 / 0.06 of the detail", () => {
		const plan = [
			{ texture: 0.5, live: 93, corner: 0.84 },
			{ texture: 0.25, live: 23, corner: 0.64 },
			{ texture: 0.12, live: 15, corner: 0.63 },
			{ texture: 0.06, live: 9, corner: -1 },
		];
		for (const row of plan) {
			const world = getWorld({ key: `tex${row.texture}`, seed: 3, texture: row.texture, shapes: 700 });
			const analysis = analyse({ world, options: { seed: 5, noiseModel: "exact", kind: "hand", frameCount: 300 } });
			let live = 0;
			for (let f = 0; f < 300; f++) live += analysis.tracks.liveOffsets[f + 1] - analysis.tracks.liveOffsets[f];
			const worst = solveAll({ analysis, pins: CENTRE });
			console.log(`texture ${row.texture}: live ${(live / 300).toFixed(0)}, corner max ${worst.cornerMax.toFixed(2)}, solved ${worst.solved}/${worst.rows}`);
			if (profile.exact) close({ got: live / 300, plan: row.live });
			if (row.corner >= 0) atMost({ got: worst.cornerMax, plan: row.corner });
			else expect(worst.solved / worst.rows).toBeLessThan(0.01);
		}
	});

	test("perspective, yaw 10 degrees at 60 degrees field of view: 1.26 / 4.15 at the centre, 1.89 / 27.3 at the edge", () => {
		const { tracks, truth } = analyseHomography({
			world: getWorld({ key: "main", seed: 1 }),
			hfovDeg: 60,
			yawMaxDeg: 10,
			pitchMaxDeg: 3,
			frameCount: 240,
			noiseModel: "exact",
		});
		const similarity = solvePin({ tracks, f0: 0, model: "S", mode: "scene" });
		const homography = solvePin({ tracks, f0: 0, model: "H", mode: "scene" });
		for (const row of [
			{ pin: { x: 240, y: 135 }, rs: 1.26, s: 4.15, disagreement: 3.43 },
			{ pin: { x: 410, y: 135 }, rs: 1.89, s: 27.32, disagreement: 26.1 },
		]) {
			const r = compareModelsOnBox({
				similarity,
				homography,
				pin: row.pin,
				truthMapAt: ({ t, x, y }) => truth.truthPoint({ t, x, y }),
			});
			console.log(`perspective pin ${row.pin.x}: RS ${r.rotationScaleError.toFixed(2)} S ${r.similarityError.toFixed(2)} disagreement ${r.disagreement.toFixed(2)} full H ${r.homographyError.toFixed(2)}`);
			atMost({ got: r.rotationScaleError, plan: row.rs });
			if (profile.exact) {
				// the similarity's error is the deficiency this pan shows: it has to stay as large as the plan found
				close({ got: r.similarityError, plan: row.s });
				close({ got: r.disagreement, plan: row.disagreement });
			} else {
				expect(r.similarityError).toBeGreaterThanOrEqual(3);
				expect(r.disagreement).toBeGreaterThan(2);
			}
		}
	});
} });
