const { describe, expect, test } = require("bun:test");
const { PIP_SCALE, SCENARIOS, SYNTHETIC_IDS, checkScenario, describeProject, pipTransform, seekKeyPlan } = require("./perf/scenarios");

// The four synthetic scenarios (and an existing project): what the stored project must look like
// after the harness built it through the UI, and which part of the timeline is played.

const T = 120_000; // ticks per second (apps/web/src/wasm/media-time.ts)

const video = ({ id, mediaId, start = 0, duration = 40, trim = 0, scale = 1, x = 0, y = 0 }) => ({
	id,
	type: "video",
	mediaId,
	name: `${mediaId}.mp4`,
	startTime: start * T,
	duration: duration * T,
	trimStart: trim * T,
	trimEnd: 0,
	params: { "transform.scaleX": scale, "transform.scaleY": scale, "transform.positionX": x, "transform.positionY": y },
});

function project({ main = [], overlay = [], canvas = { width: 1920, height: 1080 }, background = { type: "color", color: "#000000" }, fps = { numerator: 30, denominator: 1 } } = {}) {
	return {
		id: "p1",
		currentSceneId: "s1",
		settings: { canvasSize: canvas, background, fps },
		scenes: [
			{
				id: "s1",
				tracks: {
					overlay: overlay.map((elements, index) => ({ id: `o${index}`, type: "video", elements })),
					main: { id: "main", type: "video", elements: main },
					audio: [{ id: "au", type: "audio", elements: [] }],
				},
			},
		],
	};
}

const s1 = (overrides = {}) =>
	project({
		main: [video({ id: "e1", mediaId: "ma" })],
		overlay: [[video({ id: "e2", mediaId: "mb", scale: PIP_SCALE, x: 535, y: 280 })]],
		...overrides,
	});

describe("describeProject", () => {
	test("canvas, fps, background and every video with its track, times in seconds and transform", () => {
		const shape = describeProject(s1());
		expect(shape.canvas).toEqual({ width: 1920, height: 1080 });
		expect(shape.fps).toBe(30);
		expect(shape.background).toEqual({ type: "color", color: "#000000" });
		expect(shape.durationS).toBe(40);
		expect(shape.videos).toEqual([
			{ id: "e2", mediaId: "mb", track: "overlay", trackIndex: 0, startS: 0, endS: 40, trimStartS: 0, scaleX: PIP_SCALE, scaleY: PIP_SCALE, positionX: 535, positionY: 280, hidden: false },
			{ id: "e1", mediaId: "ma", track: "main", trackIndex: 1, startS: 0, endS: 40, trimStartS: 0, scaleX: 1, scaleY: 1, positionX: 0, positionY: 0, hidden: false },
		]);
	});

	test("fps as a plain number (old projects) and missing params (defaults: scale 1)", () => {
		const p = project({ main: [{ ...video({ id: "e1", mediaId: "ma" }), params: {} }], fps: 60 });
		const shape = describeProject(p);
		expect(shape.fps).toBe(60);
		expect(shape.videos[0]).toMatchObject({ scaleX: 1, scaleY: 1, positionX: 0 });
	});

	test("audio tracks count for the timeline's length but never as videos", () => {
		const p = s1();
		p.scenes[0].tracks.audio[0].elements = [{ id: "au1", type: "audio", startTime: 0, duration: 55 * T }, video({ id: "odd", mediaId: "mz" })];
		const shape = describeProject(p);
		expect(shape.durationS).toBe(55);
		expect(shape.videos.map((v) => v.id)).toEqual(["e2", "e1"]);
	});

	test("not a project: null", () => {
		for (const bad of [null, {}, { scenes: [] }, { settings: {}, scenes: "x" }]) expect(describeProject(bad)).toBeNull();
	});
});

describe("checkScenario", () => {
	test("S1: two different files, one on main and one scaled down on an overlay, both from 0; plays 0..seconds", () => {
		const result = checkScenario({ scenarioId: "S1", shape: describeProject(s1()), seconds: 30 });
		expect(result.problems).toEqual([]);
		expect(result.window).toEqual({ fromS: 0, toS: 30 });
	});

	test("S1 problems: same file, not scaled, a clip too short, three clips, not 16:9", () => {
		const cases = [
			[s1({ overlay: [[video({ id: "e2", mediaId: "ma", scale: PIP_SCALE })]] }), "different"],
			[s1({ overlay: [[video({ id: "e2", mediaId: "mb" })]] }), "scale"],
			[s1({ main: [video({ id: "e1", mediaId: "ma", duration: 20 })] }), "cover"],
			[s1({ overlay: [[video({ id: "e2", mediaId: "mb", scale: PIP_SCALE })], [video({ id: "e3", mediaId: "mc" })]] }), "2 videos"],
			[s1({ canvas: { width: 1080, height: 1920 } }), "canvas"],
			[s1({ overlay: [[video({ id: "e2", mediaId: "mb", scale: PIP_SCALE, start: 3 })]] }), "start"],
		];
		for (const [p, word] of cases) expect(checkScenario({ scenarioId: "S1", shape: describeProject(p), seconds: 30 }).problems.join(" ")).toContain(word);
	});

	test("S1b: the same file twice, the overlay copy later (a different source offset); plays from where both run", () => {
		const p = project({ main: [video({ id: "e1", mediaId: "ma" })], overlay: [[video({ id: "e2", mediaId: "ma", start: 5, scale: PIP_SCALE })]] });
		const result = checkScenario({ scenarioId: "S1b", shape: describeProject(p), seconds: 30 });
		expect(result.problems).toEqual([]);
		expect(result.window).toEqual({ fromS: 5, toS: 35 });
		expect(result.sourceOffsetS).toBe(5);
	});

	test("S1b problems: two files, no offset, the window runs past a clip", () => {
		const twoFiles = project({ main: [video({ id: "e1", mediaId: "ma" })], overlay: [[video({ id: "e2", mediaId: "mb", start: 5, scale: PIP_SCALE })]] });
		expect(checkScenario({ scenarioId: "S1b", shape: describeProject(twoFiles), seconds: 30 }).problems.join(" ")).toContain("same file");
		const noOffset = project({ main: [video({ id: "e1", mediaId: "ma" })], overlay: [[video({ id: "e2", mediaId: "ma", scale: PIP_SCALE })]] });
		expect(checkScenario({ scenarioId: "S1b", shape: describeProject(noOffset), seconds: 30 }).problems.join(" ")).toContain("offset");
		const short = project({ main: [video({ id: "e1", mediaId: "ma", duration: 30 })], overlay: [[video({ id: "e2", mediaId: "ma", start: 5, scale: PIP_SCALE })]] });
		expect(checkScenario({ scenarioId: "S1b", shape: describeProject(short), seconds: 30 }).problems.join(" ")).toContain("cover");
	});

	test("S1b: a trimmed copy at the same timeline start also has a source offset", () => {
		const trimmed = project({ main: [video({ id: "e1", mediaId: "ma" })], overlay: [[video({ id: "e2", mediaId: "ma", trim: 5, duration: 35, scale: PIP_SCALE })]] });
		const result = checkScenario({ scenarioId: "S1b", shape: describeProject(trimmed), seconds: 30 });
		expect(result.problems).toEqual([]);
		expect(result.sourceOffsetS).toBe(5);
		expect(result.window).toEqual({ fromS: 0, toS: 30 });
	});

	test("S2: two files back to back on the main track; the cut sits in the middle of the window", () => {
		const p = project({ main: [video({ id: "e1", mediaId: "ma" }), video({ id: "e2", mediaId: "mb", start: 40 })] });
		const result = checkScenario({ scenarioId: "S2", shape: describeProject(p), seconds: 30 });
		expect(result.problems).toEqual([]);
		expect(result.window).toEqual({ fromS: 25, toS: 55 });
		expect(result.cutS).toBe(40);
	});

	test("S2 problems: a gap, an overlap on another track, the same file", () => {
		const gap = project({ main: [video({ id: "e1", mediaId: "ma" }), video({ id: "e2", mediaId: "mb", start: 41 })] });
		expect(checkScenario({ scenarioId: "S2", shape: describeProject(gap), seconds: 30 }).problems.join(" ")).toContain("cut");
		const stacked = project({ main: [video({ id: "e1", mediaId: "ma" })], overlay: [[video({ id: "e2", mediaId: "mb", start: 40 })]] });
		expect(checkScenario({ scenarioId: "S2", shape: describeProject(stacked), seconds: 30 }).problems.join(" ")).toContain("main track");
		const same = project({ main: [video({ id: "e1", mediaId: "ma" }), video({ id: "e2", mediaId: "ma", start: 40 })] });
		expect(checkScenario({ scenarioId: "S2", shape: describeProject(same), seconds: 30 }).problems.join(" ")).toContain("different");
	});

	test("S2: a cut one frame off still counts as a hard cut", () => {
		const p = project({ main: [video({ id: "e1", mediaId: "ma" }), video({ id: "e2", mediaId: "mb", start: 40 + 1 / 30 })] });
		expect(checkScenario({ scenarioId: "S2", shape: describeProject(p), seconds: 30 }).problems).toEqual([]);
	});

	test("S3: S1 plus a 1080x1920 canvas and the blur background at 200", () => {
		const good = s1({ canvas: { width: 1080, height: 1920 }, background: { type: "blur", blurIntensity: 200 } });
		expect(checkScenario({ scenarioId: "S3", shape: describeProject(good), seconds: 30 }).problems).toEqual([]);
		const weak = s1({ canvas: { width: 1080, height: 1920 }, background: { type: "blur", blurIntensity: 100 } });
		expect(checkScenario({ scenarioId: "S3", shape: describeProject(weak), seconds: 30 }).problems.join(" ")).toContain("blur");
		const wide = s1({ background: { type: "blur", blurIntensity: 200 } });
		expect(checkScenario({ scenarioId: "S3", shape: describeProject(wide), seconds: 30 }).problems.join(" ")).toContain("canvas");
	});

	test("an existing project: no shape rules; plays from 0 for the seconds asked, or up to half a second before its end", () => {
		const p = project({ main: [video({ id: "e1", mediaId: "ma", duration: 12 })], fps: 60 });
		expect(checkScenario({ scenarioId: "project", shape: describeProject(p), seconds: 30 })).toEqual({ problems: [], window: { fromS: 0, toS: 11.5 } });
		const tiny = project({ main: [video({ id: "e1", mediaId: "ma", duration: 3 })] });
		expect(checkScenario({ scenarioId: "project", shape: describeProject(tiny), seconds: 30 }).problems.join(" ")).toContain("shorter");
	});

	test("unknown scenario or no project: a problem, no window", () => {
		expect(checkScenario({ scenarioId: "S9", shape: describeProject(s1()), seconds: 30 }).window).toBeNull();
		for (const id of ["toString", "__proto__", "constructor"]) expect(checkScenario({ scenarioId: id, shape: describeProject(s1()), seconds: 30 })).toEqual({ problems: [`unknown scenario ${id}`], window: null });
		expect(checkScenario({ scenarioId: "S1", shape: null, seconds: 30 }).problems).toEqual(["the project could not be read"]);
	});
});

describe("SCENARIOS", () => {
	test("the four synthetic scenarios of the brief and the existing-project one", () => {
		expect(SYNTHETIC_IDS).toEqual(["S1", "S1b", "S2", "S3"]);
		expect(Object.keys(SCENARIOS).sort()).toEqual(["S1", "S1b", "S2", "S3", "project"]);
		expect(SCENARIOS.S3.canvasPreset).toBe("9:16");
		expect(SCENARIOS.S3.blurPreset).toBe("Medium");
		expect(Object.isFrozen(SCENARIOS)).toBe(true);
	});
});

describe("pipTransform", () => {
	test("16:9 clip on a 16:9 canvas: 40 %, bottom right with a margin", () => {
		expect(pipTransform({ canvas: { width: 1920, height: 1080 }, clip: { width: 1920, height: 1080 } })).toEqual({ scale: 0.4, x: 533, y: 281 });
	});

	test("16:9 clip on the 9:16 canvas: contained to the width first", () => {
		expect(pipTransform({ canvas: { width: 1080, height: 1920 }, clip: { width: 1920, height: 1080 } })).toEqual({ scale: 0.4, x: 281, y: 795 });
	});
});

describe("seekKeyPlan (Home, then shift+Right = 5 s, l = 1 s, Right = 1 frame)", () => {
	test("whole and fractional seconds", () => {
		expect(seekKeyPlan({ seconds: 0, fps: 30 })).toEqual({ jumps5: 0, steps1: 0, frames: 0 });
		expect(seekKeyPlan({ seconds: 25, fps: 30 })).toEqual({ jumps5: 5, steps1: 0, frames: 0 });
		expect(seekKeyPlan({ seconds: 7.5, fps: 30 })).toEqual({ jumps5: 1, steps1: 2, frames: 15 });
		expect(seekKeyPlan({ seconds: 40 + 1 / 30, fps: 30 })).toEqual({ jumps5: 8, steps1: 0, frames: 1 });
		expect(seekKeyPlan({ seconds: 4.999, fps: 30 })).toEqual({ jumps5: 1, steps1: 0, frames: 0 });
	});

	test("negative or non-finite: refused", () => {
		for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => seekKeyPlan({ seconds, fps: 30 })).toThrow();
		expect(() => seekKeyPlan({ seconds: 1, fps: 0 })).toThrow();
	});
});
