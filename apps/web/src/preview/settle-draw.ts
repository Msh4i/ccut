import {
	type EffectFailureMemory,
	type GpuErrorCount,
	type GpuErrorWatcher,
	type PreviewDrawResult,
	type RenderErrorReporter,
	previewDrawOutcome,
	renderErrorMessage,
	renderErrorNoticeText,
} from "./render-gate";

/** Where the user is told (the preview: a sonner toast with one fixed id, and the console). */
export type PreviewNoticeSink = {
	show: (notice: {
		level: "warning" | "error";
		title: string;
		description: string;
		duration: number;
	}) => void;
	dismiss: () => void;
	logError: (args: { label: string; error: unknown }) => void;
};

/** What the playback HUD is told about a draw (null while the HUD is off). */
export type PreviewHudSink = {
	/** The draw put a picture on the canvas (also one without its effects): record its numbers. */
	recordDrawn: () => void;
	/** The draw left no picture: whatever the HUD remembers of the last draw is out of date. */
	recordNotDrawn: () => void;
	recordRenderError: (args: { message: string; nowMs: number }) => void;
	recordGpuErrorStats: (stats: GpuErrorCount | null) => void;
};

/** Text for the HUD when the failure of a skipped scene is not known (the memory has none). */
const SKIPPED_EFFECTS_MESSAGE = "effects of this scene stay off after an earlier failure";

/**
 * What the preview does once a draw ended: remembers a scene whose effects
 * failed, tells the playback HUD, and shows the user one notice per failure
 * (dismissed when the failure ends). Nothing is left silent: every draw that
 * failed, was drawn without effects or skipped them reaches the HUD, and every
 * failure that is new reaches the user.
 */
export function settlePreviewDraw({
	result,
	scene,
	effectsFirst,
	nowMs,
	projectId,
	gpuStats,
	memory,
	reporter,
	gpuWatcher,
	notices,
	hud,
}: {
	result: PreviewDrawResult;
	scene: object;
	/** Whether the draw tried the scene's effects (false: they failed for this scene before). */
	effectsFirst: boolean;
	nowMs: number;
	/** The project shown; another one ends the previous one's failure. */
	projectId: string | undefined;
	/** The GPU device's error count now. */
	gpuStats: GpuErrorCount | null;
	memory: EffectFailureMemory<object>;
	reporter: RenderErrorReporter;
	gpuWatcher: GpuErrorWatcher;
	notices: PreviewNoticeSink;
	hud: PreviewHudSink | null;
}): void {
	const { error, effectsDropped } = result;
	// Only an error of the dropped effects is the reason they are off (a later decoder error is not).
	memory.record({ scene, effectsFailed: effectsDropped || !effectsFirst, error: effectsDropped ? error : null });
	const drawn = error === null || effectsDropped;
	if (hud) {
		if (drawn) hud.recordDrawn();
		else hud.recordNotDrawn();
	}
	// Another project: the previous one's failure notice goes.
	if (projectId && reporter.resetFor({ scope: projectId })) notices.dismiss();
	// GPU errors the device recorded (on WebGPU they come after the draw).
	hud?.recordGpuErrorStats(gpuStats);
	const outcome = previewDrawOutcome({
		error,
		effectsDropped,
		gpuError: gpuWatcher.check(gpuStats),
		skippedEffects: !effectsFirst,
	});
	if (outcome.action === "clean") {
		if (reporter.clear({ nowMs })) notices.dismiss();
		return;
	}
	if (outcome.action === "still-failing") {
		reporter.stillFailing({ nowMs });
		// Drawn without its effects again: still a draw the HUD counts as such.
		hud?.recordRenderError({
			message: renderErrorMessage(memory.lastFailure() ?? SKIPPED_EFFECTS_MESSAGE),
			nowMs,
		});
		return;
	}
	hud?.recordRenderError({ message: renderErrorMessage(outcome.error), nowMs });
	// Once per failure, not on every frame of a playback; it stays until the failure ends.
	const notice = reporter.report({ error: outcome.error, kind: outcome.kind, nowMs });
	if (!notice) return;
	const text = renderErrorNoticeText(notice);
	notices.logError({ label: text.consoleLabel, error: outcome.error });
	notices.show({
		level: text.level,
		title: text.title,
		description: text.description,
		duration: text.duration,
	});
}
