import { applyMattes, matteHash, type Matte } from "@/background/matte/matte-registry";
import { applyChromaKey, chromaKeyHash, type ChromaKeySettings } from "@/background/chroma-key";
import { usablePassGroups } from "@/effects/pass-groups";
import { drawCssBackground } from "@/gradients";
import { getMaskDefinition } from "@/masks";
import { incrementCounter } from "@/diagnostics/render-perf";
import type { AnyBaseNode } from "../nodes/base-node";
import type { CanvasRenderer } from "../canvas-renderer";
import { createCanvasSurface } from "../canvas-utils";
import { backdropTextureSize } from "./backdrop-scale";
import { BlurBackgroundNode } from "../nodes/blur-background-node";
import { ColorNode } from "../nodes/color-node";
import { EffectLayerNode } from "../nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "../nodes/graphic-node";
import { ImageNode } from "../nodes/image-node";
import { RootNode } from "../nodes/root-node";
import { StickerNode } from "../nodes/sticker-node";
import {
	renderTextToContext,
	renderTextToLocalContext,
	TextNode,
} from "../nodes/text-node";
import { VideoNode } from "../nodes/video-node";
import type { ResolvedVisualSourceNodeState } from "../nodes/visual-node";
import { CameraRigNode } from "../nodes/camera-rig-node";
import { TrackPointsNode } from "../nodes/solved-points-node";
import type {
	FrameDescriptor,
	FrameItemDescriptor,
	LayerMaskDescriptor,
	QuadTransformDescriptor,
	TextureCanvasDrawFn,
	TextureUploadDescriptor,
} from "./types";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics";
import { containFitSize, visualQuadTransform } from "../visual-transform";
import { homographyLayerTransform } from "./layer-3d";
import { defaultViewCamera } from "@/scene3d/camera";
import { orderLayersForDepth } from "@/scene3d/render/depth-sort";
import { depthOfLayer, layerPixelScale } from "@/scene3d/render/homography";
import { localRasterSize } from "@/scene3d/render/raster-size";
import { trackPointColor, type RenderedTrackPoints } from "@/scene3d/render/solved-points";
import type { Transform3D, ViewCamera } from "@/scene3d/types";

/**
 * `JSON.stringify`, dropping any `effectPasses` field anywhere in `value`.
 * Used for the text raster content hash below: effect passes run on the GPU
 * after the text is rasterized, so they are not an input to the raster, but
 * they do change every frame for a time-based effect — including them would
 * make the hash (and so the raster cache) miss every frame.
 */
export function stringifyOmittingEffectPasses({
	value,
}: {
	value: unknown;
}): string {
	return JSON.stringify(value, (key, propertyValue) =>
		key === "effectPasses" ? undefined : propertyValue,
	);
}

const BACKDROP_SMOOTHING_QUALITY: ImageSmoothingQuality = "high";

export async function buildFrameDescriptor({
	node,
	renderer,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
}): Promise<{
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
}> {
	const items: FrameItemDescriptor[] = [];
	const textures = new Map<string, TextureUploadDescriptor>();

	await collectNode({
		node,
		renderer,
		path: "root",
		items,
		textures,
		view: defaultViewCamera({
			canvasWidth: renderer.width,
			canvasHeight: renderer.height,
		}),
	});

	incrementCounter({ name: "frameItems", by: items.length });
	incrementCounter({ name: "frameTextures", by: textures.size });

	return {
		frame: {
			width: renderer.width,
			height: renderer.height,
			clear: {
				color: [0, 0, 0, 1],
			},
			items,
		},
		textures: [...textures.values()],
	};
}

/**
 * The camera 3D layers are drawn through: the root's resolved camera rig
 * (the active camera element), else `fallback` (the default camera).
 */
function viewOfRoot({
	root,
	fallback,
}: {
	root: RootNode;
	fallback: ViewCamera;
}): ViewCamera {
	for (const child of root.children) {
		if (child instanceof CameraRigNode && child.resolved) {
			return child.resolved;
		}
	}
	return fallback;
}

/**
 * Appends the node's frame items. Returns the camera-space depth of the
 * layer when the node was drawn as a 3D layer (the depth-sort key), else
 * null. The root draws its children bottom to top, each run of consecutive
 * 3D layers back to front (`orderLayersForDepth`).
 */
async function collectNode({
	node,
	renderer,
	path,
	items,
	textures,
	view,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	view: ViewCamera;
}): Promise<number | null> {
	if (node instanceof RootNode) {
		const rootView = viewOfRoot({ root: node, fallback: view });
		const segments: { items: FrameItemDescriptor[]; depth: number | null }[] =
			[];
		for (let index = 0; index < node.children.length; index++) {
			const childItems: FrameItemDescriptor[] = [];
			const depth = await collectNode({
				node: node.children[index],
				renderer,
				path: `${path}:${index}`,
				items: childItems,
				textures,
				view: rootView,
			});
			if (childItems.length > 0) {
				segments.push({ items: childItems, depth });
			}
		}
		for (const segment of orderLayersForDepth(segments)) {
			items.push(...segment.items);
		}
		return null;
	}

	if (node instanceof ColorNode) {
		const textureId = `${path}:color`;
		const { width, height } = renderer;
		textures.set(textureId, {
			kind: "rendered",
			id: textureId,
			contentHash: `color:${node.params.color}:${width}x${height}`,
			width,
			height,
			draw: (ctx) => {
				if (/gradient\(/i.test(node.params.color)) {
					drawCssBackground({ ctx, width, height, css: node.params.color });
				} else {
					ctx.fillStyle = node.params.color;
					ctx.fillRect(0, 0, width, height);
				}
			},
		});
		items.push({
			type: "layer",
			textureId,
			transform: fullCanvasTransform(renderer),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [],
			mask: null,
		});
		return null;
	}

	if (node instanceof EffectLayerNode) {
		if (!node.resolved) {
			return null;
		}
		// The compositor fails the whole frame on an empty group.
		const effectPassGroups = usablePassGroups([node.resolved.passes]);
		if (effectPassGroups.length === 0) {
			return null;
		}
		items.push({ type: "sceneEffect", effectPassGroups });
		return null;
	}

	if (node instanceof BlurBackgroundNode) {
		if (!node.resolved) {
			return null;
		}
		const textureId = `${path}:blur-background`;
		const { width, height } = renderer;
		const { backdropSource, passes, downscale } = node.resolved;
		// The blur runs at frame resolution after the compositor stretches this
		// texture over the whole frame, so a strong blur does not need a frame-sized
		// backdrop: drawing it smaller makes the per-frame upload much cheaper.
		const { width: textureWidth, height: textureHeight } = backdropTextureSize({
			width,
			height,
			downscale,
		});
		// Backdrop pixels come from a decoded video/image frame. A video frame's
		// canvas is pooled and redrawn in place, so the reference alone does not
		// say whether the pixels changed: the frame version does.
		const contentHash = `blur:${identityKey(backdropSource.source)}:${backdropSource.version ?? ""}:${backdropSource.width}x${backdropSource.height}:${width}x${height}:${downscale}:${textureWidth}x${textureHeight}`;
		textures.set(textureId, {
			kind: "rendered",
			id: textureId,
			contentHash,
			width: textureWidth,
			height: textureHeight,
			draw: (ctx) => {
				const coverScale = Math.max(
					width / backdropSource.width,
					height / backdropSource.height,
				);
				const scaledWidth = backdropSource.width * coverScale;
				const scaledHeight = backdropSource.height * coverScale;
				const offsetX = (width - scaledWidth) / 2;
				const offsetY = (height - scaledHeight) / 2;
				// Cover-scale in frame coordinates, then shrink them onto the texture:
				// the compositor stretches the texture back over the frame, so the
				// picture lands where it did at full size.
				const toTextureX = textureWidth / width;
				const toTextureY = textureHeight / height;
				// Chrome's default smoothing is a mipmap-less bilinear (2 taps), which
				// aliases fine detail (text, thin patterns) of a frame shrunk by k into
				// blobs that flicker as the video moves. An averaging filter does not.
				// At full size nothing changes: the context is left as it was.
				if (textureWidth < width || textureHeight < height) {
					ctx.imageSmoothingEnabled = true;
					ctx.imageSmoothingQuality = BACKDROP_SMOOTHING_QUALITY;
				}
				ctx.drawImage(
					backdropSource.source,
					offsetX * toTextureX,
					offsetY * toTextureY,
					scaledWidth * toTextureX,
					scaledHeight * toTextureY,
				);
			},
		});
		items.push({
			type: "layer",
			textureId,
			transform: fullCanvasTransform(renderer),
			opacity: 1,
			blendMode: "normal",
			// buildGaussianBlurPasses returns no passes for a blur of ~0 px, and an
			// empty group is an error in the compositor: no group means no effects.
			effectPassGroups: usablePassGroups([passes]),
			mask: null,
		});
		return null;
	}

	if (
		node instanceof VideoNode ||
		node instanceof ImageNode ||
		node instanceof StickerNode ||
		node instanceof GraphicNode
	) {
		return collectVisualSourceNode({
			node,
			renderer,
			path,
			items,
			textures,
			view,
		});
	}

	if (node instanceof TextNode) {
		return collectTextNode({
			node,
			renderer,
			path,
			items,
			textures,
			view,
		});
	}

	if (node instanceof TrackPointsNode) {
		collectTrackPointsNode({
			resolved: node.resolved,
			renderer,
			path,
			items,
			textures,
		});
	}
	return null;
}

async function collectVisualSourceNode({
	node,
	renderer,
	path,
	items,
	textures,
	view,
}: {
	node: VideoNode | ImageNode | StickerNode | GraphicNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	view: ViewCamera;
}): Promise<number | null> {
	if (!node.resolved) {
		return null;
	}

	const source =
		node instanceof GraphicNode
			? node.getSource({ resolvedParams: node.resolved.resolvedParams })
			: node.resolved.source;
	if (!source) {
		return null;
	}

	// A graphic is drawn at its definition's fixed size and has no frame version.
	// Every other node resolved to a decoded source; only video frames carry a
	// version (their canvases are pooled and redrawn in place).
	const sourceState = node instanceof GraphicNode ? null : node.resolved;
	const sourceWidth = sourceState
		? sourceState.sourceWidth
		: DEFAULT_GRAPHIC_SOURCE_SIZE;
	const sourceHeight = sourceState
		? sourceState.sourceHeight
		: DEFAULT_GRAPHIC_SOURCE_SIZE;

	const textureId = `${path}:source`;
	// The pixels of the source itself: a video frame drawn small for the
	// preview is uploaded small, and the quad below keeps the logical size
	// (a copy larger than the source would be a validation error).
	const textureWidth = sourceState?.textureWidth ?? sourceWidth;
	const textureHeight = sourceState?.textureHeight ?? sourceHeight;
	const chromaKey = node.resolved.chromaKey;
	const mattes = sourceState?.mattes ?? [];
	const sourceTexture: TextureUploadDescriptor = chromaKey || mattes.length > 0
		? keyedSourceTexture({
				id: textureId,
				source,
				width: textureWidth,
				height: textureHeight,
				version: sourceState?.sourceVersion,
				settings: chromaKey ?? null,
				mattes,
			})
		: {
				kind: "external",
				id: textureId,
				source,
				width: textureWidth,
				height: textureHeight,
				version: sourceState?.sourceVersion,
			};

	const transform3d = node.resolved.transform3d;
	if (transform3d) {
		// A 3D layer: its source texture placed by the camera's homography. The
		// 2D transform is ignored and masks are not supported (P1).
		const content = containFitSize({
			canvasWidth: renderer.width,
			canvasHeight: renderer.height,
			sourceWidth,
			sourceHeight,
		});
		const quad = homographyLayerTransform({
			view,
			transform: transform3d,
			contentWidth: content.width,
			contentHeight: content.height,
			canvasWidth: renderer.width,
			canvasHeight: renderer.height,
		});
		if (!quad) {
			return null;
		}
		textures.set(textureId, sourceTexture);
		items.push({
			type: "layer",
			textureId,
			transform: quad,
			opacity: node.resolved.opacity,
			blendMode: node.params.blendMode ?? "normal",
			effectPassGroups: usablePassGroups(node.resolved.effectPasses),
			mask: null,
		});
		return depthOfLayer({ view, transform: transform3d });
	}

	textures.set(textureId, sourceTexture);
	const transform = computeVisualTransform({
		renderer,
		resolved: node.resolved,
		sourceWidth,
		sourceHeight,
	});
	const { mask, strokeLayer } = buildMaskArtifacts({
		node,
		renderer,
		path,
		transform,
		textures,
	});

	items.push({
		type: "layer",
		textureId,
		transform,
		opacity: node.resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		effectPassGroups: usablePassGroups(node.resolved.effectPasses),
		mask,
	});
	if (strokeLayer) {
		items.push(strokeLayer);
	}
	return null;
}

function collectTextNode({
	node,
	renderer,
	path,
	items,
	textures,
	view,
}: {
	node: TextNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	view: ViewCamera;
}): number | null {
	if (!node.resolved) {
		return null;
	}
	if (node.resolved.transform3d) {
		return collectText3DNode({
			node,
			renderer,
			path,
			items,
			textures,
			view,
			transform3d: node.resolved.transform3d,
		});
	}

	const textureId = `${path}:text`;
	const { width, height } = renderer;
	// Text output is fully determined by node.params + node.resolved. Both are
	// plain data we can stringify cheaply; the resolved measured layout is the
	// expensive part of text setup, so stringifying it here is orders of
	// magnitude cheaper than re-rasterizing when nothing changed. effectPasses
	// is excluded: it is a GPU-pass input applied *after* this raster (e.g. a
	// time-based effect like Shake), not an input to drawing the text itself,
	// and it changes every frame — including it would make this hash (and so
	// the raster cache) miss every frame for any text clip with a time-based
	// effect attached.
	const contentHash = `text:${width}x${height}:${stringifyOmittingEffectPasses(
		{ value: { params: node.params, resolved: node.resolved } },
	)}`;
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash,
		width,
		height,
		draw: (ctx) => {
			renderTextToContext({ node, ctx });
		},
	});
	items.push({
		type: "layer",
		textureId,
		transform: fullCanvasTransform(renderer),
		opacity: node.resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		effectPassGroups: usablePassGroups(node.resolved.effectPasses),
		mask: null,
	});
	return null;
}

/**
 * A 3D text layer: the measured layout rasterised into a LOCAL texture whose
 * size follows the layer's size on screen in half-octave buckets, placed by
 * the camera's homography. The content hash leaves out everything the
 * compositor applies per frame (homography, 3D and 2D transform, opacity,
 * effects): moving the layer re-uploads nothing until its on-screen size
 * crosses a bucket.
 */
function collectText3DNode({
	node,
	renderer,
	path,
	items,
	textures,
	view,
	transform3d,
}: {
	node: TextNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	view: ViewCamera;
	transform3d: Transform3D;
}): number | null {
	const resolved = node.resolved;
	if (!resolved) {
		return null;
	}
	const rect = resolved.measuredText.visualRect;
	const geometry = {
		view,
		transform: transform3d,
		contentWidth: rect.width,
		contentHeight: rect.height,
	};
	const quad = homographyLayerTransform({
		...geometry,
		canvasWidth: renderer.width,
		canvasHeight: renderer.height,
	});
	if (!quad) {
		return null;
	}
	const size = localRasterSize({
		contentWidth: rect.width,
		contentHeight: rect.height,
		pixelScale: layerPixelScale(geometry),
	});
	const textureId = `${path}:text3d`;
	// Exactly what renderTextToLocalContext draws from (the params are not
	// hashed: they also hold the per-frame 2D and 3D transform values).
	const contentHash = `text3d:${size.width}x${size.height}:${JSON.stringify({
		textBaseline: node.params.textBaseline ?? "middle",
		textColor: resolved.textColor,
		backgroundColor: resolved.backgroundColor,
		measuredText: resolved.measuredText,
		visibleLengths: resolved.visibleLengths,
	})}`;
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash,
		width: size.width,
		height: size.height,
		draw: (ctx) => {
			renderTextToLocalContext({
				node,
				ctx,
				width: size.width,
				height: size.height,
			});
		},
	});
	items.push({
		type: "layer",
		textureId,
		transform: quad,
		opacity: resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		effectPassGroups: usablePassGroups(resolved.effectPasses),
		mask: null,
	});
	return depthOfLayer({ view, transform: transform3d });
}

/** Render Track Points: crosses on a full-canvas layer right above the tracked clip. */
function collectTrackPointsNode({
	resolved,
	renderer,
	path,
	items,
	textures,
}: {
	resolved: RenderedTrackPoints | null;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	if (!resolved || resolved.points.length === 0) {
		return;
	}
	const { width, height } = renderer;
	const { points, radius, lineWidth } = resolved;
	const textureId = `${path}:solved-points`;
	const positions = points
		.map((point) => `${point.trackId}@${point.x.toFixed(2)},${point.y.toFixed(2)}`)
		.join(";");
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash: `solved-points:${width}x${height}:${radius}:${lineWidth}:${positions}`,
		width,
		height,
		draw: (ctx) => {
			ctx.lineWidth = lineWidth;
			ctx.lineCap = "round";
			for (const point of points) {
				ctx.strokeStyle = trackPointColor(point.trackId);
				ctx.beginPath();
				ctx.moveTo(point.x - radius, point.y);
				ctx.lineTo(point.x + radius, point.y);
				ctx.moveTo(point.x, point.y - radius);
				ctx.lineTo(point.x, point.y + radius);
				ctx.stroke();
			}
		},
	});
	items.push({
		type: "layer",
		textureId,
		transform: fullCanvasTransform(renderer),
		opacity: 1,
		blendMode: "normal",
		effectPassGroups: [],
		mask: null,
	});
}

function computeVisualTransform({
	renderer,
	resolved,
	sourceWidth,
	sourceHeight,
}: {
	renderer: CanvasRenderer;
	resolved: ResolvedVisualSourceNodeState | ResolvedGraphicNodeState;
	sourceWidth: number;
	sourceHeight: number;
}): QuadTransformDescriptor {
	return visualQuadTransform({
		canvasWidth: renderer.width,
		canvasHeight: renderer.height,
		transform: resolved.transform,
		sourceWidth,
		sourceHeight,
	});
}

function fullCanvasTransform(
	renderer: CanvasRenderer,
): QuadTransformDescriptor {
	return {
		centerX: renderer.width / 2,
		centerY: renderer.height / 2,
		width: renderer.width,
		height: renderer.height,
		rotationDegrees: 0,
		flipX: false,
		flipY: false,
	};
}

function buildMaskArtifacts({
	node,
	renderer,
	path,
	transform,
	textures,
}: {
	node: VideoNode | ImageNode | StickerNode | GraphicNode;
	renderer: CanvasRenderer;
	path: string;
	transform: QuadTransformDescriptor;
	textures: Map<string, TextureUploadDescriptor>;
}): {
	mask: LayerMaskDescriptor | null;
	strokeLayer: FrameItemDescriptor | null;
} {
	const mask = node.params.masks?.[0];
	if (!mask) {
		return { mask: null, strokeLayer: null };
	}

	const definition = getMaskDefinition(mask.type);

	if (definition.isActive?.(mask.params) === false) {
		return { mask: null, strokeLayer: null };
	}

	const { body } = definition.renderer;
	const usesOpaqueFastPath =
		body.kind === "drawWithFeather" &&
		mask.params.feather === 0 &&
		Boolean(body.opaqueFastPath);
	// drawWithFeather renderers encode feathering analytically in their canvas output
	// (e.g. split mask uses a linear gradient instead of JFA). The descriptor feather is
	// zeroed so the GPU compositor copies the mask texture as-is and does not run a second
	// JFA feather pass on top of an already-soft texture.
	const feather = body.kind === "drawWithFeather" ? 0 : mask.params.feather;

	const maskTextureId = `${path}:mask`;
	const { width: canvasWidth, height: canvasHeight } = renderer;
	const maskContentHash = `mask:${mask.type}:${JSON.stringify(mask.params)}:${transformHash(transform)}:${canvasWidth}x${canvasHeight}:body=${body.kind}:fastPath=${usesOpaqueFastPath}`;
	const drawMask: TextureCanvasDrawFn = (ctx) => {
		const { canvas: elementMaskCanvas, context: elementMaskCtx } =
			createCanvasSurface({
				width: Math.round(transform.width),
				height: Math.round(transform.height),
			});

		switch (body.kind) {
			case "fillPath": {
				const path2d = body.buildPath({
					resolvedParams: mask.params,
					width: transform.width,
					height: transform.height,
				});
				elementMaskCtx.fillStyle = "white";
				elementMaskCtx.fill(path2d);
				break;
			}
			case "drawOpaque":
				body.drawOpaque({
					resolvedParams: mask.params,
					ctx: elementMaskCtx,
					width: Math.round(transform.width),
					height: Math.round(transform.height),
				});
				break;
			case "drawWithFeather":
				if (usesOpaqueFastPath && body.opaqueFastPath) {
					const path2d = body.opaqueFastPath.buildPath({
						resolvedParams: mask.params,
						width: transform.width,
						height: transform.height,
					});
					elementMaskCtx.fillStyle = "white";
					elementMaskCtx.fill(path2d);
				} else {
					body.drawWithFeather({
						resolvedParams: mask.params,
						ctx: elementMaskCtx,
						width: Math.round(transform.width),
						height: Math.round(transform.height),
						feather: mask.params.feather,
					});
				}
				break;
		}

		drawTransformedCanvas({ ctx, source: elementMaskCanvas, transform });
	};
	textures.set(maskTextureId, {
		kind: "rendered",
		id: maskTextureId,
		contentHash: maskContentHash,
		width: canvasWidth,
		height: canvasHeight,
		draw: drawMask,
	});

	const stroke = definition.renderer.stroke;
	const hasStroke = mask.params.strokeWidth > 0 && Boolean(stroke);
	let strokeLayer: FrameItemDescriptor | null = null;
	if (hasStroke && stroke) {
		const strokeTextureId = `${path}:mask-stroke`;
		const strokeContentHash = `stroke:${mask.type}:${JSON.stringify(mask.params)}:${transformHash(transform)}:${canvasWidth}x${canvasHeight}:stroke=${stroke.kind}`;
		const drawStroke: TextureCanvasDrawFn = (ctx) => {
			const { canvas: strokeCanvas, context: strokeCtx } = createCanvasSurface({
				width: Math.round(transform.width),
				height: Math.round(transform.height),
			});

			switch (stroke.kind) {
				case "renderStroke":
					stroke.renderStroke({
						resolvedParams: mask.params,
						ctx: strokeCtx,
						width: transform.width,
						height: transform.height,
					});
					break;
				case "strokeFromPath": {
					const strokePath = stroke.buildStrokePath({
						resolvedParams: mask.params,
						width: transform.width,
						height: transform.height,
					});
					strokeCtx.strokeStyle = mask.params.strokeColor;
					strokeCtx.lineWidth = mask.params.strokeWidth;
					strokeCtx.stroke(strokePath);
					break;
				}
			}

			drawTransformedCanvas({ ctx, source: strokeCanvas, transform });
		};
		textures.set(strokeTextureId, {
			kind: "rendered",
			id: strokeTextureId,
			contentHash: strokeContentHash,
			width: canvasWidth,
			height: canvasHeight,
			draw: drawStroke,
		});
		strokeLayer = {
			type: "layer",
			textureId: strokeTextureId,
			transform: fullCanvasTransform(renderer),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [],
			mask: null,
		};
	}

	return {
		mask: {
			textureId: maskTextureId,
			feather,
			inverted: mask.params.inverted,
		},
		strokeLayer,
	};
}

function drawTransformedCanvas({
	ctx,
	source,
	transform,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	source: CanvasImageSource;
	transform: QuadTransformDescriptor;
}) {
	const x = transform.centerX - transform.width / 2;
	const y = transform.centerY - transform.height / 2;
	const flipX = transform.flipX ? -1 : 1;
	const flipY = transform.flipY ? -1 : 1;
	const requiresTransform =
		transform.rotationDegrees !== 0 || flipX !== 1 || flipY !== 1;

	ctx.save();
	if (requiresTransform) {
		ctx.translate(transform.centerX, transform.centerY);
		ctx.rotate((transform.rotationDegrees * Math.PI) / 180);
		ctx.scale(flipX, flipY);
		ctx.translate(-transform.centerX, -transform.centerY);
	}
	ctx.drawImage(source, x, y, transform.width, transform.height);
	ctx.restore();
}

function transformHash(transform: QuadTransformDescriptor): string {
	return `${transform.centerX}:${transform.centerY}:${transform.width}:${transform.height}:${transform.rotationDegrees}:${transform.flipX ? 1 : 0}:${transform.flipY ? 1 : 0}`;
}

// Stable identity key for CanvasImageSource. Using a WeakMap → counter keeps
// hash string length bounded and avoids holding sources alive.
const identityKeys = new WeakMap<object, number>();
let nextIdentity = 1;
function identityKey(source: CanvasImageSource): string {
	if (typeof source === "object" && source !== null) {
		let key = identityKeys.get(source);
		if (key === undefined) {
			key = nextIdentity++;
			identityKeys.set(source, key);
		}
		return `@${key}`;
	}
	return "@?";
}

/**
 * The clip's picture with its colour key applied, as a rendered texture: the
 * frame is drawn into the texture's canvas and keyed pixel by pixel. Cached by
 * the frame (identity and version) and the key settings, so a paused frame is
 * keyed once.
 */
export function keyedSourceTexture({
	id,
	source,
	width,
	height,
	version,
	settings,
	mattes = [],
}: {
	id: string;
	source: CanvasImageSource;
	width: number;
	height: number;
	version: number | undefined;
	settings: ChromaKeySettings | null;
	mattes?: readonly Matte[];
}): TextureUploadDescriptor {
	return {
		kind: "rendered",
		id,
		contentHash: `chroma:${identityKey(source)}:${version ?? ""}:${width}x${height}:${settings ? chromaKeyHash({ settings }) : "-"}:${matteHash({ mattes })}`,
		width,
		height,
		draw: (ctx) => {
			ctx.drawImage(source, 0, 0, width, height);
			const pixels = ctx.getImageData(0, 0, width, height);
			if (settings) applyChromaKey({ data: pixels.data, settings });
			applyMattes({ pixels: pixels.data, width, height, mattes });
			ctx.putImageData(pixels, 0, 0);
		},
	};
}
