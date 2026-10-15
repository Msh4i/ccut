/**
 * The first Space after opening a project used to start the playhead at once while the video
 * decoder (GPU/utility process) needed ~4.3 s for its FIRST use, so the playhead froze and then
 * raced to catch up. The decoder is now warmed up when the project opens
 * (`services/video-cache/decoder-prewarm.ts`); as a safety net the clock still waits, after Space,
 * for the first decoded frame at the playhead, but never longer than `START_GATE_MAX_MS`.
 */
export const START_GATE_MAX_MS = 6000;

/** Resolves when `gate` has settled or `maxMs` has passed, whichever is first. */
export async function waitForStartGate({
	gate,
	maxMs = START_GATE_MAX_MS,
	sleep,
}: {
	gate: () => Promise<void>;
	maxMs?: number;
	sleep: (ms: number) => Promise<void>;
}): Promise<"ready" | "timeout"> {
	return Promise.race([
		gate().then(
			() => "ready" as const,
			() => "ready" as const,
		),
		sleep(maxMs).then(() => "timeout" as const),
	]);
}
