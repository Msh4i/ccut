import type { PerformanceMode } from "./memory-budget";

export type { PerformanceMode } from "./memory-budget";

/**
 * The app-wide "Performance" setting (Settings tab): how much of the machine
 * playback may use. Pure helpers; the persisted store is
 * `performance-store.ts`.
 */

/**
 * High since round 5d: the owner found that the app limited itself all the time (a project with
 * many cut clips got slower and slower). The cache still gives memory back when the machine runs
 * low and keeps 2 GB available (`memory-budget.ts`); "Balanced" is the smaller choice.
 */
export const DEFAULT_PERFORMANCE_MODE: PerformanceMode = "high";

export const PERFORMANCE_MODE_OPTIONS: ReadonlyArray<{
	mode: PerformanceMode;
	label: string;
	description: string;
}> = [
	{
		mode: "balanced",
		label: "Balanced",
		description: "Caches up to 20% of RAM (at most 3 GB) for playback.",
	},
	{
		mode: "high",
		label: "High",
		description:
			"Caches up to 35% of RAM (at most 6 GB) and reads further ahead. Gives memory back when the system runs low, and keeps at least 2 GB free. While exporting, the frames kept for playback are held small.",
	},
];

export function parsePerformanceMode(value: unknown): PerformanceMode {
	return value === "high" || value === "balanced" ? value : DEFAULT_PERFORMANCE_MODE;
}

/**
 * zustand persist `merge`: a stored mode is read through parsePerformanceMode,
 * so a value from a newer or hand-edited app never reaches the cache.
 */
export function mergePersistedPerformance<TState extends { mode: PerformanceMode }>({
	persisted,
	current,
}: {
	persisted: unknown;
	current: TState;
}): TState {
	const stored =
		typeof persisted === "object" && persisted !== null
			? Reflect.get(persisted, "mode")
			: undefined;
	return { ...current, mode: parsePerformanceMode(stored) };
}

/** Workers the high mode may give to decoding: logical cores minus two (the UI), at most 4. */
const MAX_DECODE_WORKERS = 4;
const CORES_KEPT_FOR_THE_UI = 2;

/**
 * Decode workers for a later lever (worker decode; nothing uses it yet).
 * Balanced: 1. High: max(1, logical cores - 2), at most 4. An unknown core
 * count is 1.
 */
export function decodeWorkerCount({
	mode,
	hardwareConcurrency,
}: {
	mode: PerformanceMode;
	hardwareConcurrency: number | undefined;
}): number {
	if (mode === "balanced") return 1;
	if (
		hardwareConcurrency === undefined ||
		!Number.isFinite(hardwareConcurrency) ||
		hardwareConcurrency < 1
	) {
		return 1;
	}
	return Math.min(
		MAX_DECODE_WORKERS,
		Math.max(1, Math.floor(hardwareConcurrency) - CORES_KEPT_FOR_THE_UI),
	);
}
