// Two-clip playback measurement in the REAL unpackaged Electron window. For the owner's local
// session: the cloud cannot run Electron or a GPU, so nothing here has been run there. Commands,
// fields and targets: docs/ccut/playback-measure-2clips.md; options: --help.
//
//   node apps/electron/test/perf-two-clips.js [--scenarios S1,S1b,S2,S3] [--seconds 30] [--label after]
//   node apps/electron/test/perf-two-clips.js --compare before.json after.json
//
// It makes the test clips (script/make-perf-clips.js code) or takes --clips, starts the unpackaged
// app on a FRESH temporary user-data dir (or a COPY of --profile-copy: never the live profile),
// builds every scenario's project through the UI (file chooser interception, "+" on the asset card,
// Transform fields, Settings) and closes the app. Then, per scenario, it starts the app again,
// opens the project, plays it with Space for --seconds while sampling every 500 ms, and writes one
// JSON file with every scenario plus a table on stdout. Exit 0 = measured (targets may be missed),
// 1 = harness failure (the JSON is still written with what was measured), 2 = usage error.
// The pure parts live in ./perf/ and have unit tests (apps/electron/test/perf-*.test.js).
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { closeApp, collectProblems, connectToPage, launchElectron, sleep } = require("./cdp");
const ed = require("./features-editor");
const { byLabelFinder, byTextFinder, clickEl, press, readProjects, waitFor, withTimeout } = require("./features-lib");
const { cgroupSummary } = require("./perf/aggregate");
const { USER_DATA_PREFIX, UsageError, parseArgs, resultFileName, usage } = require("./perf/args");
const { CLIPS, CLIP_DEFAULTS, generateClips } = require("./perf/clips");
const { HarnessError, copyProfile, launchGuarded, removeTempDirs } = require("./perf/guards");
const { LEVERS_STORAGE_KEY, persistedWithLevers } = require("./perf/levers");
const { collectProbes, installProbes, pageCall, playWindowFromKeys, previewFrames, readFrameCacheCounters, selectFrameCacheCounters } = require("./perf/page-probes");
const { parseClkTck, roleKey } = require("./perf/proc");
const { RUN_SCHEMA, buildRun, buildScenarioResult, compareRuns, formatCompareTable, formatRunTable } = require("./perf/report");
const { createSampler } = require("./perf/sampler");
const { SCENARIOS, TICKS_PER_SECOND, checkScenario, describeProject, pipTransform, seekKeyPlan } = require("./perf/scenarios");

const REPO = path.join(__dirname, "../../..");
const SERVER = path.join(REPO, "apps/web/.next/standalone/apps/web/server.js");
const DEFAULT_OUT = path.join(__dirname, "out", "perf");
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const SAMPLE_MS = 500;
const MAX_PAGE_ENTRIES = 100_000;
const PREVIEW_PANEL = { panelSelector: ed.GROUP, panelIndex: 1 }; // ed.PREVIEW
const CLIP_MARGIN_S = 10; // clips run --seconds + 10 s: S1b plays from 5 s, S2 cuts in the middle
const SETUP_BUDGET_MS = 5 * 60_000;
const MEASURE_OVERHEAD_MS = 3 * 60_000;
const COUNTER_GROUP = "ccut-perf-counters";
const MAX_MEDIA_EVENTS = 2000;
// The editor's unsaved-changes beforeunload opens a native dialog that blocks CDP (as in features.js).
const NO_BEFOREUNLOAD = `(() => { const add = window.addEventListener.bind(window); window.addEventListener = (type, ...rest) => (type === "beforeunload" ? undefined : add(type, ...rest)); })()`;

const state = { activeApp: null, temps: [], tmpRoot: os.tmpdir(), finished: false };
// Whatever ends the process (also a crash of the harness): no Electron and no temporary profile copy left behind.
process.on("exit", () => {
	state.activeApp?.child.kill("SIGKILL");
	cleanup();
});

const log = (line) => console.log(line);

// ---------------------------------------------------------------- app sessions
/**
 * --levers: writes the levers into the app's localStorage before the reload that openSession makes
 * anyway. Only ever on the guarded temporary profile (launchGuarded) and only on the app's origin.
 */
async function writeLevers({ client, levers }) {
	const protocol = await client.evaluate("location.protocol");
	if (protocol !== "ccut:") throw new HarnessError(`--levers: the page is on ${protocol}, not the app (ccut:); nothing written`);
	const key = JSON.stringify(LEVERS_STORAGE_KEY);
	const stored = await client.evaluate(`localStorage.getItem(${key})`);
	const value = persistedWithLevers({ stored: typeof stored === "string" ? stored : null, levers });
	await client.evaluate(`localStorage.setItem(${key}, ${JSON.stringify(value)})`);
}

async function openSession({ userDataDir, levers }) {
	// Port 0 + DevToolsActivePort inside the 0700 temporary profile: no free-port probe another process could race.
	const app = await launchGuarded({ userDataDir, tmpRoot: state.tmpRoot, launch: ({ userDataDir: dir }) => launchElectron({ userDataDir: dir, portFromUserDataDir: true }) });
	state.activeApp = app;
	const client = await connectToPage({ app });
	const { problems } = collectProblems(client);
	// chrome://media-internals' data: the decoder each media player (WebCodecs too, if Chromium reports it) uses
	const mediaEvents = [];
	client.on("Media.playerPropertiesChanged", (params) => mediaEvents.length < MAX_MEDIA_EVENTS && mediaEvents.push(params));
	for (const domain of ["Page", "Runtime", "Log", "Performance"]) await client.send(`${domain}.enable`);
	await client.send("Media.enable").catch(() => {});
	await client.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
	await client.send("Page.addScriptToEvaluateOnNewDocument", { source: NO_BEFOREUNLOAD });
	if (levers) await writeLevers({ client, levers });
	await client.evaluate("window.__perfBeforeReload = true");
	await client.send("Page.reload");
	await waitFor("page reload", () => client.evaluate('window.__perfBeforeReload === undefined && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
	return { app, client, problems, mediaEvents };
}

async function closeSession(session) {
	session.client.close();
	await closeApp({ app: session.app });
	// a session that timed out may close late, after the next one started: only clear its own app
	if (state.activeApp === session.app) state.activeApp = null;
}

// ---------------------------------------------------------------- editor steps
async function seekTo({ client, seconds, fps }) {
	const plan = seekKeyPlan({ seconds, fps });
	await ed.blurActive(client);
	await press(client, "home");
	for (let i = 0; i < plan.jumps5; i++) await press(client, "shift+ArrowRight");
	for (let i = 0; i < plan.steps1; i++) await press(client, "l");
	for (let i = 0; i < plan.frames; i++) await press(client, "ArrowRight");
	await sleep(300);
	const ticks = await ed.playheadTicks(client);
	if (Math.abs(ticks / TICKS_PER_SECOND - seconds) > 1 / fps + 1e-6) throw new HarnessError(`could not put the playhead at ${seconds} s (it is at ${ticks / TICKS_PER_SECOND} s)`);
	return ticks;
}

async function addAsset({ client, file, expectClips }) {
	await ed.addAssetToTimeline(client, path.basename(file));
	await waitFor(`${expectClips} clip(s) on the timeline`, async () => (await ed.clipsInfo(client)).length >= expectClips, { timeoutMs: 20_000 });
}

async function placePip({ client, canvas }) {
	const pip = pipTransform({ canvas, clip: { width: CLIP_DEFAULTS.width, height: CLIP_DEFAULTS.height } });
	await ed.propsTab(client, "Transform");
	await ed.typeInto(client, "Scale X", String(pip.scale));
	await ed.typeInto(client, "Scale Y", String(pip.scale));
	await ed.typeInto(client, "Position X", String(pip.x));
	await ed.typeInto(client, "Position Y", String(pip.y));
}

// Fallback when the clip that the "+" button added is not the selected one: zoom out until every
// clip fits, click the clip on the top track.
async function selectTopClip(client) {
	for (let i = 0; i < 12; i++) {
		const right = await client.evaluate(`document.querySelector('[aria-label="Timeline"]').getBoundingClientRect().right`);
		if ((await ed.clipsInfo(client)).every((clip) => clip.x + clip.w < right - 40)) break;
		await ed.zoomClip(client, "out", 1);
	}
	const clips = await ed.clipsInfo(client);
	await ed.selectClip(client, clips.reduce((top, clip) => (clip.y < top.y ? clip : top)).index);
}

async function setCanvasPreset({ client, preset }) {
	await ed.openAssetsTab(client, "Settings");
	await clickEl(client, "Project info tab", byTextFinder('[role="tab"]', "Project info", ed.ASSETS));
	await clickEl(client, `aspect ratio ${preset}`, byTextFinder("button", preset, ed.ASSETS));
	await sleep(500);
}

async function setBlurBackground({ client, preset }) {
	await ed.openAssetsTab(client, "Settings");
	await clickEl(client, "Background tab", byTextFinder('[role="tab"]', "Background", ed.ASSETS));
	await clickEl(client, `${preset} blur`, byLabelFinder(`Select ${preset} blur`, ed.ASSETS));
	await sleep(500);
}

async function readShape({ client, projectId }) {
	return describeProject((await readProjects(client)).find((project) => project.id === projectId));
}

async function checkBuilt({ client, projectId, scenarioId, seconds }) {
	await ed.waitSaved(client, readProjects);
	const shape = await readShape({ client, projectId });
	return { shape, ...checkScenario({ scenarioId, shape, seconds }) };
}

/** Builds one scenario's project in the open session; returns { projectId, check }. */
async function buildProject({ client, scenario, clips, seconds }) {
	const projectId = await ed.newProject(client);
	const fps = CLIP_DEFAULTS.fps; // the first video sets the project's frame rate to its own
	await ed.importMedia(client, scenario.build === "pip-same-file" ? [clips.a] : [clips.a, clips.b]);
	await seekTo({ client, seconds: 0, fps });
	await addAsset({ client, file: clips.a, expectClips: 1 });
	if (scenario.build === "pip-two-files") {
		await seekTo({ client, seconds: 0, fps });
		await addAsset({ client, file: clips.b, expectClips: 2 }); // overlaps the main track: lands on a new top track, selected
		await placePip({ client, canvas: scenario.canvas });
		if (scenario.canvasPreset) await setCanvasPreset({ client, preset: scenario.canvasPreset });
		if (scenario.blurPreset) await setBlurBackground({ client, preset: scenario.blurPreset });
	} else if (scenario.build === "pip-same-file") {
		await seekTo({ client, seconds: scenario.offsetSeconds, fps });
		await addAsset({ client, file: clips.a, expectClips: 2 });
		await placePip({ client, canvas: scenario.canvas });
	} else {
		await ed.blurActive(client);
		await press(client, "End"); // goto-end: the end of the first clip, where the main track is free
		await sleep(300);
		await addAsset({ client, file: clips.b, expectClips: 2 });
	}
	let check = await checkBuilt({ client, projectId, scenarioId: scenario.id, seconds });
	if (check.problems.some((problem) => problem.startsWith("PiP"))) {
		await selectTopClip(client);
		await placePip({ client, canvas: scenario.canvas });
		check = await checkBuilt({ client, projectId, scenarioId: scenario.id, seconds });
	}
	if (check.problems.length > 0) throw new HarnessError(`the project built through the UI does not match ${scenario.id}: ${check.problems.join("; ")}`);
	return { projectId, check };
}

async function openProject({ client, projectId }) {
	await client.send("Page.navigate", { url: `ccut://app/editor/${projectId}` });
	const ready = `location.pathname === ${JSON.stringify(`/editor/${projectId}`)} && document.readyState === "complete" && !!document.querySelector('button[aria-label="Text"]')`;
	await waitFor("the editor", () => client.evaluate(ready).catch(() => false), { timeoutMs: 60_000 });
	await sleep(1500);
	await ed.dismissOnboarding(client);
	await waitFor("clips on the timeline", async () => (await ed.clipsInfo(client).catch(() => [])).length > 0, { timeoutMs: 60_000 });
	await waitFor("the preview canvas", () => client.evaluate(`!!(${ed.PREVIEW})?.querySelector("canvas")`).catch(() => false), { timeoutMs: 30_000 });
	await sleep(2000);
}

// ---------------------------------------------------------------- measuring
/** Finds the video cache's FrameCacheCounters objects (Runtime.queryObjects); returns how many. */
async function findFrameCacheCounters(client) {
	try {
		const { result: prototype } = await client.send("Runtime.evaluate", { expression: "Object.prototype", objectGroup: COUNTER_GROUP });
		const { objects } = await client.send("Runtime.queryObjects", { prototypeObjectId: prototype.objectId, objectGroup: COUNTER_GROUP });
		const { result } = await client.send("Runtime.callFunctionOn", { objectId: objects.objectId, functionDeclaration: selectFrameCacheCounters.toString(), returnByValue: true });
		return typeof result.value === "number" ? result.value : 0;
	} catch {
		return 0;
	} finally {
		await client.send("Runtime.releaseObjectGroup", { objectGroup: COUNTER_GROUP }).catch(() => {});
	}
}

function startSampling({ client, sampler, withCounters }) {
	const out = { processSamples: [], memorySamples: [], counterSamples: [] };
	const sampleOnce = async () => {
		const atMs = Date.now();
		out.processSamples.push({ atMs, processes: sampler.sampleProcesses() });
		out.memorySamples.push({ atMs, ...sampler.memory() });
		if (withCounters) {
			const counters = await client.evaluate(pageCall({ fn: readFrameCacheCounters, arg: {} })).catch(() => null);
			if (counters) out.counterSamples.push(counters);
		}
	};
	let busy = null;
	const run = () => {
		busy = sampleOnce()
			.catch(() => {})
			.finally(() => (busy = null));
		return busy;
	};
	const timer = setInterval(() => busy || run(), SAMPLE_MS);
	return {
		...out,
		async sampleNow() {
			if (busy) await busy;
			await run();
		},
		async stop() {
			clearInterval(timer);
			if (busy) await busy;
		},
	};
}

function snapshotThreads({ sampler }) {
	return sampler.sampleProcesses().map((process) => ({ pid: process.pid, role: roleKey(process), at: Date.now(), threads: sampler.threads({ pid: process.pid }) }));
}

/** CDP SystemInfo.getInfo on the browser target (the data chrome://gpu shows); null when it is not available. */
async function browserSystemInfo({ port }) {
	let ws = null;
	try {
		const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) }).then((response) => response.json());
		ws = new WebSocket(version.webSocketDebuggerUrl);
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("SystemInfo.getInfo timed out")), 15_000);
			ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "SystemInfo.getInfo" }));
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("browser websocket error"));
			};
			ws.onmessage = (message) => {
				const data = JSON.parse(message.data);
				if (data.id !== 1) return;
				clearTimeout(timer);
				if (data.error) reject(new Error(data.error.message));
				else resolve(data.result);
			};
		});
	} catch {
		return null;
	} finally {
		ws?.close();
	}
}

async function cdpMetrics(client) {
	return client
		.send("Performance.getMetrics")
		.then((answer) => answer.metrics)
		.catch(() => null);
}

/** One scenario in a fresh app session: open, seek, idle, Space, wait, Space, collect. Returns the raw input of buildScenarioResult. */
async function measureScenario({ userDataDir, scenarioId, projectId, options, clkTck }) {
	const scenario = SCENARIOS[scenarioId];
	const session = await openSession({ userDataDir, levers: options.levers });
	const notes = [];
	try {
		const { app, client } = session;
		await openProject({ client, projectId });
		await ed.openAssetsTab(client, "Media"); // the Settings panel's blur previews would draw during the run
		const shape = await readShape({ client, projectId });
		const check = checkScenario({ scenarioId, shape, seconds: options.seconds });
		if (!check.window || check.problems.length > 0) throw new HarnessError(`the stored project does not match ${scenarioId}: ${check.problems.join("; ")}`);
		const fps = shape.fps ?? CLIP_DEFAULTS.fps;
		await client.evaluate("window.__playbackHud = true");
		const playheadBefore = await seekTo({ client, seconds: check.window.fromS, fps });
		await sleep(1500);

		const counterObjects = await findFrameCacheCounters(client);
		if (counterObjects === 0) notes.push("the video cache's counters were not found (Runtime.queryObjects): no cache numbers");
		const sampler = createSampler({ fs, rootPid: app.child.pid });
		if (process.platform !== "linux") notes.push("not Linux: no /proc sampling");
		const eventsBefore = sampler.cgroupFiles().eventsText;
		const installed = await client.evaluate(pageCall({ fn: installProbes, arg: { maxEntries: MAX_PAGE_ENTRIES } }));
		if (!installed.present) notes.push("GPUCanvasContext is not available: no presented-frame times");
		if (!installed.longTask) notes.push("long tasks are not observable in this page");
		const sampling = startSampling({ client, sampler, withCounters: counterObjects > 0 });
		await sleep(options.idleSeconds * 1000);

		const problemsBefore = session.problems.length;
		const metricsBefore = await cdpMetrics(client);
		const threadsBefore = snapshotThreads({ sampler });
		await sampling.sampleNow();
		await ed.blurActive(client);
		const playAtMs = Date.now();
		await press(client, "space");
		await sleep((check.window.toS - check.window.fromS) * 1000);
		await press(client, "space");
		const pauseAtMs = Date.now();
		await sampling.sampleNow();
		const threadsAfter = snapshotThreads({ sampler });
		const metricsAfter = await cdpMetrics(client);
		const cgroupEnd = sampler.cgroupFiles();
		await sampling.stop();
		await sleep(400);

		const collected = await client.evaluate(pageCall({ fn: collectProbes, arg: PREVIEW_PANEL }));
		const hudText = await client.evaluate('typeof window.__playbackHudDump === "function" ? window.__playbackHudDump() : null');
		const playheadAfter = await ed.playheadTicks(client);
		const gpuInfo = await browserSystemInfo({ port: app.port });
		// the app's own window.ccutSystem bridge (cgroup-aware): its total must not exceed the scope's MemoryMax
		const memoryBridge = await client.evaluate("window.ccutSystem ? window.ccutSystem.memoryInfo() : null").catch(() => null);
		if (!memoryBridge) notes.push("window.ccutSystem.memoryInfo() answered nothing (an older bundle, or null)");
		if (!gpuInfo) notes.push("SystemInfo.getInfo (chrome://gpu data) was not available");
		const pageWindow = collected ? playWindowFromKeys({ keys: collected.keys }) : null;
		if (!pageWindow) throw new HarnessError("the page did not see both Space presses (Play and Pause)");
		const advancedS = (playheadAfter - playheadBefore) / TICKS_PER_SECOND;
		if (!(advancedS >= 1)) throw new HarnessError(`playback did not start: the playhead moved ${advancedS} s`);
		const frames = previewFrames({ present: collected.present, previewCanvas: collected.previewCanvas, presentCounts: collected.presentCounts });
		if (frames.how === "busiest canvas") notes.push("the preview canvas was not identified: the canvas with the most frames was used");
		const newProblems = session.problems.slice(problemsBefore);
		notes.push(...app.output().split("\n").filter((line) => line.includes("[ccut] hardware decode") || line.includes("CCUT_HW_DECODE")).slice(0, 3));

		return {
			scenario: scenarioId,
			kind: scenarioId === "project" ? "project" : "synthetic",
			title: scenario.title,
			shape,
			check,
			page: {
				idleFromMs: installed.now,
				playMs: pageWindow.playMs,
				pauseMs: pageWindow.pauseMs,
				raf: collected.raf,
				present: frames.timestamps,
				presentCanvas: { chosen: frames.chosen, how: frames.how, counts: collected.presentCounts },
				longTasks: collected.longTasks.map(([startMs, durationMs]) => ({ startMs, durationMs })),
			},
			hudText,
			counterSamples: sampling.counterSamples,
			node: {
				playAtMs,
				pauseAtMs,
				processSamples: sampling.processSamples,
				memorySamples: sampling.memorySamples,
				threadSnapshots: threadsBefore
					.map((before) => {
						const after = threadsAfter.find((entry) => entry.pid === before.pid);
						return after ? { pid: before.pid, role: before.role, elapsedMs: after.at - before.at, before: before.threads, after: after.threads } : null;
					})
					.filter(Boolean),
			},
			cdpMetrics: { before: metricsBefore, after: metricsAfter },
			cgroup: cgroupSummary({ cgroupPath: sampler.cgroupPath, maxText: cgroupEnd.maxText, swapMaxText: cgroupEnd.swapMaxText, peakText: cgroupEnd.peakText, eventsBefore, eventsAfter: cgroupEnd.eventsText }),
			playhead: { beforeS: playheadBefore / TICKS_PER_SECOND, afterS: playheadAfter / TICKS_PER_SECOND },
			errors: {
				exceptions: newProblems.filter((problem) => problem.kind === "exception").length,
				consoleErrors: newProblems.filter((problem) => problem.kind !== "exception").length,
				samples: newProblems.slice(0, 5),
			},
			gpuInfo,
			memoryBridge,
			mediaEvents: session.mediaEvents,
			clkTck,
			notes,
		};
	} finally {
		await closeSession(session).catch(() => {});
	}
}

// ---------------------------------------------------------------- run
function readClkTck() {
	const answer = cp.spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
	const clkTck = parseClkTck(answer.stdout);
	return { clkTck: clkTck ?? 100, assumed: clkTck === null };
}

function machineInfo({ clkTck }) {
	const cpus = os.cpus();
	const git = cp.spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" });
	let electron = null;
	try {
		electron = require("electron/package.json").version;
	} catch {
		electron = null;
	}
	return {
		platform: process.platform,
		kernel: os.release(),
		cpuModel: cpus[0]?.model ?? null,
		cpus: cpus.length,
		totalMemMiB: Math.round(os.totalmem() / (1024 * 1024)),
		node: process.versions.node,
		electron,
		clkTck: clkTck.clkTck,
		clkTckAssumed: clkTck.assumed,
		gitHead: git.status === 0 ? git.stdout.trim() : null,
		bundleBuiltAt: fs.existsSync(SERVER) ? fs.statSync(SERVER).mtime.toISOString() : null,
		hwDecodeEnv: process.env.CCUT_HW_DECODE ?? null,
	};
}

function makeTemp(kind) {
	const dir = fs.mkdtempSync(path.join(state.tmpRoot, `${USER_DATA_PREFIX}${kind}-`));
	state.temps.push(dir);
	return dir;
}

function prepareClips({ options }) {
	if (options.clipsDir) {
		const dir = path.resolve(options.clipsDir);
		const files = Object.fromEntries(CLIPS.map((clip) => [clip.id, path.join(dir, clip.file)]));
		for (const file of Object.values(files)) if (!fs.existsSync(file)) throw new HarnessError(`missing clip ${file} (node script/make-perf-clips.js ${dir} --seconds ${options.seconds + CLIP_MARGIN_S})`);
		return { files, facts: null };
	}
	const dir = makeTemp("clips");
	const generated = generateClips({ dir, seconds: options.seconds + CLIP_MARGIN_S, spawnSync: cp.spawnSync, fs, log: (line) => log(`  ${line}`) });
	if (generated.problems.length > 0) throw new HarnessError(`the generated clips are not as specified: ${generated.problems.join("; ")}`);
	return { files: Object.fromEntries(generated.clips.map((clip) => [clip.id, clip.file])), facts: generated.clips.map((clip) => ({ id: clip.id, ...clip.facts })) };
}

function applyHwDecodeOption(mode) {
	if (mode === "off") delete process.env.CCUT_HW_DECODE;
	else if (mode) process.env.CCUT_HW_DECODE = mode;
}

function cleanup() {
	removeTempDirs({ dirs: state.temps.splice(0), tmpRoot: state.tmpRoot, fs, log });
}

async function runMode(options) {
	const startedAt = new Date().toISOString();
	const outDir = path.resolve(options.outDir ?? DEFAULT_OUT);
	const run = { scenarios: {}, failures: [], notes: [], clips: null };
	const clkTck = readClkTck();
	if (clkTck.assumed) run.notes.push("getconf CLK_TCK failed: 100 ticks per second assumed");
	applyHwDecodeOption(options.hwDecode);
	const machine = machineInfo({ clkTck });

	const finish = (code) => {
		if (state.finished) return;
		state.finished = true;
		state.activeApp?.child.kill("SIGKILL");
		const result = buildRun({ label: options.label, startedAt, finishedAt: new Date().toISOString(), options: { ...options, clips: run.clips }, machine, scenarios: run.scenarios, failures: run.failures, notes: run.notes });
		fs.mkdirSync(outDir, { recursive: true });
		const file = path.join(outDir, resultFileName({ label: options.label, startedAt }));
		fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
		log(`\n${formatRunTable(result)}\n\nresult: ${file}`);
		cleanup();
		process.exit(code);
	};
	for (const [signal, code] of [
		["SIGHUP", 129],
		["SIGINT", 130],
		["SIGTERM", 143],
	]) {
		process.once(signal, () => {
			run.failures.push({ scenario: "run", message: `stopped by ${signal}` });
			finish(code);
		});
	}
	const synthetic = options.scenarios.filter((id) => id !== "project");

	try {
		if (!fs.existsSync(SERVER)) throw new HarnessError(`no app bundle at ${SERVER}: run "node apps/electron/bundle.js" first`);
		const userDataDir = makeTemp("ud");
		if (options.profileCopy) {
			log(`copying the profile ${options.profileCopy} -> ${userDataDir} (the original is only read; a symlink inside stops the run)`);
			run.notes.push(...copyProfile({ fs, from: options.profileCopy, to: userDataDir }).notes);
		}
		const clips = synthetic.length > 0 ? prepareClips({ options }) : null;
		if (clips) run.clips = clips.facts;
		// The watchdog starts after the copy and the clip encoding (both synchronous and size-dependent).
		const budgetMs = synthetic.length * SETUP_BUDGET_MS + options.scenarios.length * (options.seconds * 1000 + MEASURE_OVERHEAD_MS) + 120_000;
		setTimeout(() => {
			run.failures.push({ scenario: "run", message: `watchdog: the run did not finish within ${Math.round(budgetMs / 60_000)} min` });
			finish(1);
		}, budgetMs).unref();
		const projects = {};
		if (clips) {
			log("building the scenario projects through the UI ...");
			const session = await openSession({ userDataDir, levers: options.levers });
			try {
				for (const id of synthetic) {
					log(`  ${id}: ${SCENARIOS[id].title}`);
					try {
						projects[id] = await withTimeout(buildProject({ client: session.client, scenario: SCENARIOS[id], clips: clips.files, seconds: options.seconds }), SETUP_BUDGET_MS, `build ${id}`);
					} catch (error) {
						run.failures.push({ scenario: id, message: `setup: ${error.message}` });
						log(`  ${id} could not be built: ${error.message}`);
					}
				}
				await ed.waitSaved(session.client, readProjects).catch(() => {});
			} finally {
				await closeSession(session).catch(() => {});
			}
		}
		if (options.project) projects.project = { projectId: options.project };
		for (const id of options.scenarios) {
			if (!projects[id]) continue;
			log(`measuring ${id} (${options.seconds} s of playback) ...`);
			try {
				const raw = await withTimeout(measureScenario({ userDataDir, scenarioId: id, projectId: projects[id].projectId, options, clkTck: clkTck.clkTck }), options.seconds * 1000 + MEASURE_OVERHEAD_MS, `measure ${id}`);
				run.scenarios[id] = buildScenarioResult(raw);
			} catch (error) {
				state.activeApp?.child.kill("SIGKILL");
				state.activeApp = null;
				run.failures.push({ scenario: id, message: error.message });
				log(`  ${id} failed: ${error.message}`);
			}
		}
	} catch (error) {
		run.failures.push({ scenario: "run", message: error.message });
	}
	finish(run.failures.length > 0 ? 1 : 0);
}

function compareMode({ before, after }) {
	const read = (file) => {
		let parsed = null;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (error) {
			throw new HarnessError(`${file}: ${error.message}`);
		}
		if (!parsed || parsed.schema !== RUN_SCHEMA) throw new HarnessError(`${file} is not a perf-two-clips result file`);
		return parsed;
	};
	console.log(formatCompareTable(compareRuns({ before: read(before), after: read(after) })));
}

async function main() {
	let options;
	try {
		options = parseArgs({ argv: process.argv.slice(2) });
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(`${error.message}\n\n${usage()}`);
		process.exit(2);
	}
	if (options.mode === "help") return console.log(usage());
	if (options.mode === "compare") return compareMode(options);
	return runMode(options);
}

main().catch((error) => {
	console.error(error instanceof HarnessError ? error.message : error && error.stack ? error.stack : error);
	state.activeApp?.child.kill("SIGKILL");
	cleanup();
	process.exit(1);
});
