import { densityBucket } from "@/services/renderer/source-scale";

/**
 * Whether the preview has to draw this animation frame.
 *
 * The preview, the exporter and the snapshot/thumbnail renderers all draw into
 * the one compositor canvas. Comparing only the playhead frame and the scene
 * with the last ones the preview drew is therefore not enough: after an export
 * those are unchanged, yet the canvas shows the last exported frame (black when
 * the project ends in black) until the playhead moves to another frame.
 */
export type PreviewRenderGateInput<TScene> = {
	/** An export is running: it owns the compositor and the shared video cache. */
	isExporting: boolean;
	frame: number;
	/** Frame of the preview's last draw (-1: none yet). */
	lastFrame: number;
	scene: TScene;
	lastScene: TScene | null;
	/** Compositor draw serial now, whoever drew. */
	compositorSerial: number;
	/** Compositor draw serial right after the preview's own last draw (-1: none yet). */
	lastOwnSerial: number;
	/** Video frame tolerance of this draw (seconds, 0: exact). */
	maxStaleSeconds: number;
	/** Video frame tolerance of the preview's last draw (0 before the first one). */
	lastMaxStaleSeconds: number;
	/**
	 * Device pixels per scene pixel while playing or scrubbing (video frames are
	 * drawn at about their size on screen), null when paused (full size).
	 * Omitted: null.
	 */
	sourceDensity?: number | null;
	/** `sourceDensity` of the preview's last draw (null before the first one). */
	lastSourceDensity?: number | null;
	/**
	 * Share of the project size the compositor draws at (the display-size
	 * lever while playing or scrubbing, else 1). Omitted: 1.
	 */
	renderScale?: number;
	/** `renderScale` of the preview's last draw (1 before the first one). */
	lastRenderScale?: number;
};

export function shouldRenderPreview<TScene>({
	isExporting,
	frame,
	lastFrame,
	scene,
	lastScene,
	compositorSerial,
	lastOwnSerial,
	maxStaleSeconds,
	lastMaxStaleSeconds,
	sourceDensity = null,
	lastSourceDensity = null,
	renderScale = 1,
	lastRenderScale = 1,
}: PreviewRenderGateInput<TScene>): boolean {
	// Drawing now would fight the exporter for the compositor and the video
	// cache (one iterator and one seek generation per media).
	if (isExporting) return false;
	if (frame !== lastFrame) return true;
	if (scene !== lastScene) return true;
	// The last draw may show an older video frame than this one would (it was
	// made while playing, and pausing moves neither the playhead nor the scene).
	if (maxStaleSeconds < lastMaxStaleSeconds) return true;
	// The last draw made its video frames at another size (preview resolution
	// while playing or scrubbing, full size paused): pausing, the end of a scrub,
	// zoom, a panel resize or another screen's pixel ratio.
	if (densityBucket(sourceDensity) !== densityBucket(lastSourceDensity)) return true;
	// The compositor's frame size changed (the display-size lever switched).
	if (renderScale !== lastRenderScale) return true;
	// Same frame, same scene: only the canvas content can still be out of date.
	return compositorSerial !== lastOwnSerial;
}

/**
 * How long ago a video frame shown by the playing preview may have ended
 * (seconds). When the decoder has not delivered the exact frame yet, the
 * newest decoded one is shown instead of stalling the draw, if it is at most
 * this old. A late picture is sound leading vision; ITU-R BT.1359 gives about
 * 45 ms as detectable and 90 ms as acceptable for that (from memory, not
 * re-checked). It only applies while the decoder is behind, which the
 * playback HUD counts as "stale".
 */
export const PLAYBACK_MAX_STALE_SECONDS = 0.09;

/** Frame tolerance of the preview's video frame requests (0: exact). */
export function previewFrameTolerance({
	isPlaying,
	isScrubbing,
}: {
	isPlaying: boolean;
	isScrubbing: boolean;
}): number {
	return isPlaying && !isScrubbing ? PLAYBACK_MAX_STALE_SECONDS : 0;
}

export type PreviewDrawResult = {
	/**
	 * Compositor draw serial to remember as the preview's own: the serial the
	 * draw returned, or the current one when nothing could be drawn.
	 */
	serial: number;
	/** What the draw threw; null when it succeeded with its effects. */
	error: unknown;
	/**
	 * The draw with effects failed (`error`) and the frame was drawn again
	 * without them: the canvas shows this frame, only its effects are missing.
	 */
	effectsDropped: boolean;
};

async function attempt(
	run: () => Promise<number>,
): Promise<{ drawn: true; serial: number } | { drawn: false; error: unknown }> {
	try {
		return { drawn: true, serial: await run() };
	} catch (error) {
		// `error: null` means success, so a thrown null must not look like one.
		return {
			drawn: false,
			error: error === null ? new Error("Preview draw rejected with null") : error,
		};
	}
}

/**
 * Runs one preview draw and reports how it ended. It never rejects, so the
 * caller always gets to clear its "drawing" flag: a draw that throws (a broken
 * image, a codec the browser cannot decode, or `draw` itself throwing before it
 * returns a promise) must not stop the preview from drawing for good.
 *
 * A draw that fails is made once more without effects (the Effects panel's
 * effects on clips and effect tracks; the background blur stays): an effect
 * the compositor cannot apply must not leave the last picture on screen, which
 * looks like a frozen clip. When that fails too, or `mayRetry` says no (an
 * export started meanwhile and owns the compositor), nothing was drawn.
 *
 * A failed draw still records a serial, the compositor's current one. Without
 * it the gate would see the canvas as out of date and retry the same failing
 * draw on every animation frame; with it the draw is retried when the frame or
 * the scene changes, or when someone else draws into the compositor.
 */
export async function drawPreviewFrame({
	draw,
	serialNow,
	mayRetry = () => true,
	effectsFirst = true,
}: {
	/** Draws the frame; resolves to the compositor serial right after the draw. */
	draw: ({ effects }: { effects: boolean }) => Promise<number>;
	/** The compositor's current draw serial. */
	serialNow: () => number;
	/** Asked after a failed draw, before drawing again without effects. */
	mayRetry?: () => boolean;
	/**
	 * False: the effects of this scene failed already (EffectFailureMemory), so
	 * it is drawn once, without them.
	 */
	effectsFirst?: boolean;
}): Promise<PreviewDrawResult> {
	if (!effectsFirst) {
		const only = await attempt(() => draw({ effects: false }));
		return only.drawn
			? { serial: only.serial, error: null, effectsDropped: false }
			: { serial: serialNow(), error: only.error, effectsDropped: false };
	}
	const first = await attempt(() => draw({ effects: true }));
	if (first.drawn) {
		return { serial: first.serial, error: null, effectsDropped: false };
	}
	if (!mayRetry()) {
		return { serial: serialNow(), error: first.error, effectsDropped: false };
	}
	const retry = await attempt(() => draw({ effects: false }));
	if (retry.drawn) {
		return { serial: retry.serial, error: first.error, effectsDropped: true };
	}
	return { serial: serialNow(), error: retry.error, effectsDropped: false };
}

/**
 * Whether a failed frame is drawn again without effects: only when it had
 * Effects-panel work (CanvasRenderer.lastEffectWork). Anything else, a lost or
 * outdated canvas surface or a broken image, is not an effect's fault and is
 * reported as a frame that could not be drawn. Never while an export runs
 * (it owns the compositor and the video cache).
 */
export function shouldRetryWithoutEffects({
	isExporting,
	effectGroups,
}: {
	isExporting: boolean;
	effectGroups: number;
}): boolean {
	return !isExporting && effectGroups > 0;
}

const MAX_MESSAGE_LENGTH = 200;

/** A short text for whatever a draw threw (Rust errors arrive as plain strings). */
export function renderErrorMessage(error: unknown): string {
	const text =
		error instanceof Error ? error.message || error.name : String(error);
	return text.length > MAX_MESSAGE_LENGTH
		? `${text.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
		: text;
}

/**
 * How a draw went wrong: it failed and was drawn again without effects, it
 * could not be drawn at all, or it looked fine but the GPU reported an error
 * since (on WebGPU errors arrive after the draw, see GpuErrorWatcher).
 */
export type RenderErrorKind = "drawn-without-effects" | "not-drawn" | "gpu-error";

export type RenderErrorNotice = { message: string; kind: RenderErrorKind };

/**
 * Decides when a failing preview draw is worth telling the user about, and
 * when the notice can go. The preview draws up to 60 times a second and a
 * broken effect fails every one of those draws: the user hears about it once
 * (again only when the failure changes kind), and the notice stays while the
 * failure lasts. A failure ends only after `quietMs` without a failed draw, so
 * a failure on every other frame does not make the notice flicker.
 */
export class RenderErrorReporter {
	private readonly quietMs: number;
	/** Kinds announced since the failure started; empty when none is active. */
	private announced = new Set<RenderErrorKind>();
	private lastFailureAtMs = Number.NEGATIVE_INFINITY;
	private scope: string | null = null;

	constructor({ quietMs = 1000 }: { quietMs?: number } = {}) {
		this.quietMs = quietMs;
	}

	/** A draw failed: the notice to show, or null when the user was already told. */
	report({
		error,
		kind,
		nowMs,
	}: {
		error: unknown;
		kind: RenderErrorKind;
		nowMs: number;
	}): RenderErrorNotice | null {
		this.lastFailureAtMs = nowMs;
		if (this.announced.has(kind)) return null;
		this.announced.add(kind);
		return { message: renderErrorMessage(error), kind };
	}

	/** A draw skipped the effects that failed for its scene: the failure goes on. */
	stillFailing({ nowMs }: { nowMs: number }): void {
		if (this.announced.size > 0) this.lastFailureAtMs = nowMs;
	}

	/**
	 * A clean draw. True when it ends the failure, i.e. the notice shown for it
	 * should be dismissed now.
	 */
	clear({ nowMs }: { nowMs: number }): boolean {
		if (this.announced.size === 0) return false;
		if (nowMs - this.lastFailureAtMs < this.quietMs) return false;
		this.announced.clear();
		return true;
	}

	/**
	 * The preview now shows `scope` (a project). Another project ends any
	 * failure of the previous one: true when its notice should be dismissed.
	 */
	resetFor({ scope }: { scope: string }): boolean {
		if (scope === this.scope) return false;
		this.scope = scope;
		const wasActive = this.announced.size > 0;
		this.announced.clear();
		return wasActive;
	}
}

/** The preview's reporter (one per window, it outlives preview remounts). */
export const previewRenderErrors = new RenderErrorReporter();

/** What the preview shows (a toast) and logs (one console line) for a notice. */
/**
 * What the preview shows (a toast) and logs (one console line) for a notice.
 * The toast stays (`duration`) until the failure ends (RenderErrorReporter.clear).
 */
export function renderErrorNoticeText(notice: RenderErrorNotice): {
	level: "warning" | "error";
	title: string;
	description: string;
	consoleLabel: string;
	duration: number;
} {
	const duration = Number.POSITIVE_INFINITY;
	switch (notice.kind) {
		case "drawn-without-effects":
			return {
				level: "warning",
				title: "An effect could not be drawn",
				description: `The preview hides the effects of this scene until the problem is fixed, and exporting this project will fail. ${notice.message}`,
				consoleLabel: "Preview render failed, drawn without effects:",
				duration,
			};
		case "gpu-error":
			return {
				level: "warning",
				title: "The GPU reported an error",
				description: `The preview may show this frame wrong until the problem is fixed. ${notice.message}`,
				consoleLabel: "Preview: the GPU reported an error:",
				duration,
			};
		case "not-drawn":
			return {
				level: "error",
				title: "The preview could not draw this frame",
				description: notice.message,
				consoleLabel: "Preview render failed:",
				duration,
			};
	}
}

/** The uncaptured-error count and last message of the GPU device. */
export type GpuErrorCount = { count: number; lastMessage: string | null };

/**
 * Turns the GPU device's error count into "new errors since the last look".
 * The device records its uncaptured errors instead of panicking (rust/crates/
 * gpu/src/context.rs). On the WebGL2 fallback they come during the draw, which
 * then fails with them; on WebGPU they come later as a browser event, after a
 * draw that looked fine, so the preview checks the count after every draw.
 */
export class GpuErrorWatcher {
	private seen = 0;

	/** The errors recorded since the last check, as one error to report; null when none. */
	check(stats: GpuErrorCount | null): Error | null {
		if (!stats) return null;
		if (stats.count < this.seen) {
			// a new device (its count starts at 0): nothing new to tell yet
			this.seen = stats.count;
			return null;
		}
		const fresh = stats.count - this.seen;
		if (fresh === 0) return null;
		this.seen = stats.count;
		const message = stats.lastMessage ?? "unknown";
		return new Error(
			fresh === 1 ? `GPU error: ${message}` : `GPU error: ${message} (and ${fresh - 1} more)`,
		);
	}
}

/** The preview's watcher (one per window, like the reporter). */
export const previewGpuErrors = new GpuErrorWatcher();

/**
 * The scene (render tree) whose effects failed. The preview then draws it
 * without its effects until the scene changes (an edit builds a new tree):
 * no doomed attempt with effects on every frame, and the failure notice stays
 * up instead of being ended by the frames drawn without effects.
 */
export class EffectFailureMemory<TScene> {
	private failedScene: TScene | null = null;
	private failure: unknown = null;

	tryEffects(scene: TScene): boolean {
		return scene !== this.failedScene;
	}

	/**
	 * What made the effects of the remembered scene fail (the playback HUD shows
	 * it while the scene is drawn without them); null when none is remembered.
	 */
	lastFailure(): unknown {
		return this.failure;
	}

	record({
		scene,
		effectsFailed,
		error = null,
	}: {
		scene: TScene;
		effectsFailed: boolean;
		/** What the draw threw, when this draw is the one that failed. */
		error?: unknown;
	}): void {
		if (effectsFailed) {
			if (scene !== this.failedScene || error !== null) this.failure = error;
			this.failedScene = scene;
		} else if (scene !== this.failedScene) {
			this.failedScene = null;
			this.failure = null;
		}
	}
}

/** The preview's memory (one per window). */
export const previewEffectFailures = new EffectFailureMemory<object>();

export type PreviewDrawOutcome =
	| { action: "clean" }
	| { action: "still-failing" }
	| { action: "report"; error: unknown; kind: RenderErrorKind };

/**
 * What one preview draw means for the failure notice: a clean draw (which may
 * end the failure), a draw that skipped the scene's failed effects (the
 * failure goes on), or a failure to report.
 */
export function previewDrawOutcome({
	error,
	effectsDropped,
	gpuError,
	skippedEffects,
}: {
	error: unknown;
	effectsDropped: boolean;
	gpuError: Error | null;
	skippedEffects: boolean;
}): PreviewDrawOutcome {
	const failure = drawFailure({ error, effectsDropped, gpuError });
	if (failure !== null) return { action: "report", ...failure };
	return skippedEffects ? { action: "still-failing" } : { action: "clean" };
}

/**
 * What to report about one preview draw, or null when it went fine. A failed
 * draw already carries any GPU error seen during it (the WebGL2 fallback fails
 * the frame with it); a new GPU error is reported on its own only after a draw
 * that succeeded.
 */
export function drawFailure({
	error,
	effectsDropped,
	gpuError,
}: {
	error: unknown;
	effectsDropped: boolean;
	gpuError: Error | null;
}): { error: unknown; kind: RenderErrorKind } | null {
	if (error !== null) {
		return { error, kind: effectsDropped ? "drawn-without-effects" : "not-drawn" };
	}
	if (gpuError !== null) return { error: gpuError, kind: "gpu-error" };
	return null;
}

/** One toast id: a new notice replaces the shown one instead of stacking. */
export const PREVIEW_RENDER_ERROR_TOAST_ID = "preview-render-error";
