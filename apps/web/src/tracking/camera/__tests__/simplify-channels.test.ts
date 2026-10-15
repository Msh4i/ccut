/**
 * Fewer keyframes for the same look (slice T3, plan decision 5 and table M6).
 * The budget is B = 0.5 canvas px at the element's corners, shared out as
 * x and y B/3 each, scale B/(6R) relative, rotation B/(6R) radians, with R the
 * element's half diagonal. Every sample must stay within it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { solvePin } from "../solve-pin";
import {
	CAMERA_PIN_BUDGET,
	pinTolerances,
	simplifyCameraPinChannels,
	type PinKey,
	type SimplifiedPinChannels,
} from "../simplify-channels";
import {
	buildCameraPinChannels,
	maxCornerGap,
	type CameraPinChannels,
	type CameraPinValues,
	type LocalRect,
} from "../to-channels";
import {
	analyse,
	cachedAnalysis,
	getWorld,
	releaseCaches,
	report,
} from "./camera-fixtures";
import {
	CANVAS,
	exactSimilaritySolution,
	fillHost,
	FRAME,
	frameTimeAt,
	spinPath,
} from "./pin-fixtures";

afterAll(releaseCaches);

const CHANNELS = ["x", "y", "scaleX", "scaleY", "rotate"] as const;
type ChannelName = (typeof CHANNELS)[number];

/** What a linear keyframe channel plays back at `time`. */
function playback({ keys, time }: { keys: PinKey[]; time: number }): number {
	if (time <= keys[0].time) return keys[0].value;
	for (let k = 0; k < keys.length - 1; k++) {
		const a = keys[k];
		const b = keys[k + 1];
		if (time <= b.time) {
			return a.value + ((b.value - a.value) * (time - a.time)) / (b.time - a.time);
		}
	}
	return keys[keys.length - 1].value;
}

function playedValues({
	simplified,
	times,
}: {
	simplified: SimplifiedPinChannels;
	times: ArrayLike<number>;
}): CameraPinValues {
	const play = (name: ChannelName) =>
		Float64Array.from({ length: times.length }, (_, i) => playback({ keys: simplified[name], time: times[i] }));
	return {
		x: play("x"),
		y: play("y"),
		scaleX: play("scaleX"),
		scaleY: play("scaleY"),
		rotate: play("rotate"),
	};
}

const BOX: LocalRect = { left: -80, top: -60, width: 160, height: 120 };

function constantChannels({ count = 21, scale = 1 }: { count?: number; scale?: number } = {}): CameraPinChannels {
	return {
		frames: Int32Array.from({ length: count }, (_, i) => i),
		times: Float64Array.from({ length: count }, (_, i) => i / 30),
		x: new Float64Array(count).fill(100),
		y: new Float64Array(count).fill(-50),
		scaleX: new Float64Array(count).fill(scale),
		scaleY: new Float64Array(count).fill(scale),
		rotate: new Float64Array(count).fill(0),
	};
}

/** A tent of height `peak` in the middle of a flat channel: a straight line from either end, so only the top can be dropped or kept. */
function withTent({
	channels,
	name,
	peak,
}: {
	channels: CameraPinChannels;
	name: ChannelName;
	peak: number;
}): CameraPinChannels {
	const n = channels.frames.length;
	const mid = (n - 1) / 2;
	const values = Float64Array.from(channels[name], (v, i) => v + peak * (1 - Math.abs(i - mid) / mid));
	return { ...channels, [name]: values };
}

describe("the budget is shared out as the plan says", () => {
	test("B is half a canvas pixel", () => {
		expect(CAMERA_PIN_BUDGET).toBe(0.5);
	});

	test("tolerances for an element of half diagonal 100 px: 1/6 px, 8.3e-4 relative, 8.3e-4 rad", () => {
		// 160 x 120 at scale 1 has a half diagonal of 100
		const tolerance = pinTolerances({ channels: constantChannels(), bounds: BOX });
		expect(tolerance.radius).toBeCloseTo(100, 9);
		expect(tolerance.position).toBeCloseTo(0.5 / 3, 12);
		expect(tolerance.scale).toBeCloseTo(0.5 / 600, 12);
		expect(tolerance.rotationDeg).toBeCloseTo(((0.5 / 600) * 180) / Math.PI, 12);
	});

	test("the radius is the largest the element gets: scale and size count", () => {
		const big = pinTolerances({ channels: constantChannels({ scale: 2 }), bounds: BOX });
		expect(big.radius).toBeCloseTo(200, 9);
		const mixed = constantChannels();
		mixed.scaleX[7] = 3;
		mixed.scaleY[7] = -0.5;
		const tolerance = pinTolerances({ channels: mixed, bounds: BOX });
		// 0.5 * hypot(160 * 3, 120 * 0.5) at frame 7 is the largest
		expect(tolerance.radius).toBeCloseTo(0.5 * Math.hypot(480, 60), 9);
	});

	test("a custom budget scales all of them", () => {
		const one = pinTolerances({ channels: constantChannels(), bounds: BOX, budget: 1 });
		expect(one.position).toBeCloseTo(1 / 3, 12);
		expect(one.scale).toBeCloseTo(1 / 600, 12);
	});

	// each channel on its own, at the edge of its tolerance (R = 100)
	const edges: { name: ChannelName; inside: number; outside: number; what: string }[] = [
		{ name: "x", inside: 0.16, outside: 0.18, what: "x: 1/6 px" },
		{ name: "y", inside: 0.16, outside: 0.18, what: "y: 1/6 px" },
		{ name: "scaleX", inside: 0.0008, outside: 0.00087, what: "scaleX: 8.3e-4 relative" },
		{ name: "scaleY", inside: 0.0008, outside: 0.00087, what: "scaleY: 8.3e-4 relative" },
		// 0.5 / 600 rad is 0.0477 degrees
		{ name: "rotate", inside: 0.045, outside: 0.05, what: "rotate: 8.3e-4 rad" },
	];
	for (const { name, inside, outside, what } of edges) {
		test(`${what}: a peak just inside is dropped, just outside is kept`, () => {
			const dropped = simplifyCameraPinChannels({
				channels: withTent({ channels: constantChannels(), name, peak: inside }),
				bounds: BOX,
			});
			const kept = simplifyCameraPinChannels({
				channels: withTent({ channels: constantChannels(), name, peak: outside }),
				bounds: BOX,
			});
			expect(dropped[name]).toHaveLength(2);
			expect(kept[name]).toHaveLength(3);
			// the other channels stay flat, each simplified on its own
			for (const other of CHANNELS) {
				if (other !== name) expect(kept[other]).toHaveLength(2);
			}
		});
	}

	for (const name of ["scaleX", "scaleY"] as const) {
		test(`${name}: the tolerance is a share of the scale, twice the scale allows twice the bump`, () => {
			// R = 200 at scale 2: the tolerance is 0.5 / 1200 = 4.17e-4 of the value, 8.3e-4 absolute
			const flatTwo = constantChannels({ scale: 2 });
			const inside = withTent({ channels: flatTwo, name, peak: 0.0006 });
			const outside = withTent({ channels: flatTwo, name, peak: 0.001 });
			expect(simplifyCameraPinChannels({ channels: inside, bounds: BOX })[name]).toHaveLength(2);
			expect(simplifyCameraPinChannels({ channels: outside, bounds: BOX })[name]).toHaveLength(3);
		});
	}

	test("a larger element tightens the angle tolerance (R = 200: 0.0239 degrees)", () => {
		const inputs = withTent({ channels: constantChannels({ scale: 2 }), name: "rotate", peak: 0.045 });
		expect(simplifyCameraPinChannels({ channels: inputs, bounds: BOX }).rotate).toHaveLength(3);
		const small = withTent({ channels: constantChannels({ scale: 1 }), name: "rotate", peak: 0.045 });
		expect(simplifyCameraPinChannels({ channels: small, bounds: BOX }).rotate).toHaveLength(2);
	});
});

describe("shape of the result", () => {
	test("keys carry the sample times, ascending, first and last kept", () => {
		const channels = withTent({ channels: constantChannels({ count: 41 }), name: "x", peak: 3 });
		const result = simplifyCameraPinChannels({ channels, bounds: BOX });
		for (const name of CHANNELS) {
			const keys = result[name];
			expect(keys[0].time).toBe(channels.times[0]);
			expect(keys[keys.length - 1].time).toBe(channels.times[40]);
			for (let k = 1; k < keys.length; k++) expect(keys[k].time).toBeGreaterThan(keys[k - 1].time);
			for (const key of keys) {
				const index = Array.from(channels.times).indexOf(key.time);
				expect(index).toBeGreaterThanOrEqual(0);
				expect(key.value).toBe(channels[name][index]);
			}
		}
	});

	test("a constant channel is two keys, one sample is one key", () => {
		const flat = simplifyCameraPinChannels({ channels: constantChannels({ count: 50 }), bounds: BOX });
		for (const name of CHANNELS) expect(flat[name]).toHaveLength(2);
		const single = simplifyCameraPinChannels({ channels: constantChannels({ count: 1 }), bounds: BOX });
		for (const name of CHANNELS) expect(single[name]).toHaveLength(1);
		const two = simplifyCameraPinChannels({ channels: constantChannels({ count: 2 }), bounds: BOX });
		for (const name of CHANNELS) expect(two[name]).toHaveLength(2);
	});

	test("the pin frame's sample is always a key, so the element is exactly as left there", () => {
		const channels = withTent({ channels: constantChannels({ count: 41 }), name: "x", peak: 0.1 });
		// flat to within the tolerance: two keys, unless the pin frame asks for one
		expect(simplifyCameraPinChannels({ channels, bounds: BOX }).x).toHaveLength(2);
		const pinned = simplifyCameraPinChannels({ channels, bounds: BOX, pinFrame: 13 });
		for (const name of CHANNELS) {
			expect(pinned[name].map((k) => k.time)).toContain(channels.times[13]);
		}
		expect(pinned.x.find((k) => k.time === channels.times[13])?.value).toBe(channels.x[13]);
		expect(pinned.rotate).toHaveLength(3);
		// a frame that is not there asks for nothing
		expect(simplifyCameraPinChannels({ channels, bounds: BOX, pinFrame: 999 }).x).toHaveLength(2);
	});

	test("a smaller budget never keeps fewer keys", () => {
		const channels = withTent({ channels: constantChannels({ count: 81 }), name: "y", peak: 0.4 });
		const fine = simplifyCameraPinChannels({ channels, bounds: BOX, budget: 0.1 });
		const coarse = simplifyCameraPinChannels({ channels, bounds: BOX, budget: 2 });
		expect(fine.y.length).toBeGreaterThanOrEqual(coarse.y.length);
		expect(fine.y.length).toBe(3);
		expect(coarse.y.length).toBe(2);
	});
});

describe("unwrapped rotation stays unwrapped", () => {
	test("430 degrees of roll simplify to a rising line, never folded", () => {
		const n = 240;
		const poses = spinPath({ n, totalDeg: 430 });
		const channels = buildCameraPinChannels({
			maps: exactSimilaritySolution({ poses, f0: 0 }),
			first: 0,
			last: n - 1,
			frameTimeAt,
			frameSize: FRAME,
			hostAt: fillHost,
			overlay: { position: { x: 200, y: -90 }, scaleX: 0.8, scaleY: 0.8, rotate: 170 },
			bounds: { left: -100, top: -50, width: 200, height: 100 },
			isText: false,
			canvasSize: CANVAS,
		});
		const result = simplifyCameraPinChannels({
			channels,
			bounds: { left: -100, top: -50, width: 200, height: 100 },
		});
		const keys = result.rotate;
		expect(keys[0].value).toBeCloseTo(170, 9);
		expect(keys[keys.length - 1].value).toBeCloseTo(600, 4);
		// a straight spin needs very few keys
		expect(keys.length).toBeLessThanOrEqual(3);
		for (let k = 1; k < keys.length; k++) expect(keys[k].value).toBeGreaterThan(keys[k - 1].value);
		// and every sample is within the angle tolerance of what the keys play
		const tolerance = pinTolerances({
			channels,
			bounds: { left: -100, top: -50, width: 200, height: 100 },
		});
		for (let i = 0; i < n; i++) {
			const played = playback({ keys, time: channels.times[i] });
			expect(Math.abs(played - channels.rotate[i])).toBeLessThanOrEqual(tolerance.rotationDeg + 1e-9);
		}
	});
});

describe("tracked cameras (plan table M6)", () => {
	const mainWorld = () => getWorld({ key: "main", seed: 1 });
	// a text box of 400x200 on a canvas of 1920x1080, as in the plan's measurements
	const bounds: LocalRect = { left: -200, top: -100, width: 400, height: 200 };
	const overlay = { position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotate: 0 };

	function channelsFor({ name, kind }: { name: string; kind: "pan" | "hand" | "combo" }): CameraPinChannels {
		const analysis = cachedAnalysis({
			key: `t3-simplify-${name}`,
			make: () =>
				analyse({
					world: mainWorld(),
					options: { kind, frameCount: 240, seed: 5 },
				}),
		});
		return buildCameraPinChannels({
			maps: solvePin({ tracks: analysis.tracks, f0: 0, model: "S", mode: "scene" }),
			first: 0,
			last: 239,
			frameTimeAt,
			frameSize: FRAME,
			hostAt: fillHost,
			overlay,
			bounds,
			isText: true,
			canvasSize: CANVAS,
		});
	}

	function check({ channels, label }: { channels: CameraPinChannels; label: string }) {
		const simplified = simplifyCameraPinChannels({ channels, bounds });
		const tolerance = pinTolerances({ channels, bounds });
		const played = playedValues({ simplified, times: channels.times });
		for (let i = 0; i < channels.frames.length; i++) {
			expect(Math.abs(played.x[i] - channels.x[i])).toBeLessThanOrEqual(tolerance.position + 1e-9);
			expect(Math.abs(played.y[i] - channels.y[i])).toBeLessThanOrEqual(tolerance.position + 1e-9);
			expect(Math.abs(played.scaleX[i] - channels.scaleX[i])).toBeLessThanOrEqual(
				tolerance.scale * Math.abs(channels.scaleX[i]) + 1e-9,
			);
			expect(Math.abs(played.scaleY[i] - channels.scaleY[i])).toBeLessThanOrEqual(
				tolerance.scale * Math.abs(channels.scaleY[i]) + 1e-9,
			);
			expect(Math.abs(played.rotate[i] - channels.rotate[i])).toBeLessThanOrEqual(
				tolerance.rotationDeg + 1e-9,
			);
		}
		const gap = maxCornerGap({ a: channels, b: played, bounds, isText: true, canvasSize: CANVAS });
		report({
			label,
			values: {
				"x keys": simplified.x.length,
				"y keys": simplified.y.length,
				"scale keys": simplified.scaleX.length,
				"rotation keys": simplified.rotate.length,
				"corner gap px": gap,
			},
		});
		return { simplified, gap };
	}

	test("a pan of 8 seconds needs at most 70 keys per channel and every sample is within budget", () => {
		const { simplified, gap } = check({ channels: channelsFor({ name: "pan", kind: "pan" }), label: "M6 pan 240" });
		for (const name of CHANNELS) {
			expect(simplified[name].length).toBeLessThanOrEqual(70);
		}
		expect(gap).toBeLessThanOrEqual(CAMERA_PIN_BUDGET);
	});

	test("hand shake barely simplifies but never leaves the budget", () => {
		const channels = channelsFor({ name: "hand", kind: "hand" });
		const { simplified, gap } = check({ channels, label: "M6 hand 240" });
		// the plan: shaky footage is about three keys per frame saved nothing, so most samples stay
		expect(simplified.x.length).toBeGreaterThan(60);
		expect(simplified.x.length).toBeLessThanOrEqual(240);
		expect(gap).toBeLessThanOrEqual(CAMERA_PIN_BUDGET);
	});

	test("zoom, roll, shake and pan together stay within budget", () => {
		const { gap } = check({ channels: channelsFor({ name: "combo", kind: "combo" }), label: "M6 combo 240" });
		expect(gap).toBeLessThanOrEqual(CAMERA_PIN_BUDGET);
	});

	test("a budget of 1 px keeps fewer keys than 0.5 px on the same channels", () => {
		const channels = channelsFor({ name: "hand", kind: "hand" });
		const fine = simplifyCameraPinChannels({ channels, bounds });
		const coarse = simplifyCameraPinChannels({ channels, bounds, budget: 1 });
		for (const name of CHANNELS) {
			expect(coarse[name].length).toBeLessThanOrEqual(fine[name].length);
		}
		expect(coarse.x.length + coarse.y.length).toBeLessThan(fine.x.length + fine.y.length);
	});
});
