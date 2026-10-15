import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { SaveManager } from "../save-manager";

const quotaError = new DOMException(
	"The quota has been exceeded.",
	"QuotaExceededError",
);

async function waitFor({
	condition,
	timeoutMs = 2000,
}: {
	condition: () => boolean;
	timeoutMs?: number;
}) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(1);
	}
}

function createGate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const managers: SaveManager[] = [];
let consoleError: ReturnType<typeof spyOn>;

beforeEach(() => {
	// A failed save is logged on purpose; keep the test output readable.
	consoleError = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	for (const manager of managers.splice(0)) manager.stop();
	consoleError.mockRestore();
});

function createHarness({
	debounceMs = 1,
	retryDelayMs = 5,
	saveTimeoutMs,
	flushTimeoutMs,
}: {
	debounceMs?: number;
	retryDelayMs?: number;
	saveTimeoutMs?: number;
	flushTimeoutMs?: number;
} = {}) {
	const state = {
		hasActiveProject: true,
		isLoading: false,
		isMigrating: false,
		// While set, every save fails with it.
		failure: null as unknown,
		// While set, every save waits for it.
		gate: null as Promise<void> | null,
		concurrent: 0,
		maxConcurrent: 0,
	};
	const sceneListeners = new Set<() => void>();

	const saveCurrentProject = mock(async () => {
		state.concurrent += 1;
		state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
		try {
			if (state.gate) await state.gate;
			if (state.failure) throw state.failure;
		} finally {
			state.concurrent -= 1;
		}
	});

	const editor = {
		scenes: {
			subscribe: (listener: () => void) => {
				sceneListeners.add(listener);
				return () => sceneListeners.delete(listener);
			},
		},
		timeline: { subscribe: () => () => {} },
		project: {
			getActiveOrNull: () => (state.hasActiveProject ? { id: "p1" } : null),
			getIsLoading: () => state.isLoading,
			getMigrationState: () => ({ isMigrating: state.isMigrating }),
			saveCurrentProject,
		},
	};

	const reporter = {
		saveFailed: mock((_args: { error: unknown }) => {}),
		saveRecovered: mock(() => {}),
		dismissFailure: mock(() => {}),
	};

	const manager = new SaveManager({
		editor,
		debounceMs,
		reporter,
		getRetryDelayMs: () => retryDelayMs,
		saveTimeoutMs,
		flushTimeoutMs,
	});
	managers.push(manager);
	manager.start();

	return {
		manager,
		state,
		reporter,
		saveCurrentProject,
		edit: () => {
			for (const listener of sceneListeners) listener();
		},
	};
}

describe("SaveManager failure handling", () => {
	test("a failed autosave keeps the project dirty and is reported once", async () => {
		const harness = createHarness({ retryDelayMs: 60_000 });
		harness.state.failure = quotaError;

		harness.edit();
		await waitFor({
			condition: () => harness.reporter.saveFailed.mock.calls.length === 1,
		});

		// This is what the beforeunload guard reads.
		expect(harness.manager.getIsDirty()).toBe(true);
		expect(harness.reporter.saveFailed).toHaveBeenCalledTimes(1);
		expect(harness.reporter.saveFailed).toHaveBeenCalledWith({
			error: quotaError,
		});
		expect(harness.reporter.saveRecovered).not.toHaveBeenCalled();
	});

	test("a successful autosave clears the dirty flag without any failure notice", async () => {
		const harness = createHarness();

		harness.edit();
		expect(harness.manager.getIsDirty()).toBe(true);
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(1);
		expect(harness.reporter.saveFailed).not.toHaveBeenCalled();
		expect(harness.reporter.saveRecovered).not.toHaveBeenCalled();
	});

	test("the project stays dirty for the whole time a save is running", async () => {
		const harness = createHarness();
		const gate = createGate();
		harness.state.gate = gate.promise;

		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });

		expect(harness.manager.getIsDirty()).toBe(true);
		gate.release();
		await waitFor({ condition: () => !harness.manager.getIsDirty() });
	});

	test("repeated failures of one streak do not report again", async () => {
		const harness = createHarness({ retryDelayMs: 2 });
		harness.state.failure = new Error("still failing");

		harness.edit();
		await waitFor({
			condition: () => harness.saveCurrentProject.mock.calls.length >= 4,
		});

		expect(harness.reporter.saveFailed).toHaveBeenCalledTimes(1);
		expect(harness.manager.getIsDirty()).toBe(true);
	});

	test("the backoff timer retries on its own and recovers once the store works again", async () => {
		const harness = createHarness({ retryDelayMs: 2 });
		harness.state.failure = quotaError;

		harness.edit();
		await waitFor({
			condition: () => harness.saveCurrentProject.mock.calls.length >= 3,
		});
		harness.state.failure = null; // The user freed some space.
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		expect(harness.reporter.saveFailed).toHaveBeenCalledTimes(1);
		expect(harness.reporter.saveRecovered).toHaveBeenCalledTimes(1);
	});

	test("the next change retries without waiting for the backoff timer", async () => {
		const harness = createHarness({ retryDelayMs: 60_000 });
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({
			condition: () => harness.saveCurrentProject.mock.calls.length >= 1,
		});

		harness.state.failure = null;
		harness.edit();
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(2);
		expect(harness.reporter.saveRecovered).toHaveBeenCalledTimes(1);
	});

	test("a new failure after a recovery starts a new streak and reports again", async () => {
		const harness = createHarness({ retryDelayMs: 60_000 });
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({
			condition: () => harness.reporter.saveFailed.mock.calls.length === 1,
		});
		harness.state.failure = null;
		harness.edit();
		await waitFor({
			condition: () => harness.reporter.saveRecovered.mock.calls.length === 1,
		});

		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({
			condition: () => harness.reporter.saveFailed.mock.calls.length === 2,
		});

		expect(harness.manager.getIsDirty()).toBe(true);
	});

	test("a failure never escapes as an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const harness = createHarness({ retryDelayMs: 2 });
			harness.state.failure = quotaError;

			harness.edit();
			await waitFor({
				condition: () => harness.saveCurrentProject.mock.calls.length >= 3,
			});
			await Bun.sleep(10);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
	});

	test("a pending save after the project was closed is dropped quietly", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const harness = createHarness();
			harness.state.hasActiveProject = false;

			harness.edit();
			await Bun.sleep(15);

			expect(harness.saveCurrentProject).not.toHaveBeenCalled();
			expect(harness.manager.getIsDirty()).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
	});
});

describe("SaveManager never overlaps saves", () => {
	test("edits made during a running save are saved afterwards, one at a time", async () => {
		const harness = createHarness();
		const gate = createGate();
		harness.state.gate = gate.promise;

		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });
		for (let index = 0; index < 5; index += 1) harness.edit();
		await Bun.sleep(10);
		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(1);

		harness.state.gate = null;
		gate.release();
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(2);
		expect(harness.state.maxConcurrent).toBe(1);
	});

	test("a backoff retry never starts while another save is running", async () => {
		const harness = createHarness({ retryDelayMs: 2 });
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({
			condition: () => harness.saveCurrentProject.mock.calls.length >= 1,
		});

		const gate = createGate();
		harness.state.gate = gate.promise;
		harness.state.failure = null;
		harness.edit();
		await Bun.sleep(30);
		gate.release();
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		expect(harness.state.maxConcurrent).toBe(1);
	});

	test("a failing save plus flush calls still run one at a time", async () => {
		const harness = createHarness({ retryDelayMs: 1 });
		harness.state.failure = quotaError;

		harness.edit();
		const flushes = [
			harness.manager.flush().catch(() => {}),
			harness.manager.flush().catch(() => {}),
		];
		await Promise.all(flushes);
		await Bun.sleep(10);

		expect(harness.state.maxConcurrent).toBe(1);
	});
});

describe("SaveManager.flush", () => {
	test("resolves once the save succeeded", async () => {
		const harness = createHarness();

		await harness.manager.flush();

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(1);
		expect(harness.manager.getIsDirty()).toBe(false);
	});

	test("rejects with the save error when the save fails, so an exit can be stopped", async () => {
		const harness = createHarness({ retryDelayMs: 60_000 });
		harness.state.failure = quotaError;

		await expect(harness.manager.flush()).rejects.toBe(quotaError);

		expect(harness.manager.getIsDirty()).toBe(true);
		expect(harness.reporter.saveFailed).toHaveBeenCalledTimes(1);
	});

	test("waits for a running save and then saves the changes made meanwhile", async () => {
		const harness = createHarness();
		const gate = createGate();
		harness.state.gate = gate.promise;
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });
		harness.edit();

		const flushed = harness.manager.flush();
		harness.state.gate = null;
		gate.release();
		await flushed;

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(2);
		expect(harness.state.maxConcurrent).toBe(1);
		expect(harness.manager.getIsDirty()).toBe(false);
	});

	test("reports the failure of a running save instead of claiming success", async () => {
		const harness = createHarness({ retryDelayMs: 60_000 });
		const gate = createGate();
		harness.state.gate = gate.promise;
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });

		const flushed = harness.manager.flush();
		gate.release();

		await expect(flushed).rejects.toBe(quotaError);
		expect(harness.manager.getIsDirty()).toBe(true);
	});

	test("recovers a failing streak when the store works again", async () => {
		const harness = createHarness({ retryDelayMs: 60_000 });
		harness.state.failure = quotaError;
		await harness.manager.flush().catch(() => {});

		harness.state.failure = null;
		await harness.manager.flush();

		expect(harness.manager.getIsDirty()).toBe(false);
		expect(harness.reporter.saveRecovered).toHaveBeenCalledTimes(1);
	});
});

describe("SaveManager pause, stop and discard", () => {
	test("changes made while paused are ignored unless forced, and saved on resume", async () => {
		const harness = createHarness();
		harness.manager.pause();

		harness.edit();
		expect(harness.manager.getIsDirty()).toBe(false);

		harness.manager.markDirty({ force: true });
		await Bun.sleep(15);
		expect(harness.saveCurrentProject).not.toHaveBeenCalled();

		harness.manager.resume();
		await waitFor({ condition: () => !harness.manager.getIsDirty() });
		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(1);
	});

	test("the backoff timer does not save while paused and carries on after resume", async () => {
		const harness = createHarness({ retryDelayMs: 2 });
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({
			condition: () => harness.saveCurrentProject.mock.calls.length >= 1,
		});

		harness.manager.pause();
		await Bun.sleep(10);
		const callsWhilePaused = harness.saveCurrentProject.mock.calls.length;
		await Bun.sleep(20);
		expect(harness.saveCurrentProject.mock.calls.length).toBe(callsWhilePaused);

		harness.state.failure = null;
		harness.manager.resume();
		await waitFor({ condition: () => !harness.manager.getIsDirty() });
	});

	test("stop cancels the backoff timer", async () => {
		const harness = createHarness({ retryDelayMs: 2 });
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({
			condition: () => harness.saveCurrentProject.mock.calls.length >= 1,
		});

		harness.manager.stop();
		const calls = harness.saveCurrentProject.mock.calls.length;
		await Bun.sleep(20);

		expect(harness.saveCurrentProject.mock.calls.length).toBe(calls);
	});

	test("discard forgets the unsaved state of a closed project and dismisses the failure notice", async () => {
		const harness = createHarness({ retryDelayMs: 2 });
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({
			condition: () => harness.saveCurrentProject.mock.calls.length >= 1,
		});

		harness.manager.discard();
		const calls = harness.saveCurrentProject.mock.calls.length;
		await Bun.sleep(20);

		expect(harness.manager.getIsDirty()).toBe(false);
		expect(harness.saveCurrentProject.mock.calls.length).toBe(calls);
		expect(harness.reporter.dismissFailure).toHaveBeenCalledTimes(1);
		expect(harness.reporter.saveRecovered).not.toHaveBeenCalled();
	});

	test("discard does not touch the failure notice when nothing failed", () => {
		const harness = createHarness();
		harness.edit();

		harness.manager.discard();

		expect(harness.reporter.dismissFailure).not.toHaveBeenCalled();
		expect(harness.manager.getIsDirty()).toBe(false);
	});
});

describe("SaveManager.discard with a save already running", () => {
	test("a late failure of the discarded project is ignored", async () => {
		const harness = createHarness({ retryDelayMs: 2 });
		const gate = createGate();
		harness.state.gate = gate.promise;
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });

		harness.manager.discard();
		gate.release();
		await Bun.sleep(25);

		expect(harness.reporter.saveFailed).not.toHaveBeenCalled();
		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(1);
		expect(harness.manager.getIsDirty()).toBe(false);
	});

	test("the next project is saved normally afterwards", async () => {
		const harness = createHarness();
		const gate = createGate();
		harness.state.gate = gate.promise;
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });
		harness.manager.discard();
		gate.release();
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		harness.state.gate = null;
		harness.edit();
		expect(harness.manager.getIsDirty()).toBe(true);
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(2);
	});
});

describe("SaveManager.waitForIdle", () => {
	test("resolves at once when nothing is saving", async () => {
		const harness = createHarness();

		await harness.manager.waitForIdle();
	});

	test("waits for a running save, even one that fails", async () => {
		const harness = createHarness({ retryDelayMs: 60_000 });
		const gate = createGate();
		harness.state.gate = gate.promise;
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });

		let idle = false;
		const waiting = harness.manager.waitForIdle().then(() => {
			idle = true;
		});
		await Bun.sleep(5);
		expect(idle).toBe(false);

		gate.release();
		await waiting;
		expect(idle).toBe(true);
	});
});

describe("SaveManager when a save never settles", () => {
	test("a hung save is given up after the watchdog and retried", async () => {
		const harness = createHarness({ retryDelayMs: 5, saveTimeoutMs: 20 });
		harness.state.gate = new Promise<void>(() => {}); // never settles

		harness.edit();
		await waitFor({
			condition: () => harness.reporter.saveFailed.mock.calls.length === 1,
		});
		expect(harness.manager.getIsDirty()).toBe(true);

		harness.state.gate = null;
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		expect(harness.reporter.saveRecovered).toHaveBeenCalledTimes(1);
	});

	test("flush rejects instead of hanging when the save takes too long", async () => {
		const harness = createHarness({ saveTimeoutMs: 5_000, flushTimeoutMs: 20 });
		const hung = createGate();
		harness.state.gate = hung.promise;

		await expect(harness.manager.flush()).rejects.toThrow(/too long/i);

		expect(harness.manager.getIsDirty()).toBe(true);

		// The save itself is still running with its 5 s watchdog armed. Let it
		// finish: left running, the watchdog fires 5 s later during an unrelated
		// test file (bun runs them all in one process), logs "Failed to save
		// project" there and its retry loop never stops.
		hung.release();
		await harness.manager.waitForIdle();
	});
});

describe("SaveManager.stop while a save is in flight", () => {
	test("a manager that was not stopped keeps retrying after a timed-out save", async () => {
		const harness = createHarness({ retryDelayMs: 5, saveTimeoutMs: 20 });
		harness.state.gate = new Promise<void>(() => {}); // never settles

		harness.edit();
		await waitFor({
			condition: () => harness.saveCurrentProject.mock.calls.length >= 3,
		});

		expect(consoleError).toHaveBeenCalledWith(
			"Failed to save project:",
			expect.objectContaining({ message: "Saving timed out." }),
		);
		expect(harness.reporter.saveFailed).toHaveBeenCalledTimes(1);
		expect(harness.manager.getIsDirty()).toBe(true);
	});

	test("stop while a save is hung: the watchdog firing later does not start a retry loop", async () => {
		const harness = createHarness({ retryDelayMs: 5, saveTimeoutMs: 20 });
		harness.state.gate = new Promise<void>(() => {}); // never settles
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });

		harness.manager.stop();
		// Resolves once the watchdog has given the hung save up.
		await harness.manager.waitForIdle();
		// Long enough for several retries (5 ms apart) if one had been armed.
		await Bun.sleep(40);

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(1);
		expect(consoleError).not.toHaveBeenCalled();
		expect(harness.reporter.saveFailed).not.toHaveBeenCalled();
	});

	test("stop while a save is running: its late failure is ignored", async () => {
		const harness = createHarness({ retryDelayMs: 5 });
		const gate = createGate();
		harness.state.gate = gate.promise;
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });

		harness.manager.stop();
		gate.release();
		await harness.manager.waitForIdle();
		await Bun.sleep(30);

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(1);
		expect(consoleError).not.toHaveBeenCalled();
		expect(harness.reporter.saveFailed).not.toHaveBeenCalled();
	});

	test("stop while a save is running: its late success starts no new save and shows no notice", async () => {
		const harness = createHarness({ retryDelayMs: 60_000 });
		// A failing streak first, so a late success would announce a recovery.
		harness.state.failure = quotaError;
		harness.edit();
		await waitFor({
			condition: () => harness.reporter.saveFailed.mock.calls.length === 1,
		});

		const gate = createGate();
		harness.state.failure = null;
		harness.state.gate = gate.promise;
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });
		// A change made during the save: a running manager would save again.
		harness.edit();

		harness.manager.stop();
		gate.release();
		await harness.manager.waitForIdle();
		await Bun.sleep(30);

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(2);
		expect(harness.reporter.saveRecovered).not.toHaveBeenCalled();
	});

	test("changes marked after stop are not autosaved", async () => {
		const harness = createHarness();
		harness.manager.stop();

		harness.manager.markDirty({ force: true });
		harness.manager.resume();
		await Bun.sleep(15);

		expect(harness.saveCurrentProject).not.toHaveBeenCalled();
	});

	test("start after stop brings autosave back", async () => {
		const harness = createHarness();
		harness.manager.stop();
		harness.manager.start();

		harness.edit();
		await waitFor({ condition: () => !harness.manager.getIsDirty() });

		expect(harness.saveCurrentProject).toHaveBeenCalledTimes(1);
	});

	test("flush still rejects instead of hanging when stop happens during a hung save", async () => {
		const harness = createHarness({ saveTimeoutMs: 5_000, flushTimeoutMs: 20 });
		const hung = createGate();
		harness.state.gate = hung.promise;
		harness.edit();
		await waitFor({ condition: () => harness.state.concurrent === 1 });

		const flushed = harness.manager.flush();
		harness.manager.stop();

		await expect(flushed).rejects.toThrow(/too long/i);

		hung.release();
		await harness.manager.waitForIdle();
	});
});

describe("SaveManager.flush while the project cannot be saved yet", () => {
	test("rejects while the project is loading, and stays dirty", async () => {
		const harness = createHarness();
		harness.state.isLoading = true;

		await expect(harness.manager.flush()).rejects.toThrow(/loading/i);

		expect(harness.saveCurrentProject).not.toHaveBeenCalled();
		expect(harness.manager.getIsDirty()).toBe(true);

		harness.state.isLoading = false;
		await harness.manager.flush();
		expect(harness.manager.getIsDirty()).toBe(false);
	});

	test("rejects while the storage is migrating", async () => {
		const harness = createHarness();
		harness.state.isMigrating = true;

		await expect(harness.manager.flush()).rejects.toThrow(/loading/i);

		expect(harness.saveCurrentProject).not.toHaveBeenCalled();
	});

	test("resolves without saving when no project is open", async () => {
		const harness = createHarness();
		harness.state.hasActiveProject = false;

		await harness.manager.flush();

		expect(harness.saveCurrentProject).not.toHaveBeenCalled();
		expect(harness.manager.getIsDirty()).toBe(false);
	});
});
