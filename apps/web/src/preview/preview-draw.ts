import { type PlaybackHudRecorder, playbackHud } from "@/diagnostics/playback-hud/recorder";
import { effectPassesOfFrame, type HudProbe } from "@/diagnostics/playback-hud/session";
import type { CanvasRenderer, PreviewRenderOptions } from "@/services/renderer/canvas-renderer";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import type { AnyBaseNode } from "@/services/renderer/nodes/base-node";
import { videoCache } from "@/services/video-cache/service";
import {
	type PreviewDrawResult,
	drawPreviewFrame,
	shouldRetryWithoutEffects,
} from "./render-gate";
import type { PreviewHudSink } from "./settle-draw";

/** Totals the playback HUD compares before and after a draw. */
export function readPlaybackProbe(): HudProbe {
	return {
		atMs: performance.now(),
		cache: videoCache.getCounters(),
		uploads: wasmCompositor.getUploadStats(),
	};
}

/**
 * One preview draw as the preview component makes it: with the scene's
 * effects (unless they failed for it before), once more without them when it
 * fails, never rejecting (`drawPreviewFrame`).
 */
export function drawPreviewScene({
	renderer,
	scene,
	time,
	preview,
	maxStaleSeconds,
	effectsFirst,
	isExporting,
}: {
	renderer: CanvasRenderer;
	scene: AnyBaseNode;
	time: number;
	preview: PreviewRenderOptions;
	maxStaleSeconds: number;
	effectsFirst: boolean;
	isExporting: () => boolean;
}): Promise<PreviewDrawResult> {
	return drawPreviewFrame({
		draw: ({ effects }) =>
			videoCache.withPlaybackTolerance({
				maxStaleSeconds,
				run: () => renderer.render({ node: scene, time, effects, preview }),
			}),
		serialNow: () => wasmCompositor.getDrawSerial(),
		mayRetry: () =>
			shouldRetryWithoutEffects({
				isExporting: isExporting(),
				effectGroups: renderer.lastEffectWork.groups,
			}),
		effectsFirst,
	});
}

/** What the playback HUD records of a draw that started with `before` (the HUD was on). */
export function hudSinkFor({
	before,
	renderer,
	hud = playbackHud,
}: {
	before: HudProbe;
	renderer: CanvasRenderer;
	hud?: PlaybackHudRecorder;
}): PreviewHudSink {
	return {
		recordDrawn: () => {
			hud.recordFrame({
				before,
				after: readPlaybackProbe(),
				effectPasses: effectPassesOfFrame(renderer.lastFrame),
			});
			hud.recordBitmapStats(wasmCompositor.getUploadStats());
			if (renderer.lastFrame) {
				hud.recordDisplaySize({
					width: renderer.lastFrame.width,
					height: renderer.lastFrame.height,
					scale: renderer.lastFrame.width / renderer.width,
				});
			}
		},
		recordNotDrawn: () => hud.recordNotDrawn(),
		recordRenderError: (args) => hud.recordRenderError(args),
		recordGpuErrorStats: (stats) => hud.recordGpuErrorStats(stats),
	};
}
