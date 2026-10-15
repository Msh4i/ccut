import { describe, expect, test } from "bun:test";
import { getPresetDefinition, type PresetAnimationId, type PresetDefinition } from "@/animation/presets";
import {
	startTileAnimation,
	startTileEffect,
	tileDrawingAt,
	writeTileDrawing,
	type TileDrawing,
} from "@/animation/tiles/animator";
import { tileFrameAt, tileFrameStyle, type TileCanvas } from "@/animation/tiles/frame";
import { TILE_REST_MS } from "@/animation/tiles/loop";
import type { FrameListener, FrameTicker } from "@/animation/tiles/ticker";

const TILE: TileCanvas = { width: 160, height: 100, box: { width: 120, height: 40 } };
const PLAY = 500;

function definition(id: PresetAnimationId): PresetDefinition {
	const found = getPresetDefinition(id);
	if (!found) throw new Error(`missing preset ${id}`);
	return found;
}

/** A ticker whose frames run only when the test calls `frame(now)`. */
function manualTicker(): FrameTicker & { frame: (now: number) => void; listenerCount: () => number } {
	const listeners = new Set<FrameListener>();
	return {
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		frame: (now) => {
			for (const listener of [...listeners]) listener(now);
		},
		listenerCount: () => listeners.size,
	};
}

function start({
	id,
	phase = "in",
	repeat = true,
	text = null,
}: {
	id: PresetAnimationId;
	phase?: "in" | "out";
	repeat?: boolean;
	text?: string | null;
}) {
	const ticker = manualTicker();
	const drawn: TileDrawing[] = [];
	let restores = 0;
	let playMs = PLAY;
	const stop = startTileAnimation({
		ticker,
		definition: definition(id),
		phase,
		repeat,
		getPlayMs: () => playMs,
		tile: TILE,
		text,
		draw: (drawing) => drawn.push(drawing),
		restore: () => {
			restores += 1;
		},
	});
	return {
		ticker,
		drawn,
		stop,
		restores: () => restores,
		setPlayMs: (value: number) => {
			playMs = value;
		},
	};
}

/** Stand-ins for the tile's moving box and its two text spans. */
function fakeNodes() {
	return {
		mover: { style: { transform: "still-transform", opacity: "still-opacity" } },
		shown: { textContent: "still-shown" },
		hidden: { textContent: "still-hidden" },
	};
}

const STILL: TileDrawing = {
	style: { transform: "translate(1%, 2%) scale(3)", opacity: "0.4" },
	text: { shown: "Sum", hidden: "mer sale" },
};

function startEffect({
	mode,
	id = "word-reveal",
	nodes = fakeNodes(),
	text = "Summer sale",
}: {
	mode: "loop" | "once" | "still";
	id?: PresetAnimationId | null;
	nodes?: ReturnType<typeof fakeNodes> | null;
	text?: string | null;
}) {
	const ticker = manualTicker();
	const cleanup = startTileEffect({
		nodes,
		ticker,
		definition: id === null ? undefined : definition(id),
		mode,
		phase: "in",
		getPlayMs: () => PLAY,
		tile: TILE,
		text,
		getDrawn: () => STILL,
	});
	return { ticker, cleanup, nodes };
}

describe("tileDrawingAt: one frame as CSS and text", () => {
	test("the style is tileFrameStyle of tileFrameAt", () => {
		const fade = definition("fade");
		const drawing = tileDrawingAt({ definition: fade, phase: "out", progress: 0.25, tile: TILE, text: null });
		expect(drawing).toEqual({
			style: tileFrameStyle({ frame: tileFrameAt({ definition: fade, phase: "out", progress: 0.25, tile: TILE }), tile: TILE }),
			text: null,
		});
	});

	test("a text is split by the frame's reveal", () => {
		expect(
			tileDrawingAt({ definition: definition("typewriter"), phase: "in", progress: 0.5, tile: TILE, text: "Summer sale" }).text,
		).toEqual({ shown: "Summe", hidden: "r sale" });
		expect(
			tileDrawingAt({ definition: definition("fade"), phase: "in", progress: 0.5, tile: TILE, text: "Summer sale" }).text,
		).toEqual({ shown: "Summer sale", hidden: "" });
	});
});

describe("startTileAnimation", () => {
	test("draws nothing before the first frame; the first frame is the phase start", () => {
		const { ticker, drawn } = start({ id: "fade" });
		expect(drawn).toHaveLength(0);
		expect(ticker.listenerCount()).toBe(1);
		ticker.frame(10_000);
		expect(drawn).toHaveLength(1);
		expect(drawn[0].style.opacity).toBe("0");
	});

	test("time is measured from the first frame, whatever the clock reads", () => {
		const { ticker, drawn } = start({ id: "fade" });
		ticker.frame(10_000);
		ticker.frame(10_250);
		expect(drawn[1].style.opacity).toBe("0.5");
	});

	test("Out tiles play the Out direction", () => {
		const { ticker, drawn } = start({ id: "fade", phase: "out" });
		ticker.frame(0);
		ticker.frame(125);
		expect(drawn.map((drawing) => drawing.style.opacity)).toEqual(["1", "0.75"]);
	});

	test("a loop starts again after the pause and never stops by itself", () => {
		const { ticker, drawn, restores } = start({ id: "fade" });
		ticker.frame(0);
		ticker.frame(PLAY + 100);
		ticker.frame(PLAY + TILE_REST_MS + 250);
		expect(drawn.map((drawing) => drawing.style.opacity)).toEqual(["0", "1", "0.5"]);
		expect(restores()).toBe(0);
		expect(ticker.listenerCount()).toBe(1);
	});

	test("played once, it puts the tile back at the end and leaves the ticker", () => {
		const { ticker, drawn, restores } = start({ id: "fade", repeat: false });
		ticker.frame(0);
		ticker.frame(250);
		ticker.frame(PLAY);
		expect(restores()).toBe(1);
		expect(ticker.listenerCount()).toBe(0);
		ticker.frame(PLAY + 16);
		expect(drawn).toHaveLength(2);
	});

	test("stopping (unmount, cap, leave) leaves the ticker and puts the tile back, once", () => {
		const { ticker, stop, restores } = start({ id: "slide-left" });
		ticker.frame(0);
		stop();
		stop();
		expect(ticker.listenerCount()).toBe(0);
		expect(restores()).toBe(1);
	});

	test("stopping after a single play has ended does not put the tile back twice", () => {
		const { ticker, stop, restores } = start({ id: "fade", repeat: false });
		ticker.frame(0);
		ticker.frame(PLAY);
		stop();
		expect(restores()).toBe(1);
	});

	test("text reveal frames carry the revealed part", () => {
		const { ticker, drawn } = start({ id: "word-reveal", text: "Summer sale" });
		ticker.frame(0);
		ticker.frame(PLAY / 2);
		expect(drawn.map((drawing) => drawing.text)).toEqual([
			{ shown: "", hidden: "Summer sale" },
			{ shown: "Summer", hidden: " sale" },
		]);
	});

	test("a new length (the Duration slider) rescales the running animation instead of restarting it", () => {
		const { ticker, drawn, setPlayMs } = start({ id: "fade" });
		ticker.frame(1000);
		ticker.frame(1250);
		setPlayMs(1000);
		ticker.frame(1500);
		setPlayMs(2000);
		ticker.frame(1750);
		// Same start time throughout: 250 of 500, 500 of 1000, 750 of 2000.
		expect(drawn.map((drawing) => drawing.style.opacity)).toEqual(["0", "0.5", "0.5", "0.375"]);
		expect(ticker.listenerCount()).toBe(1);
	});
});

describe("startTileEffect: the tile's effect body, on stand-in nodes", () => {
	test("a still tile, the None tile and a tile without nodes start nothing", () => {
		for (const args of [
			{ mode: "still" as const },
			{ mode: "loop" as const, id: null },
			{ mode: "loop" as const, nodes: null },
		]) {
			const { ticker, cleanup } = startEffect(args);
			expect(cleanup).toBeUndefined();
			expect(ticker.listenerCount()).toBe(0);
		}
	});

	test("frames are written to the moving box and the two text spans", () => {
		const { ticker, nodes } = startEffect({ mode: "loop" });
		ticker.frame(0);
		ticker.frame(PLAY / 2);
		expect(nodes?.mover.style).toEqual({ transform: "translate(0%, 0%) scale(1)", opacity: "1" });
		expect(nodes?.shown.textContent).toBe("Summer");
		expect(nodes?.hidden.textContent).toBe(" sale");
	});

	test("the cleanup (unmount, lost slot, pointer leaving) leaves the ticker and puts the still frame back", () => {
		const { ticker, cleanup, nodes } = startEffect({ mode: "loop" });
		ticker.frame(0);
		ticker.frame(PLAY / 2);
		cleanup?.();
		expect(ticker.listenerCount()).toBe(0);
		expect(nodes?.mover.style).toEqual(STILL.style);
		expect(nodes?.shown.textContent).toBe("Sum");
		expect(nodes?.hidden.textContent).toBe("mer sale");
	});

	test("a single play puts the still frame back when it ends", () => {
		const { ticker, nodes } = startEffect({ mode: "once" });
		ticker.frame(0);
		ticker.frame(PLAY);
		expect(ticker.listenerCount()).toBe(0);
		expect(nodes?.mover.style).toEqual(STILL.style);
		expect(nodes?.shown.textContent).toBe("Sum");
	});

	test("a picture tile (no text) moves the box and leaves the spans alone", () => {
		const { ticker, nodes } = startEffect({ mode: "loop", id: "fade", text: null });
		ticker.frame(0);
		expect(nodes?.mover.style.opacity).toBe("0");
		expect(nodes?.shown.textContent).toBe("still-shown");
	});
});

describe("writeTileDrawing", () => {
	test("rewrites a text span only when its text changes", () => {
		let writes = 0;
		let text = "Sum";
		const shown = {
			get textContent() {
				return text;
			},
			set textContent(value: string) {
				writes += 1;
				text = value;
			},
		};
		const nodes = { mover: { style: { transform: "", opacity: "" } }, shown, hidden: { textContent: "mer sale" } };
		writeTileDrawing({ nodes, drawing: STILL });
		expect(writes).toBe(0);
		writeTileDrawing({ nodes, drawing: { ...STILL, text: { shown: "Summer", hidden: " sale" } } });
		expect(writes).toBe(1);
		expect(nodes.hidden.textContent).toBe(" sale");
	});
});
