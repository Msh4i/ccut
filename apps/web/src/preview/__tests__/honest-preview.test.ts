import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as opencutWasm from "opencut-wasm";
import { registerDefaultEffects } from "@/effects";
import { PlaybackHudRecorder } from "@/diagnostics/playback-hud/recorder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { readGpuErrorStats } from "@/services/renderer/gpu-errors";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { usePlaybackLeversStore } from "@/services/playback-levers/store";
import { type LeverKey } from "@/services/playback-levers/levers";
import { videoCache } from "@/services/video-cache/service";
import { drawPreviewScene, hudSinkFor, readPlaybackProbe } from "../preview-draw";
import {
	EffectFailureMemory,
	GpuErrorWatcher,
	RenderErrorReporter,
} from "../render-gate";
import { type PreviewNoticeSink, settlePreviewDraw } from "../settle-draw";

// B2, the honesty contract of the preview. Whatever goes wrong while a frame is
// drawn, the user must be told (never the old frame left silently), once, and
// told no more when it is over; the playback HUD must say the same, correctly,
// with each experimental lever off and on. The pieces run for real (the
// renderer, the compositor's texture cache, the retry, the notice state, the
// HUD recorder); the GPU (opencut-wasm's draw and upload calls) and the video
// cache's frames are fakes that fail on command. Nothing here has seen a GPU.

registerDefaultEffects();

type Gpu = {
	draws: Array<{ width: number; height: number; passes: number }>;
	uploads: Array<{ fn: "uploadTexture" | "uploadTextureReuse" }>;
	onDraw: (frame: { width: number; height: number; passes: number }) => void;
	onUpload: () => void;
	gpuErrorCount: number;
};

const gpu: Gpu = {
	draws: [],
	uploads: [],
	onDraw: () => {},
	onUpload: () => {},
	gpuErrorCount: 0,
};

const realWasmExports = { ...opencutWasm };

function passesOf(frame: unknown): number {
	const items: unknown = Reflect.get(Object(frame), "items");
	if (!Array.isArray(items)) return 0;
	let passes = 0;
	for (const item of items) {
		const groups: unknown = Reflect.get(Object(item), "effectPassGroups");
		if (Array.isArray(groups)) for (const group of groups) passes += Array.isArray(group) ? group.length : 0;
	}
	return passes;
}

mock.module("opencut-wasm", () => ({
	...realWasmExports,
	getCompositorCanvas: () => ({}),
	getLastFrameProfile: () => [],
	initCompositor: () => {},
	releaseTexture: () => {},
	resizeCompositor: () => {},
	renderFrame: (frame: { width: number; height: number }) => {
		const entry = { width: frame.width, height: frame.height, passes: passesOf(frame) };
		gpu.draws.push(entry);
		gpu.onDraw(entry);
	},
	uploadTexture: () => {
		gpu.uploads.push({ fn: "uploadTexture" });
		gpu.onUpload();
	},
	uploadTextureReuse: () => {
		gpu.uploads.push({ fn: "uploadTextureReuse" });
		gpu.onUpload();
		return false;
	},
}));

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	getContext() {
		return { clearRect: () => {}, drawImage: () => {}, fillRect: () => {} };
	}
}

const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");

type FrameAnswer = "frame" | "none" | Error;
let frameAnswer: FrameAnswer = "frame";
const asked: Array<{ allowWorker: boolean }> = [];
let frameNo = 0;

const getFrameAt = spyOn(videoCache, "getFrameAt");
const peekDisplaySize = spyOn(videoCache, "peekDisplaySize");

beforeAll(() => {
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: FakeOffscreenCanvas,
	});
	getFrameAt.mockImplementation(async (request) => {
		asked.push({ allowWorker: request.allowWorker === true });
		if (frameAnswer instanceof Error) throw frameAnswer;
		if (frameAnswer === "none") return null;
		frameNo += 1;
		return {
			canvas: new OffscreenCanvas(1920, 1080),
			timestamp: frameNo,
			duration: 1 / 30,
			scale: 1,
			displayWidth: 1920,
			displayHeight: 1080,
		};
	});
	peekDisplaySize.mockImplementation(() => ({ width: 1920, height: 1080 }));
});

afterAll(() => {
	getFrameAt.mockRestore();
	peekDisplaySize.mockRestore();
	mock.module("opencut-wasm", () => realWasmExports);
	if (originalOffscreenCanvas) Object.defineProperty(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});

const LEVER_SETS: ReadonlyArray<{ name: string; on: LeverKey[] }> = [
	{ name: "levers off", on: [] },
	{ name: "display on", on: ["displayResolution"] },
	{ name: "bitmap on", on: ["bitmapUpload"] },
	{ name: "worker on", on: ["decodeWorker"] },
	{ name: "all levers on", on: ["displayResolution", "bitmapUpload", "decodeWorker"] },
];

function setLevers(on: LeverKey[]) {
	const { setLever } = usePlaybackLeversStore.getState();
	for (const key of ["displayResolution", "bitmapUpload", "decodeWorker"] as const) {
		setLever({ key, on: on.includes(key) });
	}
}

function clip({ withBlur }: { withBlur: boolean }) {
	const root = new RootNode({ duration: 4000 });
	root.add(
		new VideoNode({
			duration: 4000,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 0,
			transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
			opacity: 1,
			url: "blob:clip",
			file: new File([], "clip.mp4"),
			mediaId: "clip",
			elementId: "el-1",
			effects: withBlur
				? [{ id: "fx", type: "blur", params: { intensity: 15 }, enabled: true }]
				: [],
		}),
	);
	return root;
}

/** A user's view: the notice (one toast id) and what the console got. */
function fakeNotices() {
	const view = {
		shown: [] as Array<{ level: string; title: string; description: string }>,
		dismissed: 0,
		visible: null as { level: string; title: string; description: string } | null,
		logged: [] as string[],
	};
	const sink: PreviewNoticeSink = {
		show: ({ level, title, description }) => {
			view.shown.push({ level, title, description });
			view.visible = { level, title, description };
		},
		dismiss: () => {
			view.dismissed += 1;
			view.visible = null;
		},
		logError: ({ label }) => {
			view.logged.push(label);
		},
	};
	return { view, sink };
}

/** The preview as the component runs it, one draw at a time on a fake clock. */
function previewSession() {
	const memory = new EffectFailureMemory<object>();
	const reporter = new RenderErrorReporter();
	const gpuWatcher = new GpuErrorWatcher();
	const { view, sink } = fakeNotices();
	const hud = new PlaybackHudRecorder();
	const recordFrame = spyOn(hud, "recordFrame").mockImplementation(() => {});
	const recordRenderError = spyOn(hud, "recordRenderError");
	const renderer = new CanvasRenderer({ width: 1080, height: 1920, fps: { numerator: 30, denominator: 1 } });
	let nowMs = 10_000;
	return {
		view,
		hud,
		renderer,
		recordFrame,
		recordRenderError,
		advance: (ms: number) => {
			nowMs += ms;
		},
		async draw({ scene }: { scene: RootNode }) {
			const levers = usePlaybackLeversStore.getState().levers;
			const effectsFirst = memory.tryEffects(scene);
			const before = readPlaybackProbe();
			const result = await drawPreviewScene({
				renderer,
				scene,
				time: 0,
				preview: { sourceDensity: 0.5, renderScale: levers.displayResolution ? 0.5 : 1 },
				maxStaleSeconds: 0.09,
				effectsFirst,
				isExporting: () => false,
			});
			settlePreviewDraw({
				result,
				scene,
				effectsFirst,
				nowMs,
				projectId: "p1",
				gpuStats: readGpuErrorStats({
					wasm: { getGpuErrorStats: () => ({ count: gpu.gpuErrorCount, lastMessage: "Validation Error: bad bind group" }) },
				}),
				memory,
				reporter,
				gpuWatcher,
				notices: sink,
				hud: hudSinkFor({ before, renderer, hud }),
			});
			nowMs += 20;
			return result;
		},
		dump() {
			const log = spyOn(console, "log").mockImplementation(() => {});
			try {
				return hud.dump();
			} finally {
				log.mockRestore();
			}
		},
	};
}

function resetFakes() {
	gpu.draws = [];
	gpu.uploads = [];
	gpu.onDraw = () => {};
	gpu.onUpload = () => {};
	gpu.gpuErrorCount = 0;
	frameAnswer = "frame";
	asked.length = 0;
}

beforeEach(resetFakes);
afterEach(() => setLevers([]));

for (const { name, on } of LEVER_SETS) {
	describe(`the preview is honest with ${name}`, () => {
		beforeEach(() => setLevers(on));
		const scaled = on.includes("displayResolution");
		const frameWidth = scaled ? 540 : 1080;

		test("a draw that throws: one notice while it lasts, the HUD says why, it goes when the draw works again", async () => {
			const preview = previewSession();
			const scene = clip({ withBlur: true });
			gpu.onDraw = () => {
				throw new Error("device lost");
			};
			for (let n = 0; n < 4; n += 1) {
				const result = await preview.draw({ scene: n % 2 === 0 ? scene : clip({ withBlur: true }) });
				// never silent: a failed draw always leaves a notice on screen
				expect(result.error).not.toBeNull();
				expect(preview.view.visible?.title).toBe("The preview could not draw this frame");
			}
			// one notice for four failed draws (a scene edit between them does not repeat it)
			expect(preview.view.shown).toHaveLength(1);
			expect(preview.view.logged).toEqual(["Preview render failed:"]);
			expect(preview.dump()).toContain("last render error: device lost");
			expect(preview.recordRenderError).toHaveBeenCalledTimes(4);
			// no picture was made: the HUD does not claim a draw or a frame size
			expect(preview.recordFrame).not.toHaveBeenCalled();
			expect(preview.dump()).toMatch(/display (on n\/a|off)/);

			// the error ends: still shown within a second, gone after it
			gpu.onDraw = () => {};
			const drawsBefore = gpu.draws.length;
			await preview.draw({ scene });
			// the compositor does not take the failed frame for one it already shows
			expect(gpu.draws).toHaveLength(drawsBefore + 1);
			expect(preview.view.visible).not.toBeNull();
			preview.advance(1500);
			await preview.draw({ scene });
			expect(preview.view.visible).toBeNull();
			expect(preview.view.dismissed).toBe(1);
			expect(preview.view.shown).toHaveLength(1);
		});

		test("after a draw that left no picture the HUD does not show the last frame size as current", async () => {
			const preview = previewSession();
			const scene = clip({ withBlur: true });
			await preview.draw({ scene });
			if (scaled) expect(preview.dump()).toContain("display on 540x960");
			gpu.onDraw = () => {
				throw new Error("device lost");
			};
			await preview.draw({ scene: clip({ withBlur: true }) });
			expect(preview.dump()).toMatch(/display (on n\/a|off)/);
			expect(preview.dump()).not.toContain("540x960");
		});

		test("an effect that fails: drawn without effects at the same size, one notice, the HUD counts every draw without them", async () => {
			const preview = previewSession();
			const scene = clip({ withBlur: true });
			gpu.onDraw = ({ passes }) => {
				if (passes > 0) throw new Error("GPU error: bad bind group");
			};
			const first = await preview.draw({ scene });
			expect(first.effectsDropped).toBe(true);
			expect(preview.view.visible?.title).toBe("An effect could not be drawn");
			// tried with effects (failed), then drawn again without: both at the compositor size of the lever
			expect(gpu.draws.map(({ width, passes }) => ({ width, passes }))).toEqual([
				{ width: frameWidth, passes: 2 },
				{ width: frameWidth, passes: 0 },
			]);
			// the HUD took the numbers of the picture that was drawn: no effect passes
			expect(preview.recordFrame.mock.calls.map(([call]) => call.effectPasses)).toEqual([0]);

			// the same scene again: effects stay off, a picture is drawn each time, the notice stays and is not repeated
			for (let n = 0; n < 3; n += 1) {
				const next = await preview.draw({ scene });
				expect(next.error).toBeNull();
				expect(preview.view.visible?.title).toBe("An effect could not be drawn");
			}
			expect(gpu.draws).toHaveLength(5);
			expect(preview.view.shown).toHaveLength(1);
			// every one of the 4 draws without the effect is a failed draw for the HUD, with the message
			expect(preview.recordRenderError).toHaveBeenCalledTimes(4);
			expect(preview.dump()).toContain("last render error: GPU error: bad bind group");

			// the user removes the effect: a clean scene, the notice goes after a quiet second
			const fixed = clip({ withBlur: false });
			await preview.draw({ scene: fixed });
			preview.advance(1500);
			await preview.draw({ scene: fixed });
			expect(preview.view.visible).toBeNull();
			expect(preview.view.shown).toHaveLength(1);
		});

		test("an effect that works again after an edit is drawn with its passes and the HUD counts them", async () => {
			const preview = previewSession();
			let broken = true;
			gpu.onDraw = ({ passes }) => {
				if (broken && passes > 0) throw new Error("effect failed");
			};
			await preview.draw({ scene: clip({ withBlur: true }) });
			expect(preview.view.visible).not.toBeNull();
			broken = false;
			preview.advance(1500);
			const edited = clip({ withBlur: true });
			await preview.draw({ scene: edited });
			preview.advance(1500);
			await preview.draw({ scene: edited });
			expect(preview.view.visible).toBeNull();
			// 0 passes for the draw without effects, then the lever-independent count of the blur
			expect(preview.recordFrame.mock.calls.map(([call]) => call.effectPasses)).toEqual([0, 2, 2]);
		});

		test("a failing upload is not remembered as done, and says so", async () => {
			const preview = previewSession();
			const scene = clip({ withBlur: true });
			gpu.onUpload = () => {
				throw new Error("copy failed");
			};
			const result = await preview.draw({ scene });
			expect(result.error).not.toBeNull();
			expect(preview.view.visible?.title).toBe("The preview could not draw this frame");
			// the compositor never claimed a picture: nothing was drawn
			expect(gpu.draws).toHaveLength(0);
			expect(preview.dump()).toContain("last render error: copy failed");
			const uploadsBefore = gpu.uploads.length;
			expect(gpu.uploads.every((upload) => upload.fn === (on.includes("bitmapUpload") ? "uploadTextureReuse" : "uploadTexture"))).toBe(true);

			// the upload works again: it is tried again (not skipped as cached) and the frame is drawn
			gpu.onUpload = () => {};
			preview.advance(1500);
			await preview.draw({ scene });
			expect(gpu.uploads.length).toBeGreaterThan(uploadsBefore);
			expect(gpu.draws).toHaveLength(1);
			preview.advance(1500);
			await preview.draw({ scene });
			expect(preview.view.visible).toBeNull();
		});

		test("a video frame that cannot be made (a worker or decoder error): a notice, one try, the lever's path was the one asked", async () => {
			const preview = previewSession();
			frameAnswer = new Error("The worker could not draw the frame");
			for (let n = 0; n < 3; n += 1) {
				const result = await preview.draw({ scene: clip({ withBlur: true }) });
				expect(result.error).not.toBeNull();
				expect(preview.view.visible?.title).toBe("The preview could not draw this frame");
			}
			expect(preview.view.shown).toHaveLength(1);
			expect(gpu.draws).toHaveLength(0);
			expect(preview.dump()).toContain("last render error: The worker could not draw the frame");
			// only the preview asks for a worker, and only with the lever on
			expect(asked.every((request) => request.allowWorker === on.includes("decodeWorker"))).toBe(true);
			frameAnswer = "frame";
			preview.advance(1500);
			await preview.draw({ scene: clip({ withBlur: true }) });
			preview.advance(1500);
			await preview.draw({ scene: clip({ withBlur: true }) });
			expect(preview.view.visible).toBeNull();
		});

		test("the GPU reporting an error after a draw that looked fine (WebGPU): one notice, the HUD counts it, it goes when no more come", async () => {
			const preview = previewSession();
			const scene = clip({ withBlur: true });
			await preview.draw({ scene });
			expect(preview.view.visible).toBeNull();
			gpu.gpuErrorCount = 1;
			for (let n = 0; n < 3; n += 1) await preview.draw({ scene });
			expect(preview.view.visible?.title).toBe("The GPU reported an error");
			expect(preview.view.shown).toHaveLength(1);
			expect(preview.dump()).toContain("gpu errors: 1 (last: Validation Error: bad bind group)");
			expect(preview.dump()).toContain("last render error: GPU error: Validation Error: bad bind group");
			preview.advance(1500);
			await preview.draw({ scene });
			expect(preview.view.visible).toBeNull();
		});

		test("a good draw: the HUD shows its effect passes (the same with every lever), the levers and the sizes", async () => {
			const preview = previewSession();
			const scene = clip({ withBlur: true });
			await preview.draw({ scene });
			await preview.draw({ scene });
			expect(preview.view.visible).toBeNull();
			expect(preview.view.shown).toHaveLength(0);
			expect(preview.recordFrame.mock.calls.map(([call]) => call.effectPasses)).toEqual([2, 2]);
			const text = preview.dump();
			expect(text).toContain("last render error: none");
			expect(text).toContain("gpu errors: 0");
			expect(text).toContain(`worker ${on.includes("decodeWorker") ? "on" : "off"}`);
			expect(text).toMatch(
				on.includes("bitmapUpload") ? /bitmap on reused 0 created \d+ staging 0/ : /bitmap off/,
			);
			expect(text).toContain(scaled ? "display on 540x960 (x0.5)" : "display off");
		});
	});
}
