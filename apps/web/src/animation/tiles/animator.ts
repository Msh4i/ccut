import type { PresetDefinition, PresetPhase } from "@/animation/presets";
import { splitRevealedText } from "./content";
import { tileFrameAt, tileFrameStyle, type TileCanvas } from "./frame";
import { TILE_REST_MS, tileProgressAt } from "./loop";
import type { TilePlayback } from "./playback";
import type { FrameTicker } from "./ticker";

/** One frame of a tile, ready for the DOM: the moving box's CSS and, for text, the revealed part. */
export interface TileDrawing {
	style: { transform: string; opacity: string };
	text: { shown: string; hidden: string } | null;
}

export function tileDrawingAt({
	definition,
	phase,
	progress,
	tile,
	text,
}: {
	definition: PresetDefinition;
	phase: PresetPhase;
	progress: number;
	tile: TileCanvas;
	text: string | null;
}): TileDrawing {
	const frame = tileFrameAt({ definition, phase, progress, tile });
	return {
		style: tileFrameStyle({ frame, tile }),
		text: text === null ? null : splitRevealedText({ text, reveal: frame.reveal }),
	};
}

/**
 * Plays a tile's preset on `ticker`, from its first frame: in a loop with a
 * pause at rest, or once. `draw` writes a frame; `restore` puts the tile back
 * as it was drawn before (its still frame). A single play restores and leaves
 * the ticker when it ends; the returned stop function does the same at any
 * time (unmount, a lost slot, the pointer leaving), and only once. The play
 * length is read on every frame, so a new length (the Duration slider being
 * dragged) rescales the running animation instead of restarting it.
 */
export function startTileAnimation({
	ticker,
	definition,
	phase,
	repeat,
	getPlayMs,
	tile,
	text,
	draw,
	restore,
}: {
	ticker: FrameTicker;
	definition: PresetDefinition;
	phase: PresetPhase;
	repeat: boolean;
	getPlayMs: () => number;
	tile: TileCanvas;
	text: string | null;
	draw: (drawing: TileDrawing) => void;
	restore: () => void;
}): () => void {
	let isRunning = true;
	let startedAt: number | null = null;
	let unsubscribe = () => {};
	const stop = () => {
		if (!isRunning) return;
		isRunning = false;
		unsubscribe();
		restore();
	};
	unsubscribe = ticker.subscribe((now) => {
		startedAt ??= now;
		const { progress, isDone } = tileProgressAt({
			elapsedMs: now - startedAt,
			playMs: getPlayMs(),
			restMs: TILE_REST_MS,
			phase,
			repeat,
		});
		if (isDone) {
			stop();
			return;
		}
		draw(tileDrawingAt({ definition, phase, progress, tile, text }));
	});
	return stop;
}

/** What a tile draws into: its moving box and, for text, the shown and hidden spans. */
export interface TileNodes {
	mover: { style: { transform: string; opacity: string } };
	shown: { textContent: string | null } | null;
	hidden: { textContent: string | null } | null;
}

/** Writes one drawing; a text span is only rewritten when its text changes. */
export function writeTileDrawing({
	nodes,
	drawing,
}: {
	nodes: TileNodes;
	drawing: TileDrawing;
}): void {
	nodes.mover.style.transform = drawing.style.transform;
	nodes.mover.style.opacity = drawing.style.opacity;
	const { shown, hidden } = nodes;
	if (!drawing.text || !shown || !hidden) return;
	if (shown.textContent !== drawing.text.shown) {
		shown.textContent = drawing.text.shown;
	}
	if (hidden.textContent !== drawing.text.hidden) {
		hidden.textContent = drawing.text.hidden;
	}
}

/**
 * The body of a tile's animation effect: nothing for a still tile, the None
 * tile or a tile not in the DOM; otherwise the animation, writing straight
 * into `nodes` (no React render per frame). The returned cleanup stops it and
 * writes back `getDrawn()`, the still frame React drew last.
 */
export function startTileEffect({
	nodes,
	ticker,
	definition,
	mode,
	phase,
	getPlayMs,
	tile,
	text,
	getDrawn,
}: {
	nodes: TileNodes | null;
	ticker: FrameTicker;
	definition: PresetDefinition | undefined;
	mode: TilePlayback;
	phase: PresetPhase;
	getPlayMs: () => number;
	tile: TileCanvas;
	text: string | null;
	getDrawn: () => TileDrawing | null;
}): (() => void) | undefined {
	if (!definition || mode === "still" || !nodes) return undefined;
	const draw = (drawing: TileDrawing) => writeTileDrawing({ nodes, drawing });
	return startTileAnimation({
		ticker,
		definition,
		phase,
		repeat: mode === "loop",
		getPlayMs,
		tile,
		text,
		draw,
		restore: () => {
			const drawn = getDrawn();
			if (drawn) draw(drawn);
		},
	});
}
