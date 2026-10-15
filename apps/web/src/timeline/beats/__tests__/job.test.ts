import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { UploadAudioElement } from "@/timeline";
import {
	runBeatJob,
	type BeatJobStatus,
	type SourceAnalysis,
} from "@/timeline/beats/job";
import type { BeatTarget } from "@/timeline/beats/targets";
import { mediaTime } from "@/wasm";

function target({
	id,
	sourceKey,
}: {
	id: string;
	sourceKey: string;
}): BeatTarget {
	const element: UploadAudioElement = {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId: sourceKey,
		name: id,
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
	const mediaAsset: MediaAsset | null = null;
	return { trackId: `track-${id}`, element, mediaAsset, sourceKey };
}

const found = (count: number): SourceAnalysis => ({
	ok: true,
	beats: Array.from({ length: count }, (_, i) => mediaTime({ ticks: i * 1000 })),
	bpm: 120,
});

type Update = { trackId: string; elementId: string; beats: readonly number[] };

function harness({
	analyse,
	isCurrent = () => true,
	exists = () => true,
	signal = new AbortController().signal,
}: {
	analyse: Parameters<typeof runBeatJob>[0]["analyse"];
	isCurrent?: () => boolean;
	exists?: (clip: { trackId: string; elementId: string }) => boolean;
	signal?: AbortSignal;
}) {
	const statuses: BeatJobStatus[] = [];
	const commits: Update[][] = [];
	const run = (targets: BeatTarget[]) =>
		runBeatJob({
			targets,
			signal,
			analyse,
			onStatus: (status) => statuses.push(status),
			isCurrent,
			exists,
			commit: (updates) => commits.push(updates),
		});
	return { run, statuses, commits };
}

describe("runBeatJob", () => {
	test("analyses each source once and commits every clip in one go", async () => {
		const analysed: string[] = [];
		const { run, commits } = harness({
			analyse: async ({ target }) => {
				analysed.push(target.sourceKey);
				return found(4);
			},
		});

		const result = await run([
			target({ id: "a", sourceKey: "s1" }),
			target({ id: "b", sourceKey: "s1" }),
			target({ id: "c", sourceKey: "s2" }),
		]);

		expect(analysed).toEqual(["s1", "s2"]);
		expect(commits.length).toBe(1);
		expect(commits[0].map((update) => [update.trackId, update.elementId])).toEqual([
			["track-a", "a"],
			["track-b", "b"],
			["track-c", "c"],
		]);
		expect(result).toEqual({
			kind: "done",
			summary: { type: "success", message: "Found beats in 3 clips" },
		});
	});

	test("one source reports its beat count and tempo", async () => {
		const { run } = harness({ analyse: async () => found(478) });
		expect(await run([target({ id: "a", sourceKey: "s1" })])).toEqual({
			kind: "done",
			summary: { type: "success", message: "Found 478 beats (≈120 BPM)" },
		});
	});

	test("a hits analysis has no tempo and the summary says hits", async () => {
		const { run, commits } = harness({
			analyse: async () => ({
				ok: true,
				beats: [mediaTime({ ticks: 1000 }), mediaTime({ ticks: 2500 })],
			}),
		});
		expect(await run([target({ id: "a", sourceKey: "s1" })])).toEqual({
			kind: "done",
			summary: { type: "success", message: "Found 2 hits" },
		});
		expect(commits).toHaveLength(1);
	});

	test("reports reading, then deduplicated detecting percentages, per source", async () => {
		const { run, statuses } = harness({
			analyse: async ({ onProgress }) => {
				for (const fraction of [0, 0.004, 0.02, 0.021, 0.5]) onProgress(fraction);
				return found(2);
			},
		});
		await run([target({ id: "a", sourceKey: "s1" }), target({ id: "b", sourceKey: "s2" })]);
		expect(statuses).toEqual([
			{ phase: "reading", source: 1, sources: 2 },
			{ phase: "detecting", source: 1, sources: 2, percent: 0 },
			{ phase: "detecting", source: 1, sources: 2, percent: 2 },
			{ phase: "detecting", source: 1, sources: 2, percent: 50 },
			{ phase: "reading", source: 2, sources: 2 },
			{ phase: "detecting", source: 2, sources: 2, percent: 0 },
			{ phase: "detecting", source: 2, sources: 2, percent: 2 },
			{ phase: "detecting", source: 2, sources: 2, percent: 50 },
		]);
	});

	test("an already aborted signal does nothing at all", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const { run, commits, statuses } = harness({
			signal: controller.signal,
			analyse: async () => {
				called = true;
				return found(2);
			},
		});
		expect(await run([target({ id: "a", sourceKey: "s1" })])).toEqual({ kind: "cancelled" });
		expect(called).toBe(false);
		expect(commits).toEqual([]);
		expect(statuses).toEqual([]);
	});

	test("cancel returns at once even though the decode cannot be interrupted", async () => {
		const controller = new AbortController();
		const { run, commits } = harness({
			signal: controller.signal,
			analyse: () => new Promise<SourceAnalysis>(() => {}),
		});
		const pending = run([target({ id: "a", sourceKey: "s1" })]);
		controller.abort();
		expect(await pending).toEqual({ kind: "cancelled" });
		expect(commits).toEqual([]);
	});

	test("a cancelled run never starts the next source nor commits", async () => {
		const controller = new AbortController();
		const analysed: string[] = [];
		const { run, commits } = harness({
			signal: controller.signal,
			analyse: async ({ target }) => {
				analysed.push(target.sourceKey);
				if (target.sourceKey === "s1") controller.abort();
				return found(3);
			},
		});
		const result = await run([
			target({ id: "a", sourceKey: "s1" }),
			target({ id: "b", sourceKey: "s2" }),
		]);
		expect(result).toEqual({ kind: "cancelled" });
		expect(analysed).toEqual(["s1"]);
		expect(commits).toEqual([]);
	});

	test("a cancel that lands just before the commit still commits nothing", async () => {
		const controller = new AbortController();
		const { run, commits } = harness({
			signal: controller.signal,
			analyse: async () => found(3),
			isCurrent: () => {
				controller.abort();
				return true;
			},
		});
		expect(await run([target({ id: "a", sourceKey: "s1" })])).toEqual({ kind: "cancelled" });
		expect(commits).toEqual([]);
	});

	test("progress that arrives after the cancel is not reported", async () => {
		const controller = new AbortController();
		const { run, statuses } = harness({
			signal: controller.signal,
			analyse: async ({ onProgress }) => {
				controller.abort();
				onProgress(0.5);
				return found(2);
			},
		});
		await run([target({ id: "a", sourceKey: "s1" })]);
		expect(statuses.every((status) => status.phase === "reading")).toBe(true);
	});

	test("commits nothing when the project changed while it ran", async () => {
		const { run, commits } = harness({
			analyse: async () => found(3),
			isCurrent: () => false,
		});
		expect(await run([target({ id: "a", sourceKey: "s1" })])).toEqual({ kind: "stale" });
		expect(commits).toEqual([]);
	});

	test("a clip deleted or moved during the analysis gets nothing and is not counted", async () => {
		const asked: string[] = [];
		const { run, commits } = harness({
			analyse: async () => found(8),
			exists: ({ trackId, elementId }) => {
				asked.push(`${trackId}/${elementId}`);
				return elementId !== "b";
			},
		});
		const result = await run([
			target({ id: "a", sourceKey: "s1" }),
			target({ id: "b", sourceKey: "s1" }),
			target({ id: "c", sourceKey: "s2" }),
		]);
		expect(asked).toEqual(["track-a/a", "track-b/b", "track-c/c"]);
		expect(commits.length).toBe(1);
		expect(commits[0].map((update) => update.elementId)).toEqual(["a", "c"]);
		expect(result).toEqual({
			kind: "done",
			summary: { type: "success", message: "Found beats in 2 clips" },
		});
	});

	test("when the only analysed clip is gone nothing is committed and nothing is announced", async () => {
		const { run, commits } = harness({
			analyse: async () => found(8),
			exists: () => false,
		});
		expect(await run([target({ id: "a", sourceKey: "s1" })])).toEqual({ kind: "stale" });
		expect(commits).toEqual([]);
	});

	test("a source whose clips are all gone drops out of the summary", async () => {
		const { run, commits } = harness({
			analyse: async ({ target }) =>
				target.sourceKey === "s1" ? found(100) : { ok: false, reason: "no-beat" },
			exists: ({ elementId }) => elementId !== "b",
		});
		const result = await run([
			target({ id: "a", sourceKey: "s1" }),
			target({ id: "b", sourceKey: "s2" }),
		]);
		expect(commits[0].map((update) => update.elementId)).toEqual(["a"]);
		// s2 failed, but its clip is gone, so only s1 is reported.
		expect(result).toEqual({
			kind: "done",
			summary: { type: "success", message: "Found 100 beats (≈120 BPM)" },
		});
	});

	test("a source that fails is reported while the others still get their beats", async () => {
		const { run, commits } = harness({
			analyse: async ({ target }) =>
				target.sourceKey === "bad" ? { ok: false, reason: "no-beat" } : found(5),
		});
		const result = await run([
			target({ id: "a", sourceKey: "good" }),
			target({ id: "b", sourceKey: "bad" }),
		]);
		expect(commits.length).toBe(1);
		expect(commits[0].map((update) => update.elementId)).toEqual(["a"]);
		expect(result).toEqual({
			kind: "done",
			summary: { type: "warning", message: "Found beats in 1 of 2 clips" },
		});
	});

	test("an unexpected crash while analysing one source counts as a failed source", async () => {
		const { run, commits } = harness({
			analyse: async ({ target }) => {
				if (target.sourceKey === "boom") throw new Error("worker exploded");
				return found(5);
			},
		});
		const result = await run([
			target({ id: "a", sourceKey: "boom" }),
			target({ id: "b", sourceKey: "fine" }),
		]);
		expect(commits[0].map((update) => update.elementId)).toEqual(["b"]);
		expect(result).toEqual({
			kind: "done",
			summary: { type: "warning", message: "Found beats in 1 of 2 clips" },
		});
	});

	test("when everything fails nothing is committed and the reason is reported", async () => {
		const { run, commits } = harness({
			analyse: async () => ({ ok: false, reason: "silent" }),
		});
		expect(await run([target({ id: "a", sourceKey: "s1" })])).toEqual({
			kind: "done",
			summary: { type: "error", message: "No audio signal" },
		});
		expect(commits).toEqual([]);
	});

	test("a crash only in the analysis says the detection failed", async () => {
		const { run } = harness({
			analyse: async () => {
				throw new Error("boom");
			},
		});
		expect(await run([target({ id: "a", sourceKey: "s1" })])).toEqual({
			kind: "done",
			summary: { type: "error", message: "Beat detection failed" },
		});
	});

	test("a failure while committing is not swallowed", async () => {
		const run = () =>
			runBeatJob({
				targets: [target({ id: "a", sourceKey: "s1" })],
				signal: new AbortController().signal,
				analyse: async () => found(3),
				onStatus: () => {},
				isCurrent: () => true,
				exists: () => true,
				commit: () => {
					throw new Error("store exploded");
				},
			});
		await expect(run()).rejects.toThrow("store exploded");
	});
});
