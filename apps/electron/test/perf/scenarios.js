// The playback harness's scenarios: how each one is built through the UI (perf-two-clips.js),
// what the stored project must look like afterwards, and which part of the timeline is played.
// Pure: a stored project (IndexedDB record) in, a description / problems / play window out.

const TICKS_PER_SECOND = 120_000; // apps/web/src/wasm/media-time.ts
const PIP_SCALE = 0.4;
const PIP_MARGIN = 0.04; // of the shorter canvas side
const SCALE_TOLERANCE = 0.005;
const MIN_SOURCE_OFFSET_S = 1;
const MIN_PROJECT_SECONDS = 5;
const PROJECT_END_MARGIN_S = 0.5;

const freeze = (object) => Object.freeze(object);
const WIDE = freeze({ width: 1920, height: 1080 });
const TALL = freeze({ width: 1080, height: 1920 });

const SCENARIOS = freeze({
	S1: freeze({ id: "S1", build: "pip-two-files", title: "two different 1080p30 clips on two tracks, the top one scaled to 40 % (picture-in-picture)", canvas: WIDE, canvasPreset: null, blurPreset: null }),
	S1b: freeze({ id: "S1b", build: "pip-same-file", title: "the same file twice, the top copy 5 s later and scaled to 40 % (split/PiP of one asset)", canvas: WIDE, offsetSeconds: 5, canvasPreset: null, blurPreset: null }),
	S2: freeze({ id: "S2", build: "sequential", title: "two different clips back to back on the main track, the hard cut in the middle of the window", canvas: WIDE, canvasPreset: null, blurPreset: null }),
	S3: freeze({ id: "S3", build: "pip-two-files", title: "S1 on a 9:16 canvas over the blur background at 200", canvas: TALL, canvasPreset: "9:16", blurPreset: "Medium", blurIntensity: 200 }),
	project: freeze({ id: "project", build: null, title: "an existing project of a profile copy (--project)" }),
});
const SYNTHETIC_IDS = Object.freeze(["S1", "S1b", "S2", "S3"]);

const seconds = (ticks) => (typeof ticks === "number" && Number.isFinite(ticks) ? ticks / TICKS_PER_SECOND : null);
const numberOr = ({ value, fallback }) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function fpsOf(fps) {
	if (typeof fps === "number" && fps > 0) return fps;
	if (fps && typeof fps === "object" && fps.numerator > 0 && fps.denominator > 0) return fps.numerator / fps.denominator;
	return null;
}

/** A stored project -> { canvas, fps, background, durationS, videos: [...] } (overlay tracks first, top first); null if unreadable. */
function describeProject(project) {
	if (!project || typeof project !== "object" || !project.settings || typeof project.settings !== "object") return null;
	if (!Array.isArray(project.scenes) || project.scenes.length === 0) return null;
	const scene = project.scenes.find((candidate) => candidate && candidate.id === project.currentSceneId) ?? project.scenes[0];
	const tracks = scene && scene.tracks ? scene.tracks : {};
	const overlay = Array.isArray(tracks.overlay) ? tracks.overlay : [];
	const ordered = [...overlay.map((track, index) => ({ track, kind: "overlay", index })), ...(tracks.main ? [{ track: tracks.main, kind: "main", index: overlay.length }] : [])];
	const videos = [];
	let durationS = 0;
	for (const { track, kind, index } of [...ordered, ...(Array.isArray(tracks.audio) ? tracks.audio.map((track) => ({ track, kind: "audio", index: -1 })) : [])]) {
		for (const element of Array.isArray(track?.elements) ? track.elements : []) {
			const startS = seconds(element.startTime) ?? 0;
			const endS = startS + (seconds(element.duration) ?? 0);
			durationS = Math.max(durationS, endS);
			if (element.type !== "video" || kind === "audio") continue;
			const params = element.params && typeof element.params === "object" ? element.params : {};
			videos.push({
				id: element.id,
				mediaId: element.mediaId,
				track: kind,
				trackIndex: index,
				startS,
				endS,
				trimStartS: seconds(element.trimStart) ?? 0,
				scaleX: numberOr({ value: params["transform.scaleX"], fallback: 1 }),
				scaleY: numberOr({ value: params["transform.scaleY"], fallback: 1 }),
				positionX: numberOr({ value: params["transform.positionX"], fallback: 0 }),
				positionY: numberOr({ value: params["transform.positionY"], fallback: 0 }),
				hidden: Boolean(element.hidden),
			});
		}
	}
	const canvasSize = project.settings.canvasSize;
	return {
		canvas: canvasSize ? { width: canvasSize.width, height: canvasSize.height } : null,
		fps: fpsOf(project.settings.fps),
		background: project.settings.background ? { ...project.settings.background } : null,
		durationS,
		videos,
	};
}

const sameSize = ({ a, b }) => Boolean(a && b && a.width === b.width && a.height === b.height);
const near = ({ a, b, tolerance }) => Math.abs(a - b) <= tolerance;
const round3 = (value) => Number(value.toFixed(3));

function pairOnTracks({ shape, problems }) {
	const main = shape.videos.filter((v) => v.track === "main");
	const overlay = shape.videos.filter((v) => v.track === "overlay");
	if (main.length !== 1 || overlay.length !== 1) {
		problems.push(`expected one video on the main track and one on an overlay track (main ${main.length}, overlay ${overlay.length})`);
		return null;
	}
	return { main: main[0], top: overlay[0] };
}

function checkPip({ top, problems }) {
	if (!near({ a: top.scaleX, b: PIP_SCALE, tolerance: SCALE_TOLERANCE }) || !near({ a: top.scaleY, b: PIP_SCALE, tolerance: SCALE_TOLERANCE })) {
		problems.push(`PiP: the top clip's scale is ${top.scaleX} x ${top.scaleY}, expected ${PIP_SCALE}`);
	}
}

function checkCover({ clips, window, tolerance, problems }) {
	for (const clip of clips) {
		if (clip.startS > window.fromS + tolerance || clip.endS < window.toS - tolerance) {
			problems.push(`the clips do not cover the window ${window.fromS}-${window.toS} s (a clip runs ${round3(clip.startS)}-${round3(clip.endS)} s)`);
			return;
		}
	}
}

/**
 * Checks the built project against its scenario and returns the timeline window to play:
 * { problems: string[], window: { fromS, toS } | null } (+ sourceOffsetS for S1b, cutS for S2).
 */
function checkScenario({ scenarioId, shape, seconds: playSeconds }) {
	if (!shape) return { problems: ["the project could not be read"], window: null };
	const scenario = Object.hasOwn(SCENARIOS, scenarioId) ? SCENARIOS[scenarioId] : null;
	if (!scenario) return { problems: [`unknown scenario ${scenarioId}`], window: null };
	const problems = [];
	const tolerance = 1 / (shape.fps ?? 30) + 1e-6;

	if (scenario.build === null) {
		if (shape.durationS < MIN_PROJECT_SECONDS) problems.push(`the project is shorter than ${MIN_PROJECT_SECONDS} s (${round3(shape.durationS)} s)`);
		return { problems, window: { fromS: 0, toS: round3(Math.max(0, Math.min(playSeconds, shape.durationS - PROJECT_END_MARGIN_S))) } };
	}
	if (shape.videos.length !== 2) problems.push(`expected 2 videos, found ${shape.videos.length}`);
	if (!sameSize({ a: shape.canvas, b: scenario.canvas })) problems.push(`canvas ${shape.canvas?.width}x${shape.canvas?.height}, expected ${scenario.canvas.width}x${scenario.canvas.height}`);
	if (scenario.blurIntensity !== undefined && !(shape.background?.type === "blur" && shape.background.blurIntensity === scenario.blurIntensity)) {
		problems.push(`background ${JSON.stringify(shape.background)}, expected blur ${scenario.blurIntensity}`);
	}
	if (shape.videos.length !== 2) return { problems, window: null };

	if (scenario.build === "pip-two-files") {
		const pair = pairOnTracks({ shape, problems });
		if (!pair) return { problems, window: null };
		if (pair.main.mediaId === pair.top.mediaId) problems.push("the two videos must be different files");
		if (pair.main.startS > tolerance || pair.top.startS > tolerance) problems.push(`start: both clips must start at 0 s (${round3(pair.main.startS)}, ${round3(pair.top.startS)})`);
		checkPip({ top: pair.top, problems });
		const window = { fromS: 0, toS: playSeconds };
		checkCover({ clips: [pair.main, pair.top], window, tolerance, problems });
		return { problems, window };
	}

	if (scenario.build === "pip-same-file") {
		const pair = pairOnTracks({ shape, problems });
		if (!pair) return { problems, window: null };
		if (pair.main.mediaId !== pair.top.mediaId) problems.push("the two clips must be the same file");
		checkPip({ top: pair.top, problems });
		const sourceOffsetS = round3(Math.abs(pair.top.startS - pair.top.trimStartS - (pair.main.startS - pair.main.trimStartS)));
		if (sourceOffsetS < MIN_SOURCE_OFFSET_S) problems.push(`the two copies show the same source time (source offset ${sourceOffsetS} s, needs >= ${MIN_SOURCE_OFFSET_S} s)`);
		const fromS = round3(Math.max(pair.main.startS, pair.top.startS));
		const window = { fromS, toS: round3(fromS + playSeconds) };
		checkCover({ clips: [pair.main, pair.top], window, tolerance, problems });
		return { problems, window, sourceOffsetS };
	}

	// sequential
	const [first, second] = [...shape.videos].sort((a, b) => a.startS - b.startS);
	if (first.track !== "main" || second.track !== "main") problems.push("both clips must be on the main track");
	if (first.mediaId === second.mediaId) problems.push("the two clips must be different files");
	if (!near({ a: second.startS, b: first.endS, tolerance })) problems.push(`no hard cut: the second clip starts at ${round3(second.startS)} s, the first ends at ${round3(first.endS)} s`);
	const cutS = round3(first.endS);
	const fromS = round3(cutS - playSeconds / 2);
	const window = { fromS, toS: round3(fromS + playSeconds) };
	if (first.startS > fromS + tolerance || second.endS < window.toS - tolerance) problems.push(`the clips do not cover the window ${window.fromS}-${window.toS} s`);
	return { problems, window, cutS };
}

/** Where the picture-in-picture clip goes: 40 % of its contained size, bottom right, canvas pixels from the centre. */
function pipTransform({ canvas, clip, scale = PIP_SCALE }) {
	const contain = Math.min(canvas.width / clip.width, canvas.height / clip.height);
	const margin = PIP_MARGIN * Math.min(canvas.width, canvas.height);
	const shownWidth = clip.width * contain * scale;
	const shownHeight = clip.height * contain * scale;
	return { scale, x: Math.round(canvas.width / 2 - shownWidth / 2 - margin), y: Math.round(canvas.height / 2 - shownHeight / 2 - margin) };
}

/** Keys after Home to reach `seconds`: shift+Right (5 s), l (1 s), Right (1 frame). */
function seekKeyPlan({ seconds: target, fps }) {
	if (!(Number.isFinite(target) && target >= 0)) throw new Error(`cannot seek to ${target} s`);
	if (!(Number.isFinite(fps) && fps > 0)) throw new Error(`no frame rate (${fps})`);
	const totalFrames = Math.round(target * fps);
	const whole = Math.floor(totalFrames / fps + 1e-9);
	return { jumps5: Math.floor(whole / 5), steps1: whole % 5, frames: totalFrames - Math.round(whole * fps) };
}

module.exports = { PIP_SCALE, SCENARIOS, SYNTHETIC_IDS, TICKS_PER_SECOND, checkScenario, describeProject, pipTransform, seekKeyPlan };
