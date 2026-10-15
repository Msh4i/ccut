/**
 * How much memory the video frame cache may hold: pure decisions, ticked by
 * the cache every few seconds with a memory reading of the machine.
 *
 *   budget = min(totalShare x total RAM,
 *                availableShare x (available RAM + what the cache holds),
 *                available RAM + what the cache holds - 2 GB,
 *                ceiling of the mode), at least the floor
 *
 * "What the cache holds" is added back to the available RAM so the target
 * does not move while the cache fills (available falls by what it takes): no
 * feedback loop. The budget shrinks at once (the cache evicts in the same
 * tick) and grows by one step per tick, never during the cooldown after
 * pressure. Pressure: available RAM under 1 GB, swap in use growing, or a
 * failed allocation. Decode stalls shrink it to 3/4 of the target and the
 * read-ahead to its minimum: when the decoder cannot keep up, more decoded
 * frames ahead do not help.
 *
 * Numbers for the owner's machine (15.3 GB, about 6 GB available with his
 * other apps), since round 5d (the owner: "the app limits itself all the
 * time", the cache was far too small once many clips are cut):
 * balanced = min(3.06, 3.0, 4.0, 3.0) = 3.0 GB, high = min(5.36, 4.2, 4.0,
 * 6.0) = 4.0 GB (before: 1.5 and 3.0 GB). Both keep 2 GB available at least
 * (the reserve was 1.5 GB; the budget is now bigger, so the margin to the pressure
 * line of 1.25 GB grew with it). systemd-oomd killed his session twice when RAM and swap filled, hence
 * the shrink on swap growth and the 2 GB that always stay available; the
 * export holds the cache far lower (`VideoCache.holdBudgetAtMost`), because it
 * reads every frame once and a big cache only competes with the encoder.
 */

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export type PerformanceMode = "balanced" | "high";

/** What the desktop bridge reports (`window.ccutSystem.memoryInfo()`). */
export type MemoryReading = {
	totalBytes: number;
	/** Linux MemAvailable. */
	availableBytes: number;
	swapTotalBytes: number;
	swapFreeBytes: number;
	/** Summed working set of the app's own processes. */
	appBytes: number;
};

/** A reading checked at the boundary. Swap and app fields may be unknown on their own. */
export type ValidReading = {
	totalBytes: number;
	availableBytes: number;
	swapUsedBytes: number | null;
	/** Share of the swap in use (0..1); null without swap or a usable swap reading. */
	swapFill?: number | null;
	appBytes: number | null;
};

export type ModePolicy = {
	/** Share of the total RAM. */
	totalShare: number;
	/** Share of (available RAM + what the cache holds). */
	availableShare: number;
	ceilingBytes: number;
	/** Decoded frames kept ahead of the playhead per stream (bounded in frames and bytes by the stream). */
	readAheadSeconds: number;
};

export const MODE_POLICIES: Record<PerformanceMode, ModePolicy> = {
	balanced: {
		totalShare: 0.2,
		availableShare: 0.5,
		ceilingBytes: 3 * GiB,
		readAheadSeconds: 0.25,
	},
	high: {
		totalShare: 0.35,
		availableShare: 0.7,
		ceilingBytes: 6 * GiB,
		readAheadSeconds: 0.5,
	},
};

/** Never less: a few drawn 1080p frames (8.3 MB each as RGBA). */
export const BUDGET_FLOOR_BYTES = 64 * MiB;
/** The budget never plans to leave less RAM available than this. */
export const RESERVE_AVAILABLE_BYTES = 2 * GiB;
/** Available RAM under this is pressure: down to the floor at once. */
export const PRESSURE_AVAILABLE_BYTES = 1.25 * GiB;
/** Swap in use growing by more than this between two readings is pressure. */
export const SWAP_GROWTH_PRESSURE_BYTES = 64 * MiB;
/** Ticks without growth after pressure (one tick: READING_INTERVAL_MS). */
export const PRESSURE_COOLDOWN_TICKS = 5;
/** Growth per tick: from the floor to 3 GB in about 23 ticks. */
export const GROW_STEP_BYTES = 128 * MiB;
/** Without readings (web build, bridge failing): a small fixed budget. */
export const FALLBACK_BUDGET_BYTES = 256 * MiB;
/** Readings missed in a row before the fixed budget replaces the last one. */
export const MISSING_READINGS_TOLERATED = 2;
/** Decode stalls: the budget goes down to this share of the target. */
export const STALL_SHARE = 0.75;
/** Swap this full counts as pressure (systemd-oomd acts on the swap fill level). */
export const SWAP_PRESSURE_FILL = 0.8;
/** Above this swap fill the budget does not grow. */
export const SWAP_NO_GROWTH_FILL = 0.5;
/** Without readings, at most this share of `navigator.deviceMemory`. */
const DEVICE_MEMORY_SHARE = 0.05;

export type BudgetReason =
	| "start"
	| "reading"
	| "pressure"
	| "allocation-failure"
	| "stall"
	| "no-reading";

export type BudgetState = {
	budgetBytes: number;
	/** 0: the stream keeps its minimum read-ahead (pressure, stalls). */
	readAheadSeconds: number;
	/** Swap in use at the last valid reading (to see it grow). */
	swapUsedBytes: number | null;
	missingReadings: number;
	/** Ticks left without growth after pressure. */
	cooldownTicks: number;
	reason: BudgetReason;
};

function finiteNonNegative(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function field({ value, key }: { value: object; key: string }): number | null {
	return finiteNonNegative(Reflect.get(value, key));
}

/** Stale frames needed in one tick, and their share of the requests, to call decoding stalled. */
const STALL_MIN_STALE = 3;
const STALL_MIN_SHARE = 0.1;

/**
 * Whether the decoder fell behind during the last tick: playback showed a
 * slightly older frame (the "stale" counter) for at least 3 requests and at
 * least 10 % of them. Only a playing preview shows stale frames, so paused
 * seeks (which always wait for the decoder) never count.
 */
export function isDecodeStalled({
	stalePresents,
	requests,
}: {
	stalePresents: number;
	requests: number;
}): boolean {
	return stalePresents >= STALL_MIN_STALE && stalePresents >= STALL_MIN_SHARE * requests;
}

/**
 * Checks what the bridge returned. Anything else than a total above zero and
 * an available amount within it is no reading; absurd swap or app fields
 * only make those fields unknown.
 */
export function validateReading(value: unknown): ValidReading | null {
	if (typeof value !== "object" || value === null) return null;
	const totalBytes = field({ value, key: "totalBytes" });
	const availableBytes = field({ value, key: "availableBytes" });
	if (totalBytes === null || availableBytes === null) return null;
	if (totalBytes <= 0 || availableBytes > totalBytes) return null;
	const swapTotal = field({ value, key: "swapTotalBytes" });
	const swapFree = field({ value, key: "swapFreeBytes" });
	const swapUsedBytes =
		swapTotal !== null && swapFree !== null && swapFree <= swapTotal
			? swapTotal - swapFree
			: null;
	return {
		totalBytes,
		availableBytes,
		swapUsedBytes,
		swapFill:
			swapUsedBytes !== null && swapTotal !== null && swapTotal > 0
				? swapUsedBytes / swapTotal
				: null,
		appBytes: field({ value, key: "appBytes" }),
	};
}

function clampToBounds({ bytes, mode }: { bytes: number; mode: PerformanceMode }): number {
	return Math.max(BUDGET_FLOOR_BYTES, Math.min(MODE_POLICIES[mode].ceilingBytes, bytes));
}

/** The budget a reading allows (before growth limits and pressure). */
export function budgetTarget({
	reading,
	ownBytes,
	mode,
}: {
	reading: ValidReading;
	ownBytes: number;
	mode: PerformanceMode;
}): number {
	const policy = MODE_POLICIES[mode];
	const reachable = reading.availableBytes + (finiteNonNegative(ownBytes) ?? 0);
	return clampToBounds({
		bytes: Math.min(
			policy.totalShare * reading.totalBytes,
			policy.availableShare * reachable,
			reachable - RESERVE_AVAILABLE_BYTES,
		),
		mode,
	});
}

/** The budget without readings: fixed, and at most 5 % of `navigator.deviceMemory` when known. */
export function fallbackBudget({
	deviceMemoryGiB,
}: {
	deviceMemoryGiB: number | null;
}): number {
	const hint = finiteNonNegative(deviceMemoryGiB);
	if (hint === null || hint === 0) return FALLBACK_BUDGET_BYTES;
	return Math.max(
		BUDGET_FLOOR_BYTES,
		Math.min(FALLBACK_BUDGET_BYTES, DEVICE_MEMORY_SHARE * hint * GiB),
	);
}

export function initialBudget({
	mode,
	deviceMemoryGiB,
}: {
	mode: PerformanceMode;
	deviceMemoryGiB: number | null;
}): BudgetState {
	return {
		budgetBytes: fallbackBudget({ deviceMemoryGiB }),
		readAheadSeconds: MODE_POLICIES[mode].readAheadSeconds,
		swapUsedBytes: null,
		missingReadings: 0,
		cooldownTicks: 0,
		reason: "start",
	};
}

/** Moves toward `target`: down at once, up by one step when growth is allowed. */
function approach({
	current,
	target,
	mayGrow,
}: {
	current: number;
	target: number;
	mayGrow: boolean;
}): number {
	if (target <= current) return target;
	return mayGrow ? Math.min(target, current + GROW_STEP_BYTES) : current;
}

/** One tick of the budget. */
export function nextBudget({
	state,
	reading,
	ownBytes,
	mode,
	stalled,
	allocationFailed,
	deviceMemoryGiB,
}: {
	state: BudgetState;
	reading: ValidReading | null;
	ownBytes: number;
	mode: PerformanceMode;
	stalled: boolean;
	allocationFailed: boolean;
	deviceMemoryGiB: number | null;
}): BudgetState {
	const readAheadSeconds = MODE_POLICIES[mode].readAheadSeconds;
	const swapUsedBytes = reading ? reading.swapUsedBytes : state.swapUsedBytes;
	const pressed = (reason: BudgetReason): BudgetState => ({
		budgetBytes: BUDGET_FLOOR_BYTES,
		readAheadSeconds: 0,
		swapUsedBytes,
		missingReadings: reading ? 0 : state.missingReadings + 1,
		cooldownTicks: PRESSURE_COOLDOWN_TICKS,
		reason,
	});
	if (allocationFailed) return pressed("allocation-failure");

	if (!reading) {
		const missingReadings = state.missingReadings + 1;
		if (missingReadings <= MISSING_READINGS_TOLERATED) {
			// A hiccup of the bridge: keep the budget, never grow on it.
			return { ...state, missingReadings, reason: state.reason };
		}
		return {
			...state,
			budgetBytes: approach({
				current: state.budgetBytes,
				target: Math.min(MODE_POLICIES[mode].ceilingBytes, fallbackBudget({ deviceMemoryGiB })),
				mayGrow: state.cooldownTicks === 0 && !stalled,
			}),
			readAheadSeconds: stalled ? 0 : readAheadSeconds,
			missingReadings,
			cooldownTicks: Math.max(0, state.cooldownTicks - 1),
			reason: "no-reading",
		};
	}

	const swapGrowth =
		reading.swapUsedBytes !== null && state.swapUsedBytes !== null
			? reading.swapUsedBytes - state.swapUsedBytes
			: 0;
	const swapFill = reading.swapFill ?? 0;
	if (
		reading.availableBytes < PRESSURE_AVAILABLE_BYTES ||
		swapGrowth > SWAP_GROWTH_PRESSURE_BYTES ||
		swapFill > SWAP_PRESSURE_FILL
	) {
		return pressed("pressure");
	}

	const target = budgetTarget({ reading, ownBytes, mode });
	const cooldownTicks = Math.max(0, state.cooldownTicks - 1);
	if (stalled) {
		// The read-ahead stays: it is the jitter buffer a late decoder needs.
		return {
			budgetBytes: Math.max(
				BUDGET_FLOOR_BYTES,
				Math.min(state.budgetBytes, STALL_SHARE * target),
			),
			readAheadSeconds,
			swapUsedBytes,
			missingReadings: 0,
			cooldownTicks,
			reason: "stall",
		};
	}
	return {
		budgetBytes: approach({
			current: state.budgetBytes,
			target,
			// Growth is judged on what is MEASURED free, not on the estimate of what
			// the cache holds (the real footprint can be larger than the estimate).
			mayGrow:
				state.cooldownTicks === 0 &&
				swapFill <= SWAP_NO_GROWTH_FILL &&
				reading.availableBytes - GROW_STEP_BYTES >= RESERVE_AVAILABLE_BYTES,
		}),
		readAheadSeconds,
		swapUsedBytes,
		missingReadings: 0,
		cooldownTicks,
		reason: "reading",
	};
}
