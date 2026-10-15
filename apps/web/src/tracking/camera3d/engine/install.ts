import type { MediaAsset } from "@/media/types";
import { getTextMeasurementContext, measureTextElement } from "@/text/measure-element";
import type { SceneTracks } from "@/timeline";
import { yieldToUi } from "@/tracking/camera/yield-to-ui";
import { decodeGrayFrames } from "@/tracking/frame-source";
import type { MediaTime } from "@/wasm";
import { registerCameraTrackerApi, useCameraTrackerSession } from "../session";
import type { SolveCamera } from "../types";
import {
	createCameraTrackerEngine,
	type CameraTrackerEngine,
	type CameraTrackerEngineDeps,
	type CameraTrackerWriter,
} from "./engine";
import { findVideoClip } from "./tracker-tracks";

/** What the installation reads of the editor (`EditorCore` fits). */
export interface CameraTrackerEditor {
	playback: { pause(): void; getCurrentTime(): MediaTime };
	project: {
		subscribe(listener: () => void): () => void;
		getActiveOrNull(): {
			metadata: { id: string };
			settings: { canvasSize: { width: number; height: number } };
		} | null;
	};
	timeline: CameraTrackerWriter & { subscribe(listener: () => void): () => void };
	scenes: {
		subscribe(listener: () => void): () => void;
		getActiveSceneOrNull(): { tracks: SceneTracks } | null;
		getScenes(): Array<{ tracks: SceneTracks }>;
	};
	media: {
		getAssets(): Array<Pick<MediaAsset, "id" | "file" | "type" | "name" | "width" | "height" | "fps">>;
	};
}

function editorDeps({
	editor,
	solveCamera,
}: {
	editor: CameraTrackerEditor;
	solveCamera: SolveCamera;
}): CameraTrackerEngineDeps {
	return {
		readScene: () => {
			const project = editor.project.getActiveOrNull();
			const scene = editor.scenes.getActiveSceneOrNull();
			if (!project || !scene) return null;
			return {
				tracks: scene.tracks,
				canvasSize: project.settings.canvasSize,
				playhead: editor.playback.getCurrentTime(),
			};
		},
		media: ({ mediaId }) => {
			const asset = editor.media.getAssets().find((candidate) => candidate.id === mediaId);
			return asset
				? {
						file: asset.file ?? null,
						type: asset.type,
						name: asset.name,
						width: asset.width,
						height: asset.height,
						fps: asset.fps,
					}
				: null;
		},
		pause: () => editor.playback.pause(),
		decode: ({ file, sourceTimes, signal, maxWidth }) =>
			decodeGrayFrames({ file, sourceTimes, signal, maxWidth }),
		solveCamera,
		yieldToUi,
		now: () => performance.now(),
		measureText: ({ element, canvasSize }) => {
			const measured = measureTextElement({
				element: { ...element, id: "track-camera-measure" },
				canvasHeight: canvasSize.height,
				localTime: 0,
				ctx: getTextMeasurementContext(),
			});
			return { width: measured.visualRect.width, height: measured.visualRect.height };
		},
		writer: editor.timeline,
	};
}

/** The media a video clip plays now, in whichever scene it lives; `null` when it is gone. */
function clipMediaId({ editor, elementId }: { editor: CameraTrackerEditor; elementId: string }): string | null {
	for (const scene of editor.scenes.getScenes()) {
		const clip = findVideoClip({ tracks: scene.tracks, elementId });
		if (clip) return clip.element.mediaId;
	}
	return null;
}

let activeTeardown: (() => void) | null = null;

/**
 * Creates the Track Camera engine for this editor session, registers it as
 * the `CameraTrackerApi`, and keeps its session state in step with the
 * project: a clip's kept analysis, pending settings and outcome go when the
 * clip is deleted or plays other media, everything goes when another
 * project opens. Returns the teardown (stops a running job, unsubscribes,
 * unregisters, forgets the outcomes); installing again tears the earlier
 * installation down first (hot reload).
 */
export function installCameraTrackerEngine({
	editor,
	solveCamera,
	deps = {},
}: {
	editor: CameraTrackerEditor;
	solveCamera: SolveCamera;
	/** Replacements for parts of the editor-bound dependencies (tests). */
	deps?: Partial<CameraTrackerEngineDeps>;
}): () => void {
	activeTeardown?.();
	const engine: CameraTrackerEngine = createCameraTrackerEngine({
		deps: { ...editorDeps({ editor, solveCamera }), ...deps },
	});
	registerCameraTrackerApi(engine);

	let projectId = editor.project.getActiveOrNull()?.metadata.id ?? null;
	const sync = () => {
		const now = editor.project.getActiveOrNull()?.metadata.id ?? null;
		if (now !== projectId) {
			projectId = now;
			engine.clearSession();
			return;
		}
		engine.prune({ mediaIdOf: (elementId) => clipMediaId({ editor, elementId }) });
	};
	const unsubscribes = [
		editor.project.subscribe(sync),
		editor.timeline.subscribe(sync),
		editor.scenes.subscribe(sync),
	];

	const teardown = () => {
		if (activeTeardown !== teardown) return;
		activeTeardown = null;
		for (const unsubscribe of unsubscribes) unsubscribe();
		engine.dispose();
		registerCameraTrackerApi(null);
		const { outcomes, forget } = useCameraTrackerSession.getState();
		for (const elementId of Object.keys(outcomes)) forget({ elementId });
	};
	activeTeardown = teardown;
	return teardown;
}
