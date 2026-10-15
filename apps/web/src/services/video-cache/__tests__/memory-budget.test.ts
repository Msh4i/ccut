import { describe, expect, test } from "bun:test";
import {
	BUDGET_FLOOR_BYTES,
	type BudgetState,
	FALLBACK_BUDGET_BYTES,
	GROW_STEP_BYTES,
	MODE_POLICIES,
	type MemoryReading,
	type PerformanceMode,
	PRESSURE_COOLDOWN_TICKS,
	RESERVE_AVAILABLE_BYTES,
	budgetTarget,
	fallbackBudget,
	initialBudget,
	isDecodeStalled,
	nextBudget,
	validateReading,
} from "../memory-budget";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

function reading({
	total,
	available,
	swapTotal = 8 * GiB,
	swapUsed = 0,
	app = 1 * GiB,
}: {
	total: number;
	available: number;
	swapTotal?: number;
	swapUsed?: number;
	app?: number;
}): MemoryReading {
	return {
		totalBytes: total,
		availableBytes: available,
		swapTotalBytes: swapTotal,
		swapFreeBytes: swapTotal - swapUsed,
		appBytes: app,
	};
}

/** The owner's machine: 15.3 GB, about 6 GB available with his other apps open. */
const OWNER = { total: 15.3 * GiB, available: 6 * GiB };

function tick({
	state,
	value,
	ownBytes = 0,
	mode = "balanced",
	stalled = false,
	allocationFailed = false,
}: {
	state: BudgetState;
	value: unknown;
	ownBytes?: number;
	mode?: PerformanceMode;
	stalled?: boolean;
	allocationFailed?: boolean;
}): BudgetState {
	return nextBudget({
		state,
		reading: validateReading(value),
		ownBytes,
		mode,
		stalled,
		allocationFailed,
		deviceMemoryGiB: null,
	});
}

/** Ticks with the same reading until the budget stops moving (bounded). */
function settleOn({
	value,
	mode = "balanced",
	ownBytes = 0,
}: {
	value: unknown;
	mode?: PerformanceMode;
	ownBytes?: number;
}): BudgetState {
	let state = initialBudget({ mode, deviceMemoryGiB: null });
	for (let step = 0; step < 100; step++) {
		state = tick({ state, value, mode, ownBytes });
	}
	return state;
}

describe("budgetTarget: the formula", () => {
	test.each([
		// name, total, available, own, mode, expected
		["a big machine, balanced: the ceiling", 32 * GiB, 20 * GiB, 0, "balanced", 3 * GiB],
		["a big machine, high: the ceiling", 32 * GiB, 20 * GiB, 0, "high", 6 * GiB],
		["the owner's machine, balanced: 50 % of the 6 GB available is the ceiling", OWNER.total, OWNER.available, 0, "balanced", 3 * GiB],
		["the owner's machine, high: what keeps 2 GB of the 6 GB available", OWNER.total, OWNER.available, 0, "high", 4 * GiB],
		["what the cache holds counts as available to it", OWNER.total, 4.5 * GiB, 1.5 * GiB, "balanced", 3 * GiB],
		["a 4 GB cgroup with 3 GB free, balanced: 20 % of total", 4 * GiB, 3 * GiB, 0, "balanced", 0.8 * GiB],
		["a 4 GB cgroup with 1.2 GB free: nothing above the floor", 4 * GiB, 1.2 * GiB, 0, "balanced", BUDGET_FLOOR_BYTES],
		["2 GB stay available: 3 GB free on a 64 GB machine, high", 64 * GiB, 3 * GiB, 0, "high", 1 * GiB],
	] as const)("%s", (_name, total, available, own, mode, expected) => {
		const value = validateReading(reading({ total, available }));
		expect(value).not.toBeNull();
		if (!value) return;
		expect(budgetTarget({ reading: value, ownBytes: own, mode })).toBeCloseTo(expected, -3);
	});

	test("never above the share of total, of available + own, or what keeps 2 GB available", () => {
		for (const mode of ["balanced", "high"] as const) {
			const policy = MODE_POLICIES[mode];
			for (const total of [2, 4, 8, 15.3, 32, 128]) {
				for (const freeShare of [0.05, 0.2, 0.5, 0.9]) {
					const value = validateReading(reading({ total: total * GiB, available: total * freeShare * GiB }));
					if (!value) throw new Error("valid reading expected");
					const target = budgetTarget({ reading: value, ownBytes: 0, mode });
					expect(target).toBeLessThanOrEqual(
						Math.max(
							BUDGET_FLOOR_BYTES,
							Math.min(
								policy.totalShare * value.totalBytes,
								policy.availableShare * value.availableBytes,
								value.availableBytes - RESERVE_AVAILABLE_BYTES,
								policy.ceilingBytes,
							),
						) + 1,
					);
					expect(target).toBeGreaterThanOrEqual(BUDGET_FLOOR_BYTES);
				}
			}
		}
	});
});

describe("nextBudget: growth, pressure and hysteresis", () => {
	test("the owner's machine settles on 3 GB (balanced) and 4 GB (high)", () => {
		expect(settleOn({ value: reading(OWNER) }).budgetBytes).toBeCloseTo(3 * GiB, -3);
		expect(settleOn({ value: reading(OWNER), mode: "high" }).budgetBytes).toBeCloseTo(4 * GiB, -3);
	});

	test("starts at the fallback budget and grows at most one step per tick", () => {
		let state = initialBudget({ mode: "balanced", deviceMemoryGiB: null });
		expect(state.budgetBytes).toBe(FALLBACK_BUDGET_BYTES);
		for (let step = 0; step < 30; step++) {
			const next = tick({ state, value: reading(OWNER) });
			expect(next.budgetBytes - state.budgetBytes).toBeLessThanOrEqual(GROW_STEP_BYTES);
			expect(next.budgetBytes).toBeGreaterThanOrEqual(state.budgetBytes);
			state = next;
		}
		expect(state.budgetBytes).toBeCloseTo(3 * GiB, -3);
	});

	test("filling up does not move the budget: available falls by what the cache takes (no oscillation)", () => {
		for (const mode of ["balanced", "high"] as const) {
			let state = settleOn({ value: reading(OWNER), mode });
			const settled = state.budgetBytes;
			for (let step = 0; step < 40; step++) {
				const own = Math.min(settled, (step + 1) * 100 * MiB);
				state = tick({
					state,
					value: reading({ total: OWNER.total, available: OWNER.available - own }),
					ownBytes: own,
					mode,
				});
				expect(state.budgetBytes).toBe(settled);
			}
		}
	});

	test("pressure while full (available under 1 GB): down to the floor within the same tick", () => {
		const full = settleOn({ value: reading(OWNER) });
		const pressed = tick({
			state: full,
			value: reading({ total: OWNER.total, available: 0.8 * GiB }),
			ownBytes: full.budgetBytes,
		});
		expect(pressed.budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		expect(pressed.reason).toBe("pressure");
		expect(pressed.readAheadSeconds).toBe(0);
	});

	test("swap in use growing is pressure too, even with RAM available", () => {
		const full = settleOn({ value: reading({ ...OWNER, swapUsed: 1 * GiB }) });
		const before = tick({ state: full, value: reading({ ...OWNER, swapUsed: 1 * GiB + 32 * MiB }) });
		expect(before.budgetBytes).toBe(full.budgetBytes);
		expect(before.budgetBytes).toBeCloseTo(3 * GiB, -3);
		const growing = tick({ state: before, value: reading({ ...OWNER, swapUsed: 1 * GiB + 200 * MiB }) });
		expect(growing.budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		expect(growing.reason).toBe("pressure");
		// swap in use but not growing: no pressure
		const steady = settleOn({ value: reading({ ...OWNER, swapUsed: 2 * GiB }) });
		expect(steady.budgetBytes).toBeCloseTo(3 * GiB, -3);
	});

	test("memory coming back: no growth during the cooldown, then one step per tick, never over the target", () => {
		const full = settleOn({ value: reading(OWNER) });
		let state = tick({ state: full, value: reading({ total: OWNER.total, available: 0.5 * GiB }) });
		const history: number[] = [];
		for (let step = 0; step < 40; step++) {
			state = tick({ state, value: reading(OWNER) });
			history.push(state.budgetBytes);
		}
		expect(history.slice(0, PRESSURE_COOLDOWN_TICKS)).toEqual(
			Array.from({ length: PRESSURE_COOLDOWN_TICKS }, () => BUDGET_FLOOR_BYTES),
		);
		for (let index = 1; index < history.length; index++) {
			const change = history[index] - history[index - 1];
			expect(change).toBeGreaterThanOrEqual(0);
			expect(change).toBeLessThanOrEqual(GROW_STEP_BYTES);
		}
		expect(history[history.length - 1]).toBeCloseTo(3 * GiB, -3);
	});

	test("readings that flap around the pressure threshold do not make the budget oscillate", () => {
		let state = settleOn({ value: reading(OWNER) });
		const budgets: number[] = [];
		for (let step = 0; step < 30; step++) {
			const available = step % 2 === 0 ? 0.9 * GiB : 1.1 * GiB;
			state = tick({ state, value: reading({ total: OWNER.total, available }) });
			budgets.push(state.budgetBytes);
		}
		expect(new Set(budgets)).toEqual(new Set([BUDGET_FLOOR_BYTES]));
	});

	test("a failed allocation is pressure", () => {
		const full = settleOn({ value: reading(OWNER) });
		const failed = tick({ state: full, value: reading(OWNER), allocationFailed: true });
		expect(failed.budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		expect(failed.reason).toBe("allocation-failure");
	});

	test("decode stalls: the budget drops to 3/4 of the target without growth; the read-ahead (the jitter buffer) stays", () => {
		const full = settleOn({ value: reading(OWNER) });
		expect(full.readAheadSeconds).toBe(MODE_POLICIES.balanced.readAheadSeconds);
		const stalled = tick({ state: full, value: reading(OWNER), stalled: true });
		expect(stalled.readAheadSeconds).toBe(MODE_POLICIES.balanced.readAheadSeconds);
		expect(stalled.budgetBytes).toBeCloseTo(0.75 * full.budgetBytes, -3);
		expect(stalled.reason).toBe("stall");
		const again = tick({ state: stalled, value: reading(OWNER), stalled: true });
		expect(again.budgetBytes).toBe(stalled.budgetBytes);
		// once decoding keeps up, it grows back slowly
		const recovered = tick({ state: again, value: reading(OWNER) });
		expect(recovered.budgetBytes - again.budgetBytes).toBeLessThanOrEqual(GROW_STEP_BYTES);
		expect(recovered.readAheadSeconds).toBe(MODE_POLICIES.balanced.readAheadSeconds);
	});

	test("a stall never takes the budget under the floor", () => {
		const small = settleOn({ value: reading({ total: 1 * GiB, available: 0.9 * GiB, swapTotal: 0 }) });
		const stalled = tick({ state: small, value: reading({ total: 1 * GiB, available: 0.9 * GiB, swapTotal: 0 }), stalled: true });
		expect(stalled.budgetBytes).toBeGreaterThanOrEqual(BUDGET_FLOOR_BYTES);
	});

	test("swap more than 80 % full is pressure; more than 50 % stops growth", () => {
		const full = settleOn({ value: reading(OWNER) });
		const swapFull = tick({ state: full, value: reading({ ...OWNER, swapUsed: 0.85 * 8 * GiB }) });
		expect(swapFull.reason).toBe("pressure");
		expect(swapFull.budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		let state = initialBudget({ mode: "balanced", deviceMemoryGiB: null });
		const halfSwap = reading({ ...OWNER, swapUsed: 0.6 * 8 * GiB });
		for (let i = 0; i < 20; i++) state = tick({ state, value: halfSwap });
		expect(state.budgetBytes).toBe(initialBudget({ mode: "balanced", deviceMemoryGiB: null }).budgetBytes);
	});

	test("growth needs the MEASURED free memory, whatever the cache thinks it holds", () => {
		let state = initialBudget({ mode: "balanced", deviceMemoryGiB: null });
		const start = state.budgetBytes;
		// 1.6 GB available: one more step would leave less than the 1.5 GB reserve
		const tight = reading({ total: 15.3 * GiB, available: RESERVE_AVAILABLE_BYTES + GROW_STEP_BYTES / 2 });
		for (let i = 0; i < 20; i++) state = tick({ state, value: tight, ownBytes: 1 * GiB });
		expect(state.budgetBytes).toBeLessThanOrEqual(start);
	});

	test("high mode reads further ahead than balanced", () => {
		expect(MODE_POLICIES.high.readAheadSeconds).toBeGreaterThan(MODE_POLICIES.balanced.readAheadSeconds);
		expect(settleOn({ value: reading(OWNER), mode: "high" }).readAheadSeconds).toBe(
			MODE_POLICIES.high.readAheadSeconds,
		);
	});

	test("switching to balanced while holding more than its target shrinks at once", () => {
		const high = settleOn({ value: reading(OWNER), mode: "high" });
		const balanced = tick({ state: high, value: reading(OWNER), mode: "balanced", ownBytes: high.budgetBytes });
		expect(balanced.budgetBytes).toBeCloseTo(3 * GiB, -3);
	});
});

describe("isDecodeStalled", () => {
	test.each([
		// stale frames shown, requests, stalled
		[0, 0, false],
		[2, 10, false],
		[3, 10, true],
		[3, 30, true],
		[3, 31, false],
		[10, 100, true],
		[9, 100, false],
	])("%i stale frames out of %i requests: %s", (stalePresents, requests, expected) => {
		expect(isDecodeStalled({ stalePresents, requests })).toBe(expected);
	});
});

describe("nextBudget: missing and absurd readings", () => {
	test("a missing reading keeps the budget twice, then falls back to the small fixed budget", () => {
		const full = settleOn({ value: reading(OWNER) });
		const first = tick({ state: full, value: null });
		const second = tick({ state: first, value: null });
		expect(first.budgetBytes).toBe(full.budgetBytes);
		expect(second.budgetBytes).toBe(full.budgetBytes);
		const third = tick({ state: second, value: null });
		expect(third.budgetBytes).toBe(FALLBACK_BUDGET_BYTES);
		expect(third.reason).toBe("no-reading");
	});

	test("no bridge at all (web build): the fixed budget, bounded by navigator.deviceMemory as an upper hint", () => {
		expect(settleOn({ value: null }).budgetBytes).toBe(FALLBACK_BUDGET_BYTES);
		expect(fallbackBudget({ deviceMemoryGiB: 8 })).toBe(FALLBACK_BUDGET_BYTES);
		expect(fallbackBudget({ deviceMemoryGiB: 2 })).toBeCloseTo(0.05 * 2 * GiB, -3);
		expect(fallbackBudget({ deviceMemoryGiB: 0.25 })).toBe(BUDGET_FLOOR_BYTES);
		for (const hint of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY, null]) {
			expect(fallbackBudget({ deviceMemoryGiB: hint })).toBe(FALLBACK_BUDGET_BYTES);
		}
	});

	test.each([
		["null", null],
		["a string", "16 GB"],
		["an empty object", {}],
		["NaN total", { ...reading(OWNER), totalBytes: Number.NaN }],
		["negative available", { ...reading(OWNER), availableBytes: -1 }],
		["infinite total", { ...reading(OWNER), totalBytes: Number.POSITIVE_INFINITY }],
		["zero total", { ...reading(OWNER), totalBytes: 0 }],
		["zero total and zero available", { ...reading(OWNER), totalBytes: 0, availableBytes: 0 }],
		["available above total", reading({ total: 4 * GiB, available: 6 * GiB })],
		["a number given as a string", { ...reading(OWNER), availableBytes: "6000000000" }],
	])("%s is no reading", (_name, value) => {
		expect(validateReading(value)).toBeNull();
	});

	test("absurd swap or app fields only drop those fields", () => {
		const value = validateReading({
			...reading(OWNER),
			swapTotalBytes: 1 * GiB,
			swapFreeBytes: 2 * GiB,
			appBytes: Number.NaN,
		});
		expect(value).not.toBeNull();
		expect(value?.swapUsedBytes).toBeNull();
		expect(value?.appBytes).toBeNull();
		expect(value?.availableBytes).toBe(6 * GiB);
	});

	test("an absurd reading after good ones counts as missing, it never grows the budget", () => {
		const full = settleOn({ value: reading(OWNER) });
		const absurd = tick({ state: full, value: { ...reading(OWNER), availableBytes: Number.NaN } });
		expect(absurd.budgetBytes).toBe(full.budgetBytes);
		expect(absurd.missingReadings).toBe(1);
	});

	test("an own byte count that is not a finite number counts as nothing held", () => {
		const value = validateReading(reading(OWNER));
		if (!value) throw new Error("valid reading expected");
		for (const ownBytes of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
			expect(budgetTarget({ reading: value, ownBytes, mode: "balanced" })).toBeCloseTo(3 * GiB, -3);
		}
	});
});
