// What the main process does when the window's renderer process dies (render-process-gone).
// The usual cause on a many-clip export is Chromium's 8 GiB limit on a renderer's writable memory
// (reason "oom" or a SIGTRAP "crashed"): without this the window stays black for good.
// Pure functions, the Electron calls are in main.js.

const RELOAD_WINDOW_MS = 60_000;
const MAX_RELOADS_PER_WINDOW = 2;

/** "clean-exit" is a normal end (the window was closed). */
const IGNORED_REASONS = new Set(["clean-exit"]);

/**
 * { reload, title, message } for a dead renderer, or null when nothing is to be done. `recentReloads`
 * are the times (ms) of the reloads this gate already made: after MAX_RELOADS_PER_WINDOW in a minute
 * the window is not reloaded again (a crash on load would loop), the owner is told so instead.
 */
function decideRenderGone({ reason, exitCode, now, recentReloads }) {
	if (IGNORED_REASONS.has(reason)) return null;
	const recent = recentReloads.filter((at) => now - at < RELOAD_WINDOW_MS);
	const reload = recent.length < MAX_RELOADS_PER_WINDOW;
	const memory = reason === "oom" || reason === "crashed";
	const cause = memory
		? "The editor window ran out of memory and was stopped by the system (an export of a project with very many clips can do this)."
		: `The editor window stopped unexpectedly (${String(reason)}${Number.isInteger(exitCode) ? `, exit code ${exitCode}` : ""}).`;
	const message = [
		cause,
		reload ? "It was reloaded. Changes saved before the stop are kept; an unfinished export is lost." : "It was not reloaded again because it stopped twice in a minute. Close and reopen Ccut.",
		"If you were exporting, export again after closing other apps, or export the project in two parts.",
	].join("\n\n");
	return { reload, recent: [...recent, ...(reload ? [now] : [])], title: memory ? "Ccut ran out of memory" : "Ccut window stopped", message };
}

module.exports = { MAX_RELOADS_PER_WINDOW, RELOAD_WINDOW_MS, decideRenderGone };
