import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ExportResult, ExportState } from "@/export";
import { ProjectManager } from "@/core/managers/project-manager";
import type { ConfirmUnreadableAudio, ExportPhaseUpdate } from "@/core/managers/renderer-manager";

// ProjectManager's export state, with a scripted renderer: the phases, frame
// counter and progress the window shows, the unreadable-audio question, cancel,
// and "Show in folder".

const paused: string[] = [];

type RunArgs = {
	signal?: AbortSignal;
	onPhase?: (update: ExportPhaseUpdate) => void;
	confirmUnreadableAudio?: ConfirmUnreadableAudio;
};

function managerWith({ run }: { run: (args: RunArgs) => Promise<ExportResult> }) {
	// Object.create returns any: the fake only has what export() reads.
	const editor = Object.assign(Object.create(null), {
		scenes: { getScenes: () => [] },
		playback: { pause: () => paused.push("pause") },
		renderer: { exportProject: (args: RunArgs) => run(args) },
	});
	const manager = new ProjectManager(editor);
	const states: ExportState[] = [];
	manager.subscribe(() => states.push(manager.getExportState()));
	return { manager, states };
}

const options = { format: "mp4" as const, quality: "high" as const, includeAudio: true };

/** A promise and the function that settles it, to hold a scripted export at a chosen point. */
function gate() {
	let open: () => void = () => {};
	const passed = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { passed, open };
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, "ccutExport");
});

describe("ProjectManager.export, job state", () => {
	test("playback is paused before the export starts (no audio and no decoding under it)", async () => {
		paused.length = 0;
		const order: string[] = [];
		const { manager } = managerWith({
			run: async () => {
				order.push(`run after ${paused.length} pause`);
				return { success: true, file: { displayName: "a.mp4", bytes: 10, revealToken: "t" } };
			},
		});
		await manager.export({ options });
		expect(order).toEqual(["run after 1 pause"]);
	});

	test("preparing, encoding with a frame counter and progress, finalizing, then the result; never closable meanwhile", async () => {
		const { manager, states } = managerWith({
			run: async ({ onPhase }) => {
				onPhase?.({ phase: "preparing" });
				onPhase?.({ phase: "encoding", framesDone: 1, frameCount: 4 });
				onPhase?.({ phase: "encoding", framesDone: 4, frameCount: 4 });
				onPhase?.({ phase: "finalizing" });
				return { success: true, file: { displayName: "a.mp4", bytes: 10, revealToken: "t" } };
			},
		});

		const result = await manager.export({ options });

		expect(result.success).toBe(true);
		expect(states.map((state) => [state.isExporting, state.phase, state.framesDone, state.progress])).toEqual([
			[true, null, 0, 0],
			[true, "preparing", 0, 0],
			[true, "encoding", 1, 0.25],
			[true, "encoding", 4, 1],
			[true, "finalizing", 4, 1],
			[false, null, 0, 1],
		]);
		expect(manager.getExportState().result).toBe(result);
	});

	test("time left: the estimate reaches the state (and the idle state has none)", async () => {
		let clock = 0;
		const now = spyOn(performance, "now").mockImplementation(() => clock);
		try {
			const { manager, states } = managerWith({
				run: async ({ onPhase }) => {
					onPhase?.({ phase: "preparing" });
					for (const [framesDone, at] of [[0, 0], [100, 1000], [200, 2000], [300, 3000]] as const) {
						clock = at;
						onPhase?.({ phase: "encoding", framesDone, frameCount: 300 });
					}
					return { success: true, file: { displayName: "a.mp4", bytes: 10, revealToken: "t" } };
				},
			});
			await manager.export({ options });
			// 2 s and 100 frames per second in: 100 frames left at 100 per second.
			expect(states.filter((state) => state.phase === "encoding").map((state) => state.etaSeconds)).toEqual([null, null, 1, 0]);
			expect(states.at(-1)?.etaSeconds).toBeNull();
		} finally {
			now.mockRestore();
		}
	});

	test("cancel aborts the renderer's signal", async () => {
		let seen: AbortSignal | undefined;
		const { manager } = managerWith({
			run: async ({ signal }) => {
				seen = signal;
				manager.cancelExport();
				return { success: false, cancelled: true };
			},
		});
		await manager.export({ options });
		expect(seen?.aborted).toBe(true);
	});

	test("Cancel marks the state as cancelling at once (the button changes while a step that cannot be interrupted runs), once", async () => {
		const release = gate();
		let seen: AbortSignal | undefined;
		const { manager, states } = managerWith({
			run: async ({ signal, onPhase }) => {
				seen = signal;
				onPhase?.({ phase: "preparing" });
				await release.passed; // the audio mix, say
				return { success: false, cancelled: true };
			},
		});
		const running = manager.export({ options });
		await Promise.resolve();
		expect(manager.getExportState().cancelling).toBe(false);
		manager.cancelExport();
		expect(manager.getExportState()).toMatchObject({ isExporting: true, cancelling: true, phase: "preparing" });
		expect(seen?.aborted).toBe(true);
		const notified = states.length;
		manager.cancelExport(); // a second click does nothing more
		expect(states.length).toBe(notified);
		release.open();
		await running;
		expect(manager.getExportState()).toMatchObject({ isExporting: false, cancelling: false });
	});

	test("a Cancel with no export running, or while the file is being finished, does nothing (finalizing cannot be stopped)", async () => {
		const { manager: idle, states: idleStates } = managerWith({ run: async () => ({ success: false, cancelled: true }) });
		idle.cancelExport();
		expect(idleStates).toEqual([]);

		let signalSeen: AbortSignal | undefined;
		const { manager } = managerWith({
			run: async ({ signal, onPhase }) => {
				signalSeen = signal;
				onPhase?.({ phase: "finalizing" });
				manager.cancelExport();
				expect(manager.getExportState().cancelling).toBe(false);
				return { success: true, file: { displayName: "a.mp4", bytes: 10, revealToken: "t" } };
			},
		});
		const result = await manager.export({ options });
		expect(signalSeen?.aborted).toBe(false);
		expect(result.success).toBe(true);
	});

	test("the unreadable-audio question waits in the state for an answer", async () => {
		const answers: boolean[] = [];
		const { manager, states } = managerWith({
			run: async ({ confirmUnreadableAudio }) => {
				const pending = confirmUnreadableAudio?.({ skipped: [{ name: "x.mp3", reason: "bad" }], allUnreadable: false });
				expect(manager.getExportState().audioQuestion).toEqual({ skipped: [{ name: "x.mp3", reason: "bad" }], allUnreadable: false });
				manager.answerUnreadableAudio({ exportAnyway: true });
				answers.push((await pending) ?? false);
				return { success: false, cancelled: true };
			},
		});
		await manager.export({ options });
		expect(answers).toEqual([true]);
		expect(states.at(-1)?.audioQuestion).toBeNull();
	});

	test("Cancel while the question is open answers it with 'no'", async () => {
		const answers: boolean[] = [];
		const { manager } = managerWith({
			run: async ({ confirmUnreadableAudio }) => {
				const pending = confirmUnreadableAudio?.({ skipped: [], allUnreadable: true });
				manager.cancelExport();
				answers.push((await pending) ?? true);
				return { success: false, cancelled: true };
			},
		});
		await manager.export({ options });
		expect(answers).toEqual([false]);
		expect(manager.getExportState().audioQuestion).toBeNull();
	});

	test("an exportProject that throws ends the export: the flag drops, the error is the result, the next export works", async () => {
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			let runs = 0;
			const { manager, states } = managerWith({
				run: async () => {
					if (runs++ === 0) throw new Error("renderer blew up");
					return { success: true, file: { displayName: "a.mp4", bytes: 10, revealToken: "t" } };
				},
			});
			const failed = await manager.export({ options });
			expect(failed).toEqual({ success: false, error: "renderer blew up" });
			expect(manager.getExportState()).toMatchObject({ isExporting: false, phase: null, cancelling: false, audioQuestion: null, result: failed });
			expect(states.at(-1)?.isExporting).toBe(false);
			// Not a string, not an Error: still ends, with a plain message.
			const second = managerWith({ run: async () => Promise.reject("not an error") }).manager;
			expect(await second.export({ options })).toEqual({ success: false, error: "Unknown export error" });
			expect(second.getExportState().isExporting).toBe(false);
			expect((await manager.export({ options })).success).toBe(true);
		} finally {
			logged.mockRestore();
		}
	});

	test("an export that throws while the unreadable-audio question is open leaves no question and no answer handler behind", async () => {
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const { manager } = managerWith({
				run: async ({ confirmUnreadableAudio }) => {
					void confirmUnreadableAudio?.({ skipped: [{ name: "x.mp3", reason: "bad" }], allUnreadable: false });
					throw new Error("renderer blew up");
				},
			});
			await manager.export({ options });
			expect(manager.getExportState().audioQuestion).toBeNull();
			const before = manager.getExportState();
			manager.answerUnreadableAudio({ exportAnyway: true }); // nobody is waiting any more
			expect(manager.getExportState()).toBe(before);
		} finally {
			logged.mockRestore();
		}
	});

	test("clearExportState while an export runs changes nothing (the window must not reset a live export); after it ends it clears the result", async () => {
		const { manager } = managerWith({
			run: async ({ onPhase }) => {
				onPhase?.({ phase: "encoding", framesDone: 3, frameCount: 10 });
				const before = manager.getExportState();
				manager.clearExportState();
				expect(manager.getExportState()).toBe(before);
				expect(manager.getExportState()).toMatchObject({ isExporting: true, phase: "encoding", framesDone: 3 });
				return { success: false, error: "disk full" };
			},
		});
		await manager.export({ options });
		expect(manager.getExportState().result?.error).toBe("disk full");
		manager.clearExportState();
		expect(manager.getExportState().result).toBeNull();
	});

	test("an older export that ends after a newer one began neither detaches the newer one's Cancel nor resets its state", async () => {
		const gates = [gate(), gate()];
		const signals: AbortSignal[] = [];
		let runs = 0;
		const { manager } = managerWith({
			run: async ({ signal }) => {
				const index = runs++;
				if (signal) signals.push(signal);
				await gates[index].passed;
				return { success: false, cancelled: true };
			},
		});
		const first = manager.export({ options });
		const second = manager.export({ options });
		await Promise.resolve();
		gates[0].open();
		await first;
		expect(manager.getExportState().isExporting).toBe(true); // the second is still running
		manager.cancelExport();
		expect(signals.map((signal) => signal.aborted)).toEqual([false, true]);
		gates[1].open();
		await second;
		expect(manager.getExportState().isExporting).toBe(false);
	});

	test("Show in folder: the bridge gets the finished export's token; nothing without a file or a bridge", async () => {
		const revealed: string[] = [];
		const { manager } = managerWith({
			run: async () => ({ success: true, file: { displayName: "a.mp4", bytes: 10, revealToken: "tok-1" } }),
		});
		expect(await manager.revealExportedFile()).toBe(false);
		await manager.export({ options });
		expect(await manager.revealExportedFile()).toBe(false); // no bridge in bun
		Reflect.set(globalThis, "ccutExport", {
			begin: async () => ({ ok: false, reason: "cancelled" }),
			write: async () => {},
			finish: async () => ({ displayName: "", bytes: 0 }),
			abort: async () => {},
			reveal: async ({ token }: { token: string }) => {
				revealed.push(token);
				return true;
			},
		});
		expect(await manager.revealExportedFile()).toBe(true);
		expect(revealed).toEqual(["tok-1"]);
	});
});
