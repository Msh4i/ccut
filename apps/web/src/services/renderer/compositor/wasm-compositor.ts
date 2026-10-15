import {
	getCompositorCanvas,
	getLastFrameProfile,
	initCompositor,
	releaseTexture,
	renderFrame,
	resizeCompositor,
	uploadTexture,
	uploadTextureReuse,
} from "opencut-wasm";
import {
	incrementCounter,
	isRenderPerfEnabled,
	recordWasmFrameProfile,
} from "@/diagnostics/render-perf";
import { isExternalTextureCurrent } from "./texture-cache";
import type {
	ExternalTextureDescriptor,
	FrameDescriptor,
	RenderedTextureDescriptor,
	TextureUploadDescriptor,
} from "./types";

/**
 * One slot in the derived-texture cache. The OffscreenCanvas is persistent —
 * we reuse and redraw into it across frames, which is the change that takes
 * the WebGL upload path off the per-frame critical path for static content.
 */
type RenderedCacheEntry = {
	kind: "rendered";
	canvas: OffscreenCanvas;
	contentHash: string;
	width: number;
	height: number;
};

type ExternalCacheEntry = {
	kind: "external";
	source: CanvasImageSource;
	width: number;
	height: number;
	version: number | undefined;
};

class WasmCompositor {
	private canvas: HTMLCanvasElement | null = null;
	private initializedSize: { width: number; height: number } | null = null;
	private cache = new Map<string, RenderedCacheEntry | ExternalCacheEntry>();
	/**
	 * Per layer, the OffscreenCanvas a source that is not one (an image, an
	 * HTMLCanvasElement) is copied into before the upload. Reused for the
	 * layer's later uploads instead of allocating a frame-sized canvas each
	 * time: the upload copies the canvas content at the call, and the rendered
	 * textures below already redraw one persistent canvas per layer the same way.
	 */
	private staging = new Map<string, OffscreenCanvas>();
	private uploads = 0;
	private uploadedPixels = 0;
	/** Reuse uploads (lever b) that copied into the layer's existing texture / that made a new one. */
	private texturesReused = 0;
	private texturesCreated = 0;
	/** Sources that went through a staging canvas before the upload. */
	private stagedUploads = 0;
	/** Video canvases skipped because their size changed after they were described. */
	private skippedResized = 0;
	/**
	 * Counts every change of the canvas content (a draw, or a resize that clears
	 * it). The preview, the exporter and the snapshot/thumbnail renderers all draw
	 * into this one canvas; a renderer compares the serial with the one its own
	 * last draw returned to learn whether the canvas still shows its picture.
	 */
	private drawSerial = 0;

	ensureInitialized({ width, height }: { width: number; height: number }) {
		if (!this.canvas) {
			initCompositor(width, height);
			this.canvas = getCompositorCanvas();
			this.initializedSize = { width, height };
			this.drawSerial += 1;
			return;
		}

		// The canvas itself too (defensive: the renderer already passes each
		// frame's size): a draw resizes it to its frame's size, so a full-size
		// canvas is restored after a display-size preview draw, and after a
		// thumbnail resized the shared canvas on the WebGL fallback.
		if (
			!this.initializedSize ||
			this.initializedSize.width !== width ||
			this.initializedSize.height !== height ||
			this.canvas.width !== width ||
			this.canvas.height !== height
		) {
			resizeCompositor(width, height);
			this.initializedSize = { width, height };
			this.drawSerial += 1;
		}
	}

	getDrawSerial(): number {
		return this.drawSerial;
	}

	/**
	 * Someone else drew into (or resized) the canvas: an effect thumbnail on the
	 * WebGL fallback, where wgpu presents through this one canvas. Renderers
	 * comparing serials then know their picture is gone.
	 */
	noteCanvasDisturbed(): void {
		this.drawSerial += 1;
	}

	/** Texture uploads since start (read by the playback HUD). */
	getUploadStats(): {
		uploads: number;
		uploadedPixels: number;
		skippedResized: number;
		reused: number;
		created: number;
		staging: number;
	} {
		return {
			uploads: this.uploads,
			uploadedPixels: this.uploadedPixels,
			skippedResized: this.skippedResized,
			reused: this.texturesReused,
			created: this.texturesCreated,
			staging: this.stagedUploads,
		};
	}

	getCanvas(): HTMLCanvasElement {
		if (!this.canvas) {
			throw new Error("Compositor is not initialized");
		}
		return this.canvas;
	}

	/**
	 * `reuse` (the playing preview with the bitmap lever on; export, snapshot and
	 * thumbnail pass false): uploads go through `uploadTextureReuse`, which
	 * copies into the layer's existing texture, and an ImageBitmap goes to the
	 * GPU as it is. Without it every upload is the old `uploadTexture`.
	 */
	syncTextures({
		textures,
		reuse,
	}: {
		textures: TextureUploadDescriptor[];
		reuse: boolean;
	}) {
		const nextIds = new Set(textures.map((texture) => texture.id));
		for (const previousId of this.cache.keys()) {
			if (!nextIds.has(previousId)) {
				releaseTexture(previousId);
				this.cache.delete(previousId);
				this.staging.delete(previousId);
			}
		}

		for (const texture of textures) {
			if (texture.kind === "external") {
				this.syncExternalTexture({ texture, reuse });
			} else {
				this.syncRenderedTexture({ texture, reuse });
			}
		}
	}

	/** Draws the frame. Returns the draw serial right after it. */
	render(frame: FrameDescriptor): number {
		renderFrame(frame);
		this.drawSerial += 1;
		if (isRenderPerfEnabled()) {
			recordWasmFrameProfile(
				getLastFrameProfile() as Array<{ name: string; durationMs: number }>,
			);
		}
		return this.drawSerial;
	}

	private syncExternalTexture({
		texture,
		reuse,
	}: {
		texture: ExternalTextureDescriptor;
		reuse: boolean;
	}) {
		// A canvas whose size changed since its layer was described (a video
		// frame canvas the frame cache freed, width and height 0) would fail the
		// GPU copy, which panics: the layer keeps its previous texture instead.
		// Same for a closed ImageBitmap (it reports 0x0), which only the reuse
		// path hands to the GPU.
		if (
			((typeof OffscreenCanvas !== "undefined" && texture.source instanceof OffscreenCanvas) ||
				(reuse && isImageBitmap(texture.source))) &&
			(texture.source.width !== texture.width || texture.source.height !== texture.height)
		) {
			this.skippedResized += 1;
			incrementCounter({ name: "textureSourceResized" });
			return;
		}
		const previous = this.cache.get(texture.id);
		if (
			isExternalTextureCurrent({
				previous: previous?.kind === "external" ? previous : undefined,
				next: {
					source: texture.source,
					width: texture.width,
					height: texture.height,
					version: texture.version,
				},
			})
		) {
			incrementCounter({ name: "textureCacheHit" });
			return;
		}

		this.countUpload({ width: texture.width, height: texture.height });
		if (reuse) {
			this.uploadReusing({
				id: texture.id,
				source: this.toReuseSource(texture),
				width: texture.width,
				height: texture.height,
			});
		} else {
			uploadTexture({
				id: texture.id,
				source: this.toUploadSource(texture),
				width: texture.width,
				height: texture.height,
			});
		}
		this.cache.set(texture.id, {
			kind: "external",
			source: texture.source,
			width: texture.width,
			height: texture.height,
			version: texture.version,
		});
	}

	private syncRenderedTexture({
		texture,
		reuse,
	}: {
		texture: RenderedTextureDescriptor;
		reuse: boolean;
	}) {
		const previous = this.cache.get(texture.id);
		if (
			previous?.kind === "rendered" &&
			previous.contentHash === texture.contentHash &&
			previous.width === texture.width &&
			previous.height === texture.height
		) {
			incrementCounter({ name: "textureCacheHit" });
			return;
		}

		const canvas =
			previous?.kind === "rendered" &&
			previous.width === texture.width &&
			previous.height === texture.height
				? previous.canvas
				: createBackingCanvas({
						width: texture.width,
						height: texture.height,
					});

		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error(`Failed to get 2d context for texture ${texture.id}`);
		}
		ctx.clearRect(0, 0, texture.width, texture.height);
		texture.draw(ctx);

		this.countUpload({ width: texture.width, height: texture.height });
		if (reuse) {
			this.uploadReusing({
				id: texture.id,
				source: canvas,
				width: texture.width,
				height: texture.height,
			});
		} else {
			uploadTexture({
				id: texture.id,
				source: canvas,
				width: texture.width,
				height: texture.height,
			});
		}
		this.cache.set(texture.id, {
			kind: "rendered",
			canvas,
			contentHash: texture.contentHash,
			width: texture.width,
			height: texture.height,
		});
	}

	/** `uploadTextureReuse`; it says whether it copied into the layer's existing texture. */
	private uploadReusing(options: {
		id: string;
		source: OffscreenCanvas | ImageBitmap;
		width: number;
		height: number;
	}) {
		if (uploadTextureReuse(options)) {
			this.texturesReused += 1;
			incrementCounter({ name: "textureReused" });
		} else {
			this.texturesCreated += 1;
			incrementCounter({ name: "textureCreated" });
		}
	}

	/** A bitmap goes to the GPU as it is; every other source as `toUploadSource` has it. */
	private toReuseSource(texture: ExternalTextureDescriptor): OffscreenCanvas | ImageBitmap {
		return isImageBitmap(texture.source) ? texture.source : this.toUploadSource(texture);
	}

	private countUpload({ width, height }: { width: number; height: number }) {
		this.uploads += 1;
		this.uploadedPixels += width * height;
		incrementCounter({ name: "textureUpload" });
		incrementCounter({ name: "textureUploadPixels", by: width * height });
	}

	/** The source itself when it is an OffscreenCanvas, else its copy in the layer's staging canvas. */
	private toUploadSource({
		id,
		source,
		width,
		height,
	}: ExternalTextureDescriptor): OffscreenCanvas {
		if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas) {
			return source;
		}

		this.stagedUploads += 1;
		let canvas = this.staging.get(id);
		if (!canvas || canvas.width !== width || canvas.height !== height) {
			canvas = createBackingCanvas({ width, height });
			this.staging.set(id, canvas);
		}
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error(`Failed to get 2d context for texture upload ${id}`);
		}
		context.clearRect(0, 0, width, height);
		context.drawImage(source, 0, 0, width, height);
		return canvas;
	}
}

export const wasmCompositor = new WasmCompositor();

function isImageBitmap(source: CanvasImageSource): source is ImageBitmap {
	return typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap;
}

function createBackingCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas {
	if (typeof OffscreenCanvas === "undefined") {
		throw new Error("OffscreenCanvas is not supported in this environment");
	}
	return new OffscreenCanvas(width, height);
}
