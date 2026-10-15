import { describe, expect, test } from "bun:test";
import {
	PLAYBACK_MAX_STALE_SECONDS,
	previewFrameTolerance,
	shouldRenderPreview,
} from "../render-gate";

// The preview draws into the compositor canvas that the exporter (and the
// snapshot/thumbnail renderers) draw into as well. It used to skip a redraw
// whenever the playhead frame and the scene were unchanged, so after an export
// the canvas kept showing the last exported frame (black when the project ends
// in black) until the playhead moved to another frame.

const scene = {};
const otherScene = {};

const idle = {
	isExporting: false,
	frame: 0,
	lastFrame: 0,
	scene,
	lastScene: scene,
	compositorSerial: 7,
	lastOwnSerial: 7,
	maxStaleSeconds: 0,
	lastMaxStaleSeconds: 0,
};

describe("shouldRenderPreview", () => {
	test("skips when frame, scene and the canvas are all unchanged", () => {
		expect(shouldRenderPreview(idle)).toBe(false);
	});

	test("draws the very first frame (nothing drawn yet)", () => {
		expect(shouldRenderPreview({ ...idle, lastFrame: -1, lastScene: null, lastOwnSerial: -1 })).toBe(true);
	});

	test("draws when the playhead moved to another frame", () => {
		expect(shouldRenderPreview({ ...idle, frame: 1 })).toBe(true);
	});

	test("draws when the scene changed", () => {
		expect(shouldRenderPreview({ ...idle, scene: otherScene })).toBe(true);
	});

	test("redraws when someone else drew into the compositor since (export finished at the same playhead frame)", () => {
		expect(shouldRenderPreview({ ...idle, compositorSerial: 8 })).toBe(true);
		expect(shouldRenderPreview({ ...idle, compositorSerial: 187 })).toBe(true);
	});

	test("never draws while an export is running, whatever changed", () => {
		expect(shouldRenderPreview({ ...idle, isExporting: true })).toBe(false);
		expect(shouldRenderPreview({ ...idle, isExporting: true, frame: 5 })).toBe(false);
		expect(shouldRenderPreview({ ...idle, isExporting: true, scene: otherScene })).toBe(false);
		expect(shouldRenderPreview({ ...idle, isExporting: true, compositorSerial: 99 })).toBe(false);
		expect(shouldRenderPreview({ ...idle, isExporting: true, lastFrame: -1, lastScene: null, lastOwnSerial: -1 })).toBe(false);
	});

	test("the draw that follows an export does not repeat once the canvas is the preview's again", () => {
		const afterExport = { ...idle, compositorSerial: 187 };
		expect(shouldRenderPreview(afterExport)).toBe(true);
		// the preview's own draw recorded the serial it produced
		expect(shouldRenderPreview({ ...afterExport, lastOwnSerial: 188, compositorSerial: 188 })).toBe(false);
	});
});

// While playing, a draw may show a video frame up to PLAYBACK_MAX_STALE_SECONDS
// older than the exact one. Pausing changes neither the playhead nor the
// scene, so without this rule a paused preview kept showing that older frame
// although paused seeks are meant to be exact.
describe("shouldRenderPreview: pausing after playback draws", () => {
	const playing = { ...idle, maxStaleSeconds: PLAYBACK_MAX_STALE_SECONDS, lastMaxStaleSeconds: PLAYBACK_MAX_STALE_SECONDS };
	const justPaused = { ...idle, maxStaleSeconds: 0, lastMaxStaleSeconds: PLAYBACK_MAX_STALE_SECONDS };

	test("redraws the same frame once when the preview turns exact after a tolerant draw", () => {
		expect(shouldRenderPreview(justPaused)).toBe(true);
		// that exact draw recorded its own tolerance: no further redraw
		expect(shouldRenderPreview({ ...justPaused, lastMaxStaleSeconds: 0 })).toBe(false);
	});

	test("keeps skipping a repeated frame while playing and while paused", () => {
		expect(shouldRenderPreview(playing)).toBe(false);
		expect(shouldRenderPreview(idle)).toBe(false);
	});

	test("starting to play does not force a redraw", () => {
		expect(shouldRenderPreview({ ...idle, maxStaleSeconds: PLAYBACK_MAX_STALE_SECONDS, lastMaxStaleSeconds: 0 })).toBe(false);
	});

	test("also redraws when the tolerance only got smaller", () => {
		expect(shouldRenderPreview({ ...playing, maxStaleSeconds: PLAYBACK_MAX_STALE_SECONDS / 2 })).toBe(true);
	});

	test("never draws while an export is running", () => {
		expect(shouldRenderPreview({ ...justPaused, isExporting: true })).toBe(false);
	});
});

describe("previewFrameTolerance", () => {
	test("while playing, a video frame may lag the playhead by a bounded time", () => {
		const tolerance = previewFrameTolerance({ isPlaying: true, isScrubbing: false });
		expect(tolerance).toBe(PLAYBACK_MAX_STALE_SECONDS);
		expect(tolerance).toBeGreaterThan(0);
		// a few frames at most: within the ~90 ms acceptable for a late picture
		expect(tolerance).toBeLessThanOrEqual(0.09);
	});

	test("paused or scrubbing, every frame is exact", () => {
		expect(previewFrameTolerance({ isPlaying: false, isScrubbing: false })).toBe(0);
		expect(previewFrameTolerance({ isPlaying: false, isScrubbing: true })).toBe(0);
		expect(previewFrameTolerance({ isPlaying: true, isScrubbing: true })).toBe(0);
	});
});

// While playing or scrubbing the preview draws video frames at about their
// size on screen (`sourceDensity`, device pixels per scene pixel); paused it
// draws them at full size (null). The picture on the canvas is out of date when
// the size those frames would be drawn at has changed.
describe("shouldRenderPreview: preview resolution", () => {
	const settled = { ...idle, sourceDensity: 0.4, lastSourceDensity: 0.4 };

	test("skips when the density is unchanged", () => {
		expect(shouldRenderPreview(settled)).toBe(false);
		expect(shouldRenderPreview({ ...idle, sourceDensity: null, lastSourceDensity: null })).toBe(false);
	});

	test("a call that passes no density behaves as before", () => {
		expect(shouldRenderPreview(idle)).toBe(false);
	});

	test("redraws once when a scrub ends or playback stops: preview resolution to full size", () => {
		const paused = { ...settled, sourceDensity: null };
		expect(shouldRenderPreview(paused)).toBe(true);
		// that full-size draw recorded its density: no further redraw
		expect(shouldRenderPreview({ ...paused, lastSourceDensity: null })).toBe(false);
	});

	test("redraws when playing starts again: full size to preview resolution", () => {
		expect(shouldRenderPreview({ ...idle, sourceDensity: 0.4, lastSourceDensity: null })).toBe(true);
	});

	test("redraws when the density crosses a bucket (zoom, panel resize, another screen)", () => {
		expect(shouldRenderPreview({ ...settled, sourceDensity: 0.7 })).toBe(true);
		expect(shouldRenderPreview({ ...settled, sourceDensity: 0.2 })).toBe(true);
		expect(shouldRenderPreview({ ...settled, sourceDensity: 2 })).toBe(true);
	});

	test("does not redraw for a change inside one bucket", () => {
		expect(shouldRenderPreview({ ...settled, sourceDensity: 0.43 })).toBe(false);
	});

	test("an unusable density counts as full size", () => {
		expect(shouldRenderPreview({ ...settled, sourceDensity: Number.NaN })).toBe(true);
		expect(
			shouldRenderPreview({ ...idle, sourceDensity: Number.NaN, lastSourceDensity: null }),
		).toBe(false);
	});

	test("never while an export runs", () => {
		expect(shouldRenderPreview({ ...settled, isExporting: true, sourceDensity: null })).toBe(false);
	});
});

// Lever (c): the playing preview composites at display size (`renderScale`
// below 1). Toggling the lever while the density stays in its bucket changes
// the picture's size, so a change of scale alone must redraw.
describe("shouldRenderPreview and the compositor's render scale", () => {
	const settled = { ...idle, sourceDensity: 0.4, lastSourceDensity: 0.4, renderScale: 0.5, lastRenderScale: 0.5 };

	test("skips when the scale is unchanged; a call without one behaves as before", () => {
		expect(shouldRenderPreview(settled)).toBe(false);
		expect(shouldRenderPreview({ ...idle, sourceDensity: 0.4, lastSourceDensity: 0.4 })).toBe(false);
	});

	test("redraws when only the scale changed (the lever switched while playing)", () => {
		expect(shouldRenderPreview({ ...settled, renderScale: 1 })).toBe(true);
		expect(shouldRenderPreview({ ...settled, lastRenderScale: 1 })).toBe(true);
	});

	test("never while an export runs", () => {
		expect(shouldRenderPreview({ ...settled, isExporting: true, renderScale: 1 })).toBe(false);
	});
});
