import { lookupMattes, matteKindsFor } from "@/background/matte/matte-registry";
import { resolveChromaKeyAtTime } from "@/background/chroma-key";
import { mediaTimeToSeconds, roundMediaTime } from "@/wasm";
import { getElementLocalTime } from "@/animation";
import { resolveEffectParamsAtTime } from "@/animation/effect-param-channel";
import {
	buildGaussianBlurPasses,
	intensityToSigma,
} from "@/effects/definitions/blur";
import { effectsRegistry, resolveEffectPasses } from "@/effects";
import { usablePassGroups } from "@/effects/pass-groups";
import type { Effect, EffectPass } from "@/effects/types";
import { getSourceTimeAtClipTime } from "@/retime";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	resolveGraphicElementParamsAtTime,
} from "@/graphics";
import {
	buildTextBackgroundFromElement,
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import { getVisibleLengths } from "@/text/reveal";
import { resolveColorAtTime, resolveOpacityAtTime } from "@/animation/values";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import type { Transform } from "@/rendering";
import {
	applyPresetsAtTime,
	type PresetAnimations,
	type PresetReveal,
} from "@/animation/presets";
import { type RenderLease, videoCache } from "@/services/video-cache/service";
import type { CanvasRenderer } from "./canvas-renderer";
import { backdropDownscale } from "./compositor/backdrop-scale";
import { backdropSourceScale, layerSourceScale } from "./source-scale";
import type { AnyBaseNode } from "./nodes/base-node";
import {
	BlurBackgroundNode,
	type BackdropSource,
	type ResolvedBlurBackgroundNodeState,
} from "./nodes/blur-background-node";
import {
	EffectLayerNode,
	type ResolvedEffectLayerNodeState,
} from "./nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "./nodes/graphic-node";
import { ImageNode, loadImageSource } from "./nodes/image-node";
import { describeId } from "@/stickers/describe-id";
import {
	StickerNode,
	loadStickerSource,
	loadStickerSourceOrNull,
} from "./nodes/sticker-node";
import { TextNode, type ResolvedTextNodeState } from "./nodes/text-node";
import { VideoNode } from "./nodes/video-node";
import type {
	ResolvedVisualNodeState,
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "./nodes/visual-node";
import {
	resolveVisualTransformAtTime,
	visualQuadTransform,
} from "./visual-transform";
import { CameraRigNode } from "./nodes/camera-rig-node";
import { TrackPointsNode } from "./nodes/solved-points-node";
import { activeCameraAt } from "@/scene3d/render/active-camera";
import { resolveTransform3DAtTime } from "@/scene3d/render/layer-transform";
import {
	trackPointsAt,
	type RenderedTrackPoints,
} from "@/scene3d/render/solved-points";

type ResolveContext = {
	renderer: CanvasRenderer;
	time: number;
	/**
	 * False: no Effects-panel effect is resolved or drawn (clip effects,
	 * effect-track layers; the background blur stays). The preview's second try
	 * at a frame that failed.
	 */
	effects: boolean;
	/** Counts the frame's Effects-panel work (see EffectWork). */
	effectWork: EffectWork;
	/**
	 * The preview while it plays or scrubs: the scene's device pixels per scene
	 * pixel, so video frames are drawn at about their size on screen
	 * (source-scale.ts). Null: full resolution (paused preview, export,
	 * snapshot, thumbnail).
	 */
	sourceDensity: number | null;
	/**
	 * The render's lease on its video frames (`videoCache.beginRender`): their
	 * canvases are not recycled until the render has uploaded them. Absent: the
	 * cache's draw-count quarantine alone protects them.
	 */
	frameLease: RenderLease | null;
	/**
	 * The preview draws this frame and the "Decode in workers" lever is on: its
	 * video streams may decode on a worker. False for export, snapshot and
	 * thumbnail, and with the lever off (the frame requests are then exactly the
	 * old ones).
	 */
	allowWorker: boolean;
};

/**
 * Effects-panel work of one frame: the effect groups of its clips and its
 * effect-track layers that resolved to passes, or that failed to resolve. The
 * background blur is not counted. Filled while the tree resolves, so it is
 * readable also when the frame fails.
 */
export type EffectWork = { groups: number };

export async function resolveRenderTree({
	node,
	renderer,
	time,
	effects = true,
	effectWork = { groups: 0 },
	sourceDensity = null,
	frameLease = null,
	allowWorker = false,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	time: number;
	effects?: boolean;
	effectWork?: EffectWork;
	sourceDensity?: number | null;
	frameLease?: RenderLease | null;
	allowWorker?: boolean;
}): Promise<void> {
	await resolveNode({
		node,
		context: {
			renderer,
			time,
			effects,
			effectWork,
			sourceDensity,
			frameLease,
			allowWorker,
		},
	});
}

/** A clip's effect groups, counted as the frame's effect work (also when resolving throws). */
function countedEffectGroups({
	context,
	resolve,
}: {
	context: ResolveContext;
	resolve: () => EffectPass[][];
}): EffectPass[][] {
	if (!context.effects) return [];
	try {
		const groups = resolve();
		context.effectWork.groups += groups.length;
		return groups;
	} catch (error) {
		context.effectWork.groups += 1;
		throw error;
	}
}

async function resolveNode({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> {
	if (node instanceof VideoNode) {
		node.resolved = await resolveVideoNode({ node, context });
	} else if (node instanceof ImageNode) {
		node.resolved = await resolveImageNode({ node, context });
	} else if (node instanceof StickerNode) {
		node.resolved = await resolveStickerNode({ node, context });
	} else if (node instanceof GraphicNode) {
		node.resolved = resolveGraphicNode({ node, context });
	} else if (node instanceof TextNode) {
		node.resolved = resolveTextNode({ node, context });
	} else if (node instanceof BlurBackgroundNode) {
		node.resolved = await resolveBlurBackgroundNode({ node, context });
	} else if (node instanceof EffectLayerNode) {
		node.resolved = resolveEffectLayerNode({ node, context });
	} else if (node instanceof CameraRigNode) {
		node.resolved = activeCameraAt({
			tracks: node.params.tracks,
			time: context.time,
			canvasWidth: context.renderer.width,
			canvasHeight: context.renderer.height,
		});
	} else if (node instanceof TrackPointsNode) {
		node.resolved = resolveTrackPointsNode({ node, context });
	}

	await Promise.all(
		node.children.map((child) => resolveNode({ node: child, context })),
	);
}

/**
 * One pass group per enabled effect that has something to do. An effect that
 * builds no passes (a blur of 0 px, a clip box of 0 x 0) gets no group: the
 * compositor fails the whole frame on an empty one.
 */
export function resolveEffectPassGroups({
	effects,
	animations,
	localTime,
	duration,
	width,
	height,
}: {
	effects: Effect[] | undefined;
	animations: VisualNodeParams["animations"];
	localTime: number;
	duration: number;
	width: number;
	height: number;
}): EffectPass[][] {
	const enabledEffects = (effects ?? []).filter((effect) => effect.enabled);
	if (enabledEffects.length === 0) return [];

	const localTimeSeconds = mediaTimeToSeconds({
		time: roundMediaTime({ time: localTime }),
	});
	const durationSeconds = mediaTimeToSeconds({
		time: roundMediaTime({ time: duration }),
	});
	return usablePassGroups(
		enabledEffects.map((effect) => {
			const resolvedParams = resolveEffectParamsAtTime({
				effectId: effect.id,
				params: effect.params,
				animations,
				localTime,
			});
			const definition = effectsRegistry.get(effect.type);
			return resolveEffectPasses({
				definition,
				effectParams: resolvedParams,
				width,
				height,
				localTimeSeconds,
				durationSeconds,
			});
		}),
	);
}

/**
 * Lays the In/Out preset animations over the user's own transform and opacity.
 * `rect` is the clip's unscaled box relative to its origin. Preview and export
 * both come through here, so they cannot disagree.
 */
function resolvePresetState({
	presetAnimations,
	localTime,
	duration,
	renderer,
	transform,
	opacity,
	rect,
	scaleAfterRotate,
}: {
	presetAnimations: PresetAnimations | undefined;
	localTime: number;
	duration: number;
	renderer: CanvasRenderer;
	transform: Transform;
	opacity: number;
	rect: { left: number; top: number; width: number; height: number };
	/** True for text, which is drawn rotated first and scaled second. */
	scaleAfterRotate?: boolean;
}): { transform: Transform; opacity: number; reveal: PresetReveal | undefined } {
	return applyPresetsAtTime({
		presetAnimations,
		localTime,
		duration,
		canvasWidth: renderer.width,
		canvasHeight: renderer.height,
		transform,
		opacity,
		rect,
		scaleAfterRotate,
	});
}

function resolveVisualState({
	params,
	context,
	sourceWidth,
	sourceHeight,
}: {
	params: VisualNodeParams;
	context: ResolveContext;
	sourceWidth: number;
	sourceHeight: number;
}): ResolvedVisualNodeState | null {
	const clipTime = context.time - params.timeOffset;
	if (clipTime < 0 || clipTime >= params.duration) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: params.timeOffset,
		elementDuration: params.duration,
	});
	const containScale = Math.min(
		context.renderer.width / sourceWidth,
		context.renderer.height / sourceHeight,
	);
	const { transform, opacity } = resolveVisualTransformAtTime({
		baseTransform: params.transform,
		baseOpacity: params.opacity,
		animations: params.animations,
		presetAnimations: params.presetAnimations,
		localTime,
		duration: params.duration,
		canvasWidth: context.renderer.width,
		canvasHeight: context.renderer.height,
		sourceWidth,
		sourceHeight,
	});
	const effectWidth = Math.round(
		Math.abs(sourceWidth * containScale * transform.scaleX),
	);
	const effectHeight = Math.round(
		Math.abs(sourceHeight * containScale * transform.scaleY),
	);

	const transform3d = params.elementParams
		? resolveTransform3DAtTime({
				params: params.elementParams,
				animations: params.animations,
				localTime,
			})
		: null;

	const chromaKey = resolveChromaKeyAtTime({
		params: params.elementParams,
		animations: params.animations,
		localTime,
	});

	return {
		localTime,
		transform,
		opacity,
		effectPasses: countedEffectGroups({
			context,
			resolve: () =>
				resolveEffectPassGroups({
					effects: params.effects,
					animations: params.animations,
					localTime,
					duration: params.duration,
					width: effectWidth,
					height: effectHeight,
				}),
		}),
		...(transform3d && { transform3d }),
		...(chromaKey && { chromaKey }),
	};
}

async function resolveVideoNode({
	node,
	context,
}: {
	node: VideoNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}

	const sourceTimeTicks =
		node.params.trimStart +
		getSourceTimeAtClipTime({
			clipTime,
			retime: node.params.retime,
		});

	// Preview resolution: the frame is requested at about its size on screen,
	// which needs the layer's quad, so the visual state is resolved first, from
	// the media's display size once the cache has opened it. All before the first
	// await: the cache captures the playback tolerance synchronously. Without a
	// density (export, snapshot, paused preview) nothing changes: full size, the
	// state resolved from the frame.
	const display =
		context.sourceDensity === null
			? null
			: videoCache.peekDisplaySize({ mediaId: node.params.mediaId });
	const early = display
		? resolveVisualState({
				params: node.params,
				context,
				sourceWidth: display.width,
				sourceHeight: display.height,
			})
		: null;
	if (display && !early) {
		return null;
	}
	// A 3D layer is placed by the camera, not by its 2D quad: full size.
	const quad =
		display && early && !early.transform3d
			? visualQuadTransform({
					canvasWidth: context.renderer.width,
					canvasHeight: context.renderer.height,
					transform: early.transform,
					sourceWidth: display.width,
					sourceHeight: display.height,
				})
			: null;
	const scale =
		display && quad
			? layerSourceScale({
					quadWidth: quad.width,
					quadHeight: quad.height,
					sourceWidth: display.width,
					sourceHeight: display.height,
					density: context.sourceDensity,
				})
			: 1;
	const frame = await videoCache.getFrameAt({
		mediaId: node.params.mediaId,
		file: node.params.file,
		time: mediaTimeToSeconds({ time: roundMediaTime({ time: sourceTimeTicks }) }),
		streamKey: node.params.elementId,
		scale,
		...(context.frameLease && { lease: context.frameLease }),
		...(context.allowWorker && { allowWorker: true }),
	});
	if (!frame) {
		return null;
	}

	// The layer keeps the video's display size however small its canvas is.
	const sameSize =
		display?.width === frame.displayWidth && display.height === frame.displayHeight;
	const visualState =
		early && sameSize
			? early
			: resolveVisualState({
					params: node.params,
					context,
					sourceWidth: frame.displayWidth,
					sourceHeight: frame.displayHeight,
				});
	if (!visualState) {
		return null;
	}

	const mattes = lookupMattes({
		elementId: node.params.elementId,
		sourceSeconds: mediaTimeToSeconds({ time: roundMediaTime({ time: sourceTimeTicks }) }),
		clipTime: visualState.localTime,
		kinds: matteKindsFor({ params: node.params.elementParams }),
	});
	return {
		...visualState,
		source: frame.canvas,
		sourceWidth: frame.displayWidth,
		sourceHeight: frame.displayHeight,
		textureWidth: frame.canvas.width,
		textureHeight: frame.canvas.height,
		sourceVersion: frame.timestamp,
		...(mattes.length > 0 && { mattes }),
	};
}

async function resolveImageNode({
	node,
	context,
}: {
	node: ImageNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadImageSource({
		url: node.params.url,
		maxSourceSize: node.params.maxSourceSize,
	});
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: source.width,
		sourceHeight: source.height,
	});
	if (!visualState) {
		return null;
	}

	const mattes = lookupMattes({
		elementId: node.params.elementId,
		sourceSeconds: 0,
		clipTime: visualState.localTime,
		kinds: ["brush"],
	});
	return {
		...visualState,
		source: source.source,
		sourceWidth: source.width,
		sourceHeight: source.height,
		...(mattes.length > 0 && { mattes }),
	};
}

/**
 * Export: a sticker that cannot be loaded stops the export with an error (like
 * an image does) instead of being left out of the video. The export preflight
 * has loaded every sticker already, so this only fails if something changed
 * under it; it never retries on a timer, so the output is deterministic.
 */
async function loadStickerSourceStrict({ stickerId }: { stickerId: string }) {
	try {
		return await loadStickerSource({ stickerId, retry: "never" });
	} catch (error) {
		throw new Error(
			`Sticker "${describeId({ value: stickerId })}" could not be loaded. Remove it or re-add it.`,
			{ cause: error },
		);
	}
}

async function resolveStickerNode({
	node,
	context,
}: {
	node: StickerNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = context.renderer.strictSources
		? await loadStickerSourceStrict({ stickerId: node.params.stickerId })
		: await loadStickerSourceOrNull({ stickerId: node.params.stickerId });
	if (!source) {
		return null;
	}
	const sourceWidth = node.params.intrinsicWidth ?? source.width;
	const sourceHeight = node.params.intrinsicHeight ?? source.height;
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth,
		sourceHeight,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth,
		sourceHeight,
	};
}

function resolveGraphicNode({
	node,
	context,
}: {
	node: GraphicNode;
	context: ResolveContext;
}): ResolvedGraphicNodeState | null {
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: DEFAULT_GRAPHIC_SOURCE_SIZE,
		sourceHeight: DEFAULT_GRAPHIC_SOURCE_SIZE,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		resolvedParams: resolveGraphicElementParamsAtTime({
			element: node.params,
			localTime: visualState.localTime,
		}),
	};
}

function resolveTextNode({
	node,
	context,
}: {
	node: TextNode;
	context: ResolveContext;
}): ResolvedTextNodeState | null {
	if (
		context.time < node.params.startTime ||
		context.time >= node.params.startTime + node.params.duration
	) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: node.params.startTime,
		elementDuration: node.params.duration,
	});
	const background = buildTextBackgroundFromElement({ element: node.params });
	// Measured first: a slide preset needs the text's size.
	const measuredText = measureTextElement({
		element: node.params,
		canvasHeight: node.params.canvasHeight,
		localTime,
		ctx: getTextMeasurementContext(),
	});
	const { transform, opacity, reveal } = resolvePresetState({
		presetAnimations: node.params.presetAnimations,
		localTime,
		duration: node.params.duration,
		renderer: context.renderer,
		transform: resolveTransformAtTime({
			baseTransform: node.params.transform,
			animations: node.params.animations,
			localTime,
		}),
		opacity: resolveOpacityAtTime({
			baseOpacity: node.params.opacity,
			animations: node.params.animations,
			localTime,
		}),
		rect: measuredText.visualRect,
		scaleAfterRotate: true,
	});
	const transform3d = resolveTransform3DAtTime({
		params: node.params.params,
		animations: node.params.animations,
		localTime,
	});

	return {
		...(transform3d && { transform3d }),
		transform,
		opacity,
		textColor: resolveColorAtTime({
			baseColor:
				typeof node.params.params.color === "string"
					? node.params.params.color
					: "#ffffff",
			animations: node.params.animations,
			propertyPath: "color",
			localTime,
		}),
		backgroundColor: resolveColorAtTime({
			baseColor: background.color,
			animations: node.params.animations,
			propertyPath: "background.color",
			localTime,
		}),
		effectPasses: countedEffectGroups({
			context,
			resolve: () =>
				resolveEffectPassGroups({
					effects: node.params.effects,
					animations: node.params.animations,
					localTime,
					duration: node.params.duration,
					width: context.renderer.width,
					height: context.renderer.height,
				}),
		}),
		measuredText,
		...(reveal && {
			visibleLengths: getVisibleLengths({
				lines: measuredText.lines,
				unit: reveal.unit,
				fraction: reveal.fraction,
			}),
		}),
	};
}

async function resolveBlurBackgroundNode({
	node,
	context,
}: {
	node: BlurBackgroundNode;
	context: ResolveContext;
}): Promise<ResolvedBlurBackgroundNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}

	const sigmaX = intensityToSigma({
		intensity: node.params.blurIntensity,
		resolution: context.renderer.width,
		reference: 1920,
	});
	const sigmaY = intensityToSigma({
		intensity: node.params.blurIntensity,
		resolution: context.renderer.height,
		reference: 1080,
	});

	// The backdrop texture is drawn `downscale` times smaller, so the blur may
	// space its taps that far apart and take fewer passes for the same sigma.
	const downscale = backdropDownscale({ sigmaX, sigmaY });
	// Asked for before the first await, like the clip's own frame (the cache
	// captures the playback tolerance synchronously).
	const backdropSource = await resolveBackdropSource({ node, clipTime, context, downscale });
	if (!backdropSource) {
		return null;
	}

	return {
		backdropSource,
		passes: buildGaussianBlurPasses({
			sigmaX,
			sigmaY,
			sourceDownscale: downscale,
		}),
		downscale,
	};
}

async function resolveBackdropSource({
	node,
	clipTime,
	context,
	downscale,
}: {
	node: BlurBackgroundNode;
	clipTime: number;
	context: ResolveContext;
	/** How many times smaller than the frame the backdrop texture is drawn. */
	downscale: number;
}): Promise<BackdropSource | null> {
	if (node.params.mediaType === "video") {
		const sourceTimeTicks =
			node.params.trimStart +
			getSourceTimeAtClipTime({
				clipTime,
				retime: node.params.retime,
			});
		// The backdrop draws this frame into a texture `downscale` times smaller
		// than the scene, so a frame drawn smaller still is enough (the clip's own
		// request for the same time shares one draw when it is not larger).
		const display =
			context.sourceDensity === null
				? null
				: videoCache.peekDisplaySize({ mediaId: node.params.mediaId });
		const scale = display
			? backdropSourceScale({
					canvasWidth: context.renderer.width,
					canvasHeight: context.renderer.height,
					sourceWidth: display.width,
					sourceHeight: display.height,
					downscale,
					density: context.sourceDensity,
				})
			: 1;
		const frame = await videoCache.getFrameAt({
			mediaId: node.params.mediaId,
			file: node.params.file,
			time: mediaTimeToSeconds({ time: roundMediaTime({ time: sourceTimeTicks }) }),
			streamKey: node.params.elementId,
			scale,
			...(context.frameLease && { lease: context.frameLease }),
			...(context.allowWorker && { allowWorker: true }),
		});
		if (!frame) {
			return null;
		}

		// Width and height are the video's display size, whatever the canvas is.
		return {
			source: frame.canvas,
			width: frame.displayWidth,
			height: frame.displayHeight,
			version: frame.timestamp,
		};
	}

	const source = await loadImageSource({ url: node.params.url });
	return {
		source: source.source,
		width: source.width,
		height: source.height,
	};
}

function resolveTrackPointsNode({
	node,
	context,
}: {
	node: TrackPointsNode;
	context: ResolveContext;
}): RenderedTrackPoints | null {
	const { video } = node.params;
	const clipTime = context.time - video.startTime;
	if (clipTime < 0 || clipTime >= video.duration) {
		return null;
	}
	return trackPointsAt({
		video,
		time: context.time,
		canvasWidth: context.renderer.width,
		canvasHeight: context.renderer.height,
	});
}

function resolveEffectLayerNode({
	node,
	context,
}: {
	node: EffectLayerNode;
	context: ResolveContext;
}): ResolvedEffectLayerNodeState | null {
	const time = context.time;
	if (
		!context.effects ||
		time < node.params.timeOffset - 1e-6 ||
		time >= node.params.timeOffset + node.params.duration + 1e-6
	) {
		return null;
	}

	const clampedLocalTime = getElementLocalTime({
		timelineTime: time,
		elementStartTime: node.params.timeOffset,
		elementDuration: node.params.duration,
	});
	const localTimeSeconds = mediaTimeToSeconds({
		time: roundMediaTime({ time: clampedLocalTime }),
	});
	const durationSeconds = mediaTimeToSeconds({
		time: roundMediaTime({ time: node.params.duration }),
	});
	const [passes] = countedEffectGroups({
		context,
		resolve: () =>
			usablePassGroups([
				resolveEffectPasses({
					definition: effectsRegistry.get(node.params.effectType),
					effectParams: node.params.effectParams,
					width: context.renderer.width,
					height: context.renderer.height,
					localTimeSeconds,
					durationSeconds,
				}),
			]),
	});
	if (!passes) {
		return null;
	}

	return {
		passes,
	};
}
