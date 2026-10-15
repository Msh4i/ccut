import { describe, expect, test } from "bun:test";
import { cancelOutputQuietly } from "../output-cancel";

type FakeTimer = { ms: number; fire: () => void; cancelled: boolean };

function createTimers() {
	const timers: FakeTimer[] = [];
	const startTimeout = ({ ms, onTimeout }: { ms: number; onTimeout: () => void }) => {
		const timer: FakeTimer = { ms, fire: onTimeout, cancelled: false };
		timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};
	return { timers, startTimeout };
}

describe("cancelOutputQuietly", () => {
	test("cancels the output once and says nothing when it works; the timer is cancelled", async () => {
		const { timers, startTimeout } = createTimers();
		const warnings: unknown[][] = [];
		let cancels = 0;

		await cancelOutputQuietly({
			output: {
				cancel: async () => {
					cancels++;
				},
			},
			startTimeout,
			warn: (...args) => warnings.push(args),
		});

		expect(cancels).toBe(1);
		expect(warnings).toEqual([]);
		expect(timers).toHaveLength(1);
		expect(timers[0]?.ms).toBe(3000);
		expect(timers[0]?.cancelled).toBe(true);
	});

	test("a cancel that rejects is reported as a possible leaked encoder worker, and does not throw", async () => {
		const { startTimeout } = createTimers();
		const warnings: unknown[][] = [];
		const failure = new Error("cancel blew up");

		await cancelOutputQuietly({
			output: {
				cancel: async () => {
					throw failure;
				},
			},
			startTimeout,
			warn: (...args) => warnings.push(args),
		});

		expect(warnings).toEqual([["output.cancel failed (possible leaked encoder worker)", failure]]);
	});

	test("a cancel that throws before returning a promise is reported the same way", async () => {
		const { startTimeout } = createTimers();
		const warnings: unknown[][] = [];

		await cancelOutputQuietly({
			output: {
				cancel: () => {
					throw new Error("sync throw");
				},
			},
			startTimeout,
			warn: (...args) => warnings.push(args),
		});

		expect(warnings).toHaveLength(1);
	});

	test("a cancel that never finishes is given up on after the timeout, with a warning, so the real error can be thrown", async () => {
		const { timers, startTimeout } = createTimers();
		const warnings: unknown[][] = [];

		const done = cancelOutputQuietly({
			output: { cancel: () => new Promise<void>(() => {}) },
			startTimeout,
			timeoutMs: 1234,
			warn: (...args) => warnings.push(args),
		});
		expect(timers[0]?.ms).toBe(1234);
		timers[0]?.fire();
		await done;

		expect(warnings).toEqual([["output.cancel did not finish within 1234 ms (possible leaked encoder worker)"]]);
	});

	test("the timer is cancelled also when the cancel fails", async () => {
		const { timers, startTimeout } = createTimers();

		await cancelOutputQuietly({
			output: {
				cancel: async () => {
					throw new Error("x");
				},
			},
			startTimeout,
			warn: () => {},
		});

		expect(timers[0]?.cancelled).toBe(true);
	});
});
