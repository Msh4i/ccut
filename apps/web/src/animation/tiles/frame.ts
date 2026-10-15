import {
	applyPresetDelta,
	getPhaseProgress,
	type PresetContext,
	type PresetDefinition,
	type PresetPhase,
	type PresetReveal,
} from "@/animation/presets";
import type { Transform } from "@/rendering";

/**
 * A preview tile is a small canvas in its own units (16:10). The element's
 * content is a box centred in it, so a preset sees the same kind of context it
 * sees on the real canvas and a slide starts just off the tile edge.
 */
export const TILE_CANVAS = { width: 160, height: 100 };

const TEXT_BOX = { width: 120, height: 40 };
/** A picture keeps its aspect inside this box. */
const PICTURE_MAX = { width: 100, height: 64 };
const DEFAULT_ASPECT = 16 / 9;

export interface TileBox {
	width: number;
	height: number;
}

export interface TileCanvas {
	width: number;
	height: number;
	/** The content's box, centred in the tile. */
	box: TileBox;
}

/** What a tile draws at one instant, in tile units. */
export interface TileFrame {
	opacity: number;
	scale: number;
	translateX: number;
	translateY: number;
	reveal: PresetReveal | undefined;
}

export type TileShape = { kind: "text" } | { kind: "picture"; aspect: number };

export function getTileBox(shape: TileShape): TileBox {
	if (shape.kind === "text") return { ...TEXT_BOX };
	const aspect =
		Number.isFinite(shape.aspect) && shape.aspect > 0
			? shape.aspect
			: DEFAULT_ASPECT;
	if (aspect >= PICTURE_MAX.width / PICTURE_MAX.height) {
		return { width: PICTURE_MAX.width, height: PICTURE_MAX.width / aspect };
	}
	return { width: PICTURE_MAX.height * aspect, height: PICTURE_MAX.height };
}

/** The context a preset sees on a tile: the tile is the canvas, the box sits at its centre. */
export function getTileContext({ tile }: { tile: TileCanvas }): PresetContext {
	const halfWidth = tile.box.width / 2;
	const halfHeight = tile.box.height / 2;
	return {
		canvasWidth: tile.width,
		canvasHeight: tile.height,
		position: { x: 0, y: 0 },
		bounds: {
			left: -halfWidth,
			right: halfWidth,
			top: -halfHeight,
			bottom: halfHeight,
		},
	};
}

const REST_TRANSFORM: Transform = {
	position: { x: 0, y: 0 },
	scaleX: 1,
	scaleY: 1,
	rotate: 0,
};

/**
 * The tile's frame `progress` (0..1) of the way through a phase as it plays:
 * for In 0 is the first frame and 1 is at rest, for Out 0 is at rest and 1 is
 * the last frame. The preset's own `evaluate` gives the change, with the
 * renderer's In/Out mapping (`getPhaseProgress`) and the renderer's way of
 * laying it over the content (`applyPresetDelta`), so a tile cannot show a
 * different animation from the one that renders. A progress that is not a
 * number is the phase start.
 */
export function tileFrameAt({
	definition,
	phase,
	progress,
	tile,
}: {
	definition: PresetDefinition;
	phase: PresetPhase;
	progress: number;
	tile: TileCanvas;
}): TileFrame {
	const delta = definition.evaluate({
		progress: getPhaseProgress({
			phase,
			localTime: Number.isFinite(progress) ? progress : 0,
			duration: 1,
			length: 1,
		}),
		context: getTileContext({ tile }),
	});
	const { transform, opacity } = applyPresetDelta({
		transform: REST_TRANSFORM,
		opacity: 1,
		delta,
	});
	return {
		opacity,
		scale: transform.scaleX,
		translateX: transform.position.x,
		translateY: transform.position.y,
		reveal: delta.reveal,
	};
}

/** The content's resting pose. */
export const REST_FRAME: TileFrame = {
	opacity: 1,
	scale: 1,
	translateX: 0,
	translateY: 0,
	reveal: undefined,
};

function formatNumber({
	value,
	digits,
}: {
	value: number;
	digits: number;
}): string {
	return Number.isFinite(value) ? String(Number(value.toFixed(digits))) : "0";
}

/**
 * The frame as CSS for the moving box. A translation in % is relative to the
 * box itself, and the box is sized as a fraction of the tile, so the motion
 * keeps its proportions at whatever size the tile is drawn.
 */
export function tileFrameStyle({
	frame,
	tile,
}: {
	frame: TileFrame;
	tile: TileCanvas;
}): { transform: string; opacity: string } {
	const percentX =
		tile.box.width > 0 ? (frame.translateX / tile.box.width) * 100 : 0;
	const percentY =
		tile.box.height > 0 ? (frame.translateY / tile.box.height) * 100 : 0;
	const x = formatNumber({ value: percentX, digits: 3 });
	const y = formatNumber({ value: percentY, digits: 3 });
	const scale = formatNumber({ value: frame.scale, digits: 4 });
	return {
		transform: `translate(${x}%, ${y}%) scale(${scale})`,
		opacity: formatNumber({ value: frame.opacity, digits: 4 }),
	};
}
