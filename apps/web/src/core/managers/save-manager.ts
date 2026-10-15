import {
	createToastSaveReporter,
	getSaveRetryDelayMs,
	type SaveReporter,
} from "./save-failure";

/** What SaveManager needs from the editor (EditorCore provides all of it). */
type SaveManagerHost = {
	scenes: { subscribe(listener: () => void): () => void };
	timeline: { subscribe(listener: () => void): () => void };
	project: {
		getActiveOrNull(): unknown;
		getIsLoading(): boolean;
		getMigrationState(): { isMigrating: boolean };
		saveCurrentProject(): Promise<void>;
	};
};

type SaveManagerOptions = {
	debounceMs?: number;
	reporter?: SaveReporter;
	getRetryDelayMs?: (args: { failureCount: number }) => number;
	/** A save that takes longer than this is given up and counted as failed. */
	saveTimeoutMs?: number;
	/** flush() rejects instead of waiting longer than this. */
	flushTimeoutMs?: number;
};

const DEFAULT_SAVE_TIMEOUT_MS = 30_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 15_000;

function withTimeout<T>({
	promise,
	timeoutMs,
	message,
}: {
	promise: Promise<T>;
	timeoutMs: number;
	message: string;
}): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class SaveManager {
	private debounceMs: number;
	private reporter: SaveReporter;
	private getRetryDelayMs: (args: { failureCount: number }) => number;
	private saveTimeoutMs: number;
	private flushTimeoutMs: number;
	private isPaused = false;
	// Set by stop(): a stopped manager schedules nothing and ignores the late
	// outcome of a save that was still running (cleared by start()).
	private stopped = false;
	private isSaving = false;
	private hasPendingSave = false;
	// Bumped by every change, so a finished save can tell whether newer edits arrived while it ran.
	private changeCount = 0;
	// Consecutive failed saves: 0 while saving works.
	private failureCount = 0;
	// Bumped by discard(): a save that started before it must not touch the new state.
	private generation = 0;
	private activeSave: Promise<void> | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];

	constructor({
		editor,
		debounceMs = 800,
		reporter = createToastSaveReporter(),
		getRetryDelayMs = getSaveRetryDelayMs,
		saveTimeoutMs = DEFAULT_SAVE_TIMEOUT_MS,
		flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
	}: {
		editor: SaveManagerHost;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
		this.reporter = reporter;
		this.getRetryDelayMs = getRetryDelayMs;
		this.saveTimeoutMs = saveTimeoutMs;
		this.flushTimeoutMs = flushTimeoutMs;
	}

	private editor: SaveManagerHost;

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.stopped = false;
		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		this.stopped = true;
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
		this.clearRetryTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.hasPendingSave = true;
		this.changeCount += 1;
		this.queueSave();
	}

	/**
	 * Saves right now and resolves once the project is stored. Rejects with the
	 * save error when it could not be stored, so callers like "exit project"
	 * can stop instead of dropping unsaved work.
	 */
	async flush(): Promise<void> {
		await withTimeout({
			promise: this.flushNow(),
			timeoutMs: this.flushTimeoutMs,
			message: "Saving took too long.",
		});
	}

	private async flushNow(): Promise<void> {
		// A save that is already running took its snapshot before this call:
		// wait for it, then save whatever is left.
		await this.waitForIdle();
		this.hasPendingSave = true;
		if (this.getSaveBlocker() === "not-ready") {
			throw new Error("The project is still loading, so it could not be saved yet.");
		}
		await this.saveNow();
	}

	/** Resolves once no save is running (whether it worked or not). */
	async waitForIdle(): Promise<void> {
		while (this.activeSave) {
			await this.activeSave.catch(() => {});
		}
	}

	/** Forget unsaved state on purpose, because its project was closed or deleted. */
	discard(): void {
		this.generation += 1;
		this.clearTimer();
		this.clearRetryTimer();
		this.hasPendingSave = false;
		if (this.failureCount > 0) {
			this.failureCount = 0;
			this.reporter.dismissFailure();
		}
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	private queueSave(): void {
		if (this.stopped || this.isSaving) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			this.runScheduledSave();
		}, this.debounceMs);
	}

	private runScheduledSave(): void {
		// Paused means a project is loading, and its scenes are not ready to be
		// saved. resume() brings the pending save back.
		if (this.isPaused) return;
		// A failed save is already reported and retried by saveNow itself.
		this.saveNow().catch(() => {});
	}

	private saveNow(): Promise<void> {
		if (this.isSaving) return Promise.resolve();
		if (!this.hasPendingSave) return Promise.resolve();

		const blocker = this.getSaveBlocker();
		if (blocker === "no-project") {
			// The project was closed or deleted: there is nothing left to save.
			this.hasPendingSave = false;
			return Promise.resolve();
		}
		if (blocker === "not-ready") return Promise.resolve();

		this.isSaving = true;
		this.clearTimer();
		this.clearRetryTimer();

		const save = this.performSave({
			startedAtChange: this.changeCount,
			generation: this.generation,
		}).finally(() => {
			this.activeSave = null;
		});
		this.activeSave = save;
		return save;
	}

	private getSaveBlocker(): "no-project" | "not-ready" | null {
		if (!this.editor.project.getActiveOrNull()) return "no-project";
		if (this.editor.project.getIsLoading()) return "not-ready";
		if (this.editor.project.getMigrationState().isMigrating) return "not-ready";
		return null;
	}

	private async performSave({
		startedAtChange,
		generation,
	}: {
		startedAtChange: number;
		generation: number;
	}): Promise<void> {
		let failure: { error: unknown } | null = null;
		try {
			// A write that never settles must not leave the manager "saving" forever.
			await withTimeout({
				promise: this.editor.project.saveCurrentProject(),
				timeoutMs: this.saveTimeoutMs,
				message: "Saving timed out.",
			});
		} catch (error) {
			failure = { error };
		}
		this.isSaving = false;

		if (generation !== this.generation || this.stopped) {
			// The project was closed or deleted, or the manager was stopped, while
			// the save ran: its outcome no longer counts. A stopped manager must not
			// log, report, retry or save again (a hung save's watchdog fires late).
			if (failure) throw failure.error;
			return;
		}

		if (failure) {
			// The project stays dirty: the unload guard keeps warning and a retry is due.
			this.handleSaveFailure(failure);
			throw failure.error;
		}

		// Only a finished save makes the project clean, and only if nothing
		// changed while it ran.
		if (this.changeCount === startedAtChange) {
			this.hasPendingSave = false;
		}
		this.handleSaveSuccess();
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	private handleSaveFailure({ error }: { error: unknown }): void {
		console.error("Failed to save project:", error);
		this.failureCount += 1;
		this.scheduleRetry();
		// One notice per streak: later failures keep retrying quietly.
		if (this.failureCount === 1) {
			this.reporter.saveFailed({ error });
		}
	}

	private handleSaveSuccess(): void {
		if (this.failureCount === 0) return;
		this.failureCount = 0;
		this.reporter.saveRecovered();
	}

	private scheduleRetry(): void {
		this.clearRetryTimer();
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.runScheduledSave();
		}, this.getRetryDelayMs({ failureCount: this.failureCount }));
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}

	private clearRetryTimer(): void {
		if (!this.retryTimer) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}
}
