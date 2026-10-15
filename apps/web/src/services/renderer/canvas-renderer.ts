import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { descriptorForDraw } from "./compositor/scale-frame";
import type { FrameDescriptor } from "./compositor/types";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { type EffectWork, resolveRenderTree } from "./resolve";
import { type RenderLease, videoCache, withRenderLease } from "@/services/video-cache/service";
import { playbackLevers } from "@/services/playback-levers/store";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
	/**
	 * Export: a source that cannot be loaded stops the render with an error
	 * instead of being skipped (preview skips it and still draws the frame).
	 */
	strictSources?: boolean;
};

/**
 * Passed by the preview only (never by export, snapshot or thumbnail): the
 * draw may reuse the compositor's last one when nothing changed, and video
 * frames may be drawn at preview resolution.
 */
export type PreviewRenderOptions = {
	/**
	 * The scene's device pixels per scene pixel while the preview plays or
	 * scrubs (video frames are then drawn at about their size on screen); null
	 * when it is paused: full resolution, the picture of an export.
	 */
	sourceDensity: number | null;
	/**
	 * Share of the project size the compositor draws at while playing or
	 * scrubbing with the display-size lever on (`previewRenderScale`); 1 or
	 * absent: full size. Only taken while the lever is on.
	 */
	renderScale?: number;
};

export class CanvasRenderer {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	fps: FrameRate;
	strictSources: boolean;
	/**
	 * The frame last handed to the compositor (the playback HUD counts its effect
	 * passes, only while it is on). Null before the first draw.
	 */
	lastFrame: FrameDescriptor | null = null;
	/**
	 * Effects-panel work of the last render, also when it failed (EffectWork:
	 * clip effect groups and effect-track layers, not the background blur). The
	 * preview retries a failed frame without effects only when there was some.
	 */
	lastEffectWork: EffectWork = { groups: 0 };

	constructor({ width, height, fps, strictSources = false }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;
		this.strictSources = strictSources;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	getOutputCanvas(): HTMLCanvasElement {
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		return wasmCompositor.getCanvas();
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	/**
	 * Draws the frame into the shared compositor canvas. Returns the compositor's
	 * draw serial right after the draw: while it still equals the compositor's
	 * serial, the canvas shows this frame (nobody drew since).
	 */
	async render({
		node,
		time,
		effects = true,
		preview,
		onDrawn,
	}: {
		node: AnyBaseNode;
		time: number;
		/** False: draw the frame without its Effects-panel effects (the preview's retry after a failed draw). */
		effects?: boolean;
		/** The preview only; absent (export, snapshot, thumbnail): full resolution, every draw made. */
		preview?: PreviewRenderOptions;
		/**
		 * Runs right after the compositor drew this frame, in the same task: the
		 * shared compositor canvas still shows it (another renderer, the playing
		 * preview, may draw into it as soon as this render returns).
		 */
		onDrawn?: () => void;
	}): Promise<number> {
		// The video frames of this render stay untouched until it has uploaded
		// them (or failed): renders run alongside each other (a snapshot beside
		// the playing preview).
		return withRenderLease({
			cache: videoCache,
			run: (frameLease) => this.renderUnderLease({ node, time, effects, preview, onDrawn, frameLease }),
		});
	}

	private async renderUnderLease({
		node,
		time,
		effects,
		preview,
		onDrawn,
		frameLease,
	}: {
		node: AnyBaseNode;
		time: number;
		effects: boolean;
		preview: PreviewRenderOptions | undefined;
		onDrawn: (() => void) | undefined;
		frameLease: RenderLease;
	}): Promise<number> {
		// A new object per render, filled while resolving: readable after a failure.
		const effectWork: EffectWork = { groups: 0 };
		this.lastEffectWork = effectWork;
		await measureSpanAsync({
			name: "resolve",
			fn: () =>
				resolveRenderTree({
					node,
					renderer: this,
					time,
					effects,
					effectWork,
					sourceDensity: preview?.sourceDensity ?? null,
					frameLease,
					// Only the preview's streams may decode on a worker.
					allowWorker: preview !== undefined && playbackLevers().decodeWorker,
				}),
		});
		const built = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});
		// Resolved in project pixels; a playing preview with the display-size
		// lever on is scaled to its compositor size here, at the end. Export,
		// snapshot and thumbnail (no `preview`) never are.
		const { frame, textures } = descriptorForDraw({
			frame: built.frame,
			textures: built.textures,
			preview,
			displayResolution: preview !== undefined && playbackLevers().displayResolution,
		});
		this.lastFrame = frame;
		wasmCompositor.ensureInitialized({
			width: frame.width,
			height: frame.height,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () =>
				wasmCompositor.syncTextures({
					textures,
					// Export, snapshot and thumbnail (no `preview`) never reuse.
					reuse: preview !== undefined && playbackLevers().bitmapUpload,
				}),
		});
		const serial = measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});
		onDrawn?.();
		return serial;
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		const ctx = targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		// Copied right after the draw: after the render returns, the playing
		// preview may already have drawn its own frame into the shared canvas.
		await this.render({
			node,
			time,
			onDrawn: () =>
				measureSpanSync({
					name: "drawImage",
					fn: () =>
						ctx.drawImage(
							wasmCompositor.getCanvas(),
							0,
							0,
							targetCanvas.width,
							targetCanvas.height,
						),
				}),
		});
		onRenderPerfFrameComplete();
	}
}
