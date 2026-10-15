import { createCanvasSurface } from "./canvas-utils";
import { effectsRegistry, resolveEffectPasses } from "@/effects";
import type { EffectPass } from "@/effects/types";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { gpuRenderer } from "./gpu-renderer";

const PREVIEW_SIZE = 160;
const PREVIEW_IMAGE_PATH = "/effects/preview.jpg";

/**
 * Runs a thumbnail's effect passes on the GPU.
 *
 * On the WebGL fallback wgpu can only present through the one canvas its GL
 * context was made on, and that canvas is also the compositor's output canvas
 * mounted in the preview (rust/wasm/src/compositor.rs, initCompositor): the
 * thumbnail resizes it and draws into it. The compositor is told, so the
 * preview draws its frame again (the compositor puts its size back first). On
 * WebGPU the thumbnail has a canvas of its own and this costs one redraw.
 */
export function applyThumbnailEffect({
	source,
	width,
	height,
	passes,
	gpu = gpuRenderer,
	compositor = wasmCompositor,
}: {
	source: OffscreenCanvas;
	width: number;
	height: number;
	passes: EffectPass[];
	gpu?: Pick<typeof gpuRenderer, "applyEffect">;
	compositor?: Pick<typeof wasmCompositor, "noteCanvasDisturbed">;
}): OffscreenCanvas {
	try {
		return gpu.applyEffect({ source, width, height, passes });
	} finally {
		if (passes.length > 0) {
			compositor.noteCanvasDisturbed();
		}
	}
}

/**
 * Length of the hover loop in the Assets grid, and the effect duration the
 * thumbnail pretends to have. 4 s fits one full sweep of the slowest effect
 * (Light leak) and replays the one-shot ones (Flash, Punch zoom) each loop.
 */
export const EFFECT_PREVIEW_LOOP_SECONDS = 4;

class EffectPreviewService {
	private testSourceCanvas: OffscreenCanvas | null = null;
	private previewImageElement: HTMLImageElement | null = null;
	private onReadyCallbacks = new Set<() => void>();

	readonly PREVIEW_SIZE = PREVIEW_SIZE;

	constructor() {
		this.loadPreviewImage();
	}

	onPreviewImageReady({ callback }: { callback: () => void }): () => void {
		this.onReadyCallbacks.add(callback);
		return () => this.onReadyCallbacks.delete(callback);
	}

	renderPreview({
		effectType,
		params,
		targetCanvas,
		uniformDimensions,
		localTimeSeconds,
	}: {
		effectType: string;
		params: ParamValues;
		targetCanvas: HTMLCanvasElement;
		uniformDimensions?: { width: number; height: number };
		/** Defaults to the effect's own still-thumbnail moment. */
		localTimeSeconds?: number;
	}): void {
		const size = PREVIEW_SIZE;
		const targetCtx = targetCanvas.getContext(
			"2d",
		) as CanvasRenderingContext2D | null;
		if (!targetCtx) {
			return;
		}

		targetCanvas.width = size;
		targetCanvas.height = size;

		const source = this.getTestSource({ width: size, height: size });
		if (!source) {
			targetCtx.clearRect(0, 0, size, size);
			return;
		}

		try {
			const definition = effectsRegistry.get(effectType);
			const resolvedParams =
				Object.keys(params).length > 0
					? params
					: buildDefaultParamValues(definition.params);

			const passes = resolveEffectPasses({
				definition,
				effectParams: resolvedParams,
				width: uniformDimensions?.width ?? size,
				height: uniformDimensions?.height ?? size,
				localTimeSeconds:
					localTimeSeconds ?? definition.previewTimeSeconds ?? 0,
				durationSeconds: EFFECT_PREVIEW_LOOP_SECONDS,
			});
			const result = applyThumbnailEffect({
				source,
				width: size,
				height: size,
				passes,
			});

			targetCtx.drawImage(result, 0, 0, size, size);
		} catch (error) {
			console.warn("Failed to render effect preview", { effectType, error });
			targetCtx.clearRect(0, 0, size, size);
			targetCtx.drawImage(source, 0, 0, size, size);
		}
	}

	private loadPreviewImage(): void {
		if (typeof window === "undefined") return;
		const image = new Image();
		image.onload = () => {
			this.testSourceCanvas = null;
			for (const callback of this.onReadyCallbacks) {
				callback();
			}
		};
		image.src = PREVIEW_IMAGE_PATH;
		this.previewImageElement = image;
	}

	private createTestSource({
		width,
		height,
	}: {
		width: number;
		height: number;
	}): OffscreenCanvas | null {
		const isImageReady =
			this.previewImageElement?.complete &&
			(this.previewImageElement.naturalWidth ?? 0) > 0;
		if (!isImageReady || !this.previewImageElement) {
			return null;
		}

		const { canvas, context } = createCanvasSurface({ width, height });
		context.drawImage(this.previewImageElement, 0, 0, width, height);
		return canvas;
	}

	private getTestSource({
		width,
		height,
	}: {
		width: number;
		height: number;
	}): OffscreenCanvas | null {
		if (
			!this.testSourceCanvas ||
			this.testSourceCanvas.width !== width ||
			this.testSourceCanvas.height !== height
		) {
			this.testSourceCanvas = this.createTestSource({ width, height });
		}
		return this.testSourceCanvas;
	}
}

export const effectPreviewService = new EffectPreviewService();
