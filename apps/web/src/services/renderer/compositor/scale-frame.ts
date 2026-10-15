import { GAUSSIAN_BLUR_SHADER, blurPassStep } from "@/effects/definitions/blur";
import type { EffectPass } from "@/effects/types";
import { rasterScaleBucket } from "@/scene3d/render/raster-size";
import type {
	FrameDescriptor,
	FrameItemDescriptor,
	LayerMaskDescriptor,
	QuadTransformDescriptor,
	RenderedTextureDescriptor,
	TextureUploadDescriptor,
} from "./types";

/**
 * Lever (c) of docs/ccut/playback-p5-design.md section 2: the playing preview
 * composites at about its size on screen instead of the project size.
 *
 * The scene is resolved and described in project pixels as always; this pure
 * step scales the finished description once, at the end: quads, 3D
 * homographies, pixel-unit effect uniforms, mask feather and the frame-sized
 * textures the renderer rasterises. Textures sampled by UV (video and image
 * frames, 3D text, a downscaled blur backdrop) are left as they are.
 *
 * Export, snapshot and thumbnail renders never come here (they pass no
 * `preview`), and a paused preview has scale 1: their descriptors are the very
 * objects they were.
 */

export type ScaledFrame = {
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
};

/** What the preview passes for the compositor's scale (PreviewRenderOptions). */
export type PreviewScale = {
	/** Share of the project size to composite at while playing or scrubbing; absent or 1: full size. */
	renderScale?: number;
};

type Axis = { sx: number; sy: number };

/**
 * The compositor scale of a preview draw: the bucket of the preview's density
 * (rounded up to a power of sqrt 2, so the backing store is 1-1.41x the
 * on-screen pixels and never stretched up), at most 1. Full size when the
 * lever is off or the preview is paused (density null) or unusable.
 */
export function previewRenderScale({
	displayResolution,
	sourceDensity,
}: {
	displayResolution: boolean;
	sourceDensity: number | null;
}): number {
	if (!displayResolution || sourceDensity === null) return 1;
	if (!Number.isFinite(sourceDensity) || sourceDensity <= 0) return 1;
	return Math.min(1, rasterScaleBucket(sourceDensity));
}

/**
 * The description the compositor draws: scaled only for a preview draw with
 * the lever on and a scale below 1, and only when every effect of the frame
 * can be scaled; anything else is the description as built.
 */
export function descriptorForDraw({
	frame,
	textures,
	preview,
	displayResolution,
}: {
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
	preview: PreviewScale | undefined;
	displayResolution: boolean;
}): ScaledFrame {
	const scale = preview !== undefined && displayResolution ? (preview.renderScale ?? 1) : 1;
	if (!(scale < 1)) return { frame, textures };
	return scaleFrameDescriptor({ frame, textures, scale }) ?? { frame, textures };
}

/**
 * The frame composited at `scale` of its size. `scale` not in (0, 1): the same
 * objects. Null when the frame holds a pixel-unit quantity this does not know
 * how to scale (an unknown shader): the caller then draws it at full size.
 */
export function scaleFrameDescriptor({
	frame,
	textures,
	scale,
}: {
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
	scale: number;
}): ScaledFrame | null {
	if (!(scale > 0 && scale < 1)) return { frame, textures };
	const width = Math.max(1, Math.round(frame.width * scale));
	const height = Math.max(1, Math.round(frame.height * scale));
	// Per axis, so that a full-canvas layer covers the rounded frame exactly.
	const axis: Axis = { sx: width / frame.width, sy: height / frame.height };

	const items: FrameItemDescriptor[] = [];
	for (const item of frame.items) {
		const effectPassGroups = scalePassGroups({ groups: item.effectPassGroups, axis });
		if (effectPassGroups === null) return null;
		if (item.type === "sceneEffect") {
			items.push({ type: "sceneEffect", effectPassGroups });
			continue;
		}
		items.push({
			...item,
			transform: scaleTransform({ transform: item.transform, axis }),
			effectPassGroups,
			mask: scaleMask({ mask: item.mask, axis }),
		});
	}

	return {
		frame: { ...frame, width, height, items },
		textures: textures.map((texture) =>
			texture.kind === "rendered" &&
			texture.width === frame.width &&
			texture.height === frame.height
				? scaleRenderedTexture({ texture, width, height, axis })
				: texture,
		),
	};
}

function scaleTransform({
	transform,
	axis,
}: {
	transform: QuadTransformDescriptor;
	axis: Axis;
}): QuadTransformDescriptor {
	const scaled: QuadTransformDescriptor = {
		...transform,
		centerX: transform.centerX * axis.sx,
		centerY: transform.centerY * axis.sy,
		width: transform.width * axis.sx,
		height: transform.height * axis.sy,
	};
	const h = transform.homography;
	if (h) {
		// UV -> canvas px, row-major: S H with S = diag(sx, sy, 1).
		scaled.homography = h.map((value, index) =>
			index < 3 ? value * axis.sx : index < 6 ? value * axis.sy : value,
		);
	}
	return scaled;
}

/** JFA feather in pixels (feather.rs): the mean of both axes. */
function scaleMask({
	mask,
	axis,
}: {
	mask: LayerMaskDescriptor | null;
	axis: Axis;
}): LayerMaskDescriptor | null {
	if (!mask) return null;
	return { ...mask, feather: mask.feather * Math.sqrt(axis.sx * axis.sy) };
}

function scalePassGroups({
	groups,
	axis,
}: {
	groups: EffectPass[][];
	axis: Axis;
}): EffectPass[][] | null {
	const scaled: EffectPass[][] = [];
	for (const group of groups) {
		const passes: EffectPass[] = [];
		for (const pass of group) {
			const next = scalePass({ pass, axis });
			if (next === null) return null;
			passes.push(next);
		}
		scaled.push(passes);
	}
	return scaled;
}

/**
 * The per-shader rule table. Only the Gaussian blur exists (effects/definitions):
 * its sigma is in frame pixels along `u_direction`, and its tap spacing
 * follows from the sigma (blurPassStep). Any other shader: null.
 */
function scalePass({ pass, axis }: { pass: EffectPass; axis: Axis }): EffectPass | null {
	if (pass.shader !== GAUSSIAN_BLUR_SHADER) return null;
	const { u_sigma: sigma, u_direction: direction } = pass.uniforms;
	if (typeof sigma !== "number" || !Array.isArray(direction) || direction.length !== 2) {
		return null;
	}
	const [dx, dy] = direction;
	const factor =
		dx !== 0 && dy === 0 ? axis.sx : dx === 0 && dy !== 0 ? axis.sy : null;
	if (factor === null) return null;
	const scaledSigma = sigma * factor;
	return {
		shader: pass.shader,
		uniforms: { ...pass.uniforms, u_sigma: scaledSigma, u_step: blurPassStep(scaledSigma) },
	};
}

/**
 * A frame-sized texture the renderer rasterises (colour, 2D text, masks,
 * strokes, track points, a full-size backdrop): rasterised at the smaller size
 * under scale(sx, sy), so text and shapes are drawn at screen resolution
 * rather than shrunk afterwards. The hash suffix keeps the full-size and the
 * small raster apart in the compositor's texture cache.
 */
// The scaled draw wraps the original in save/scale/restore, so it must only use
// operations that follow the canvas transform. ctx.filter, shadowBlur and
// shadowOffset*, putImageData/getImageData, setTransform/resetTransform and reads
// of ctx.canvas.width ignore it: none exists in a rendered-texture draw today,
// and a new one would look wrong only in the playing preview.
function scaleRenderedTexture({
	texture,
	width,
	height,
	axis,
}: {
	texture: RenderedTextureDescriptor;
	width: number;
	height: number;
	axis: Axis;
}): RenderedTextureDescriptor {
	const { draw } = texture;
	return {
		...texture,
		width,
		height,
		contentHash: `${texture.contentHash}@${width}x${height}`,
		draw: (ctx) => {
			ctx.save();
			try {
				ctx.scale(axis.sx, axis.sy);
				draw(ctx);
			} finally {
				ctx.restore();
			}
		},
	};
}
