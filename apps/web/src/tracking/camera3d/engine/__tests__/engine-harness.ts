import type { MediaAsset } from "@/media/types";
import type { SceneTracks } from "@/timeline";
import { renderFrame } from "@/tracking/__tests__/synthetic";
import type { GrayFrame } from "@/tracking/types";
import type { CameraState } from "@/scene3d/types";
import {
	useCameraTrackerSession,
} from "@/tracking/camera3d/session";
import type {
	CameraSolve,
	CameraSolveOutcome,
	CameraTrackerPhase,
	SolveCamera,
} from "@/tracking/camera3d/types";
import {
	createCameraTrackerEngine,
	type CameraTrackerEngine,
	type CameraTrackerEngineDeps,
	type CameraTrackerMedia,
} from "../engine";
import { createEditorHarness, sceneOf, type EditorHarness } from "./editor-harness";

export type DecodeArgs = Parameters<CameraTrackerEngineDeps["decode"]>[0];
export type SolveArgs = Parameters<SolveCamera>[0];

export const FRAME_W = 160;
export const FRAME_H = 90;

/** Frames that slide a textured picture, one per requested source time. */
export function slidingFrames({ count }: { count: number }): GrayFrame[] {
	return Array.from({ length: count }, (_, i) => renderFrame({ w: FRAME_W, h: FRAME_H, dx: 1.2 * i, dy: 0.4 * i }));
}

/** A solve that fits whatever tracks it is given: one camera per frame, a point per track (up to 4). */
export function solveFor({ args }: { args: SolveArgs }): CameraSolve {
	const { tracks, frameWidth, frameHeight } = args.input;
	const cameras: CameraState[] = Array.from({ length: tracks.frameCount }, (_, i) => ({
		rotation: [1, 0, 0, 0],
		position: [i * 2, 0, -1000],
		focalPx: 1200,
	}));
	return {
		frameWidth,
		frameHeight,
		cameras,
		solved: new Uint8Array(tracks.frameCount).fill(1),
		points: Array.from({ length: Math.min(4, tracks.trackStart.length) }, (_, trackId) => ({
			trackId,
			position: [trackId * 10, 0, 0],
			error: 0.5,
		})),
		methodUsed: "typical",
		averageError: 0.5,
		notices: [],
	};
}

/** A promise someone else resolves. */
export function gate(): { wait: Promise<void>; open: () => void } {
	let open = () => {};
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

export interface EngineHarness {
	editor: EditorHarness;
	engine: CameraTrackerEngine;
	media: Record<string, CameraTrackerMedia | null>;
	decodeCalls: DecodeArgs[];
	solveCalls: SolveArgs[];
	phases: CameraTrackerPhase[];
	scene: { open: boolean };
	dispose: () => void;
}

export const CLIP_MEDIA: CameraTrackerMedia = {
	file: new File([], "clip.mp4"),
	type: "video",
	name: "clip.mp4",
	width: 1920,
	height: 1080,
	fps: 30,
};

export function engineHarness({
	tracks = sceneOf(),
	media = { "media-clip": CLIP_MEDIA },
	assets = [],
	decode = ({ sourceTimes }) => slidingFrames({ count: sourceTimes.length }),
	solve = async ({ args }) => ({ status: "solved", solve: solveFor({ args }) }),
}: {
	tracks?: SceneTracks;
	media?: Record<string, CameraTrackerMedia | null>;
	assets?: MediaAsset[];
	decode?: (args: DecodeArgs) => Iterable<GrayFrame> | AsyncIterable<GrayFrame>;
	solve?: ({ args }: { args: SolveArgs }) => Promise<CameraSolveOutcome>;
} = {}): EngineHarness {
	const editor = createEditorHarness({ tracks, assets });
	const decodeCalls: DecodeArgs[] = [];
	const solveCalls: SolveArgs[] = [];
	const phases: CameraTrackerPhase[] = [];
	const scene = { open: true };
	let clock = 0;
	useCameraTrackerSession.setState({ phase: { phase: "idle" }, outcomes: {} });
	const unsubscribe = useCameraTrackerSession.subscribe((state, previous) => {
		if (state.phase !== previous.phase) phases.push(state.phase);
	});
	const deps: CameraTrackerEngineDeps = {
		readScene: () =>
			scene.open
				? { tracks: editor.state.tracks, canvasSize: editor.state.canvas, playhead: editor.state.playhead }
				: null,
		media: ({ mediaId }) => media[mediaId] ?? null,
		pause: () => {
			editor.state.paused++;
		},
		decode: (args) => {
			decodeCalls.push(args);
			const frames = decode(args);
			return (async function* () {
				yield* frames;
			})();
		},
		solveCamera: (args) => {
			solveCalls.push(args);
			return solve({ args });
		},
		yieldToUi: () => Promise.resolve(),
		now: () => {
			clock += 1000;
			return clock;
		},
		measureText: () => ({ width: 300, height: 80 }),
		writer: editor.editor.timeline,
	};
	const engine = createCameraTrackerEngine({ deps });
	return {
		editor,
		engine,
		media,
		decodeCalls,
		solveCalls,
		phases,
		scene,
		dispose: () => {
			engine.dispose();
			unsubscribe();
			editor.restore();
			useCameraTrackerSession.setState({ phase: { phase: "idle" }, outcomes: {} });
		},
	};
}
