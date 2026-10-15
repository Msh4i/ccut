import { describe, expect, test } from "bun:test";
import type { StemsBridge } from "../bridge";
import { separateStems, type SeparationInput } from "../separate";
import { STEM_CHUNK_BYTES, STEM_NAMES, type StemJobStatus } from "../types";

type Log = { calls: string[]; written: Array<{ position: number; bytes: number; backing: number }> };

function fakeBridge({
	statuses,
	begin = { ok: true, token: "ab".repeat(16) } as Awaited<ReturnType<StemsBridge["begin"]>>,
	run = true,
}: {
	statuses: StemJobStatus[];
	begin?: Awaited<ReturnType<StemsBridge["begin"]>>;
	run?: boolean;
}): { bridge: StemsBridge; log: Log } {
	const log: Log = { calls: [], written: [] };
	let polled = 0;
	const unused = async () => {
		throw new Error("not used");
	};
	const bridge: StemsBridge = {
		status: unused,
		install: unused,
		cancelInstall: unused,
		removeEngine: unused,
		begin: async () => {
			log.calls.push("begin");
			return begin;
		},
		write: async ({ position, data }) => {
			log.calls.push("write");
			log.written.push({ position, bytes: data.byteLength, backing: data.buffer.byteLength });
		},
		run: async () => {
			log.calls.push("run");
			return run;
		},
		jobStatus: async () => {
			log.calls.push("jobStatus");
			return statuses[Math.min(polled++, statuses.length - 1)];
		},
		read: async ({ stem, length }) => {
			log.calls.push(`read:${stem}`);
			// Int16 little endian: the stem's index in every sample.
			const bytes = new Uint8Array(length);
			for (let i = 0; i < length; i += 2) bytes[i] = STEM_NAMES.indexOf(stem) + 1;
			return bytes;
		},
		cancel: async () => {
			log.calls.push("cancel");
			return true;
		},
		release: async () => {
			log.calls.push("release");
			return true;
		},
	};
	return { bridge, log };
}

const input = (frames: number): SeparationInput => ({
	samples: new Int16Array(frames * 2),
	sampleRate: 44100,
	frames,
});

describe("separateStems", () => {
	test("sends the audio in order, waits for the job, reads every stem and always releases", async () => {
		const { bridge, log } = fakeBridge({
			statuses: [
				{ state: "running", percent: 10 },
				{ state: "running", percent: 60 },
				{ state: "done", percent: 100, samples: 6 },
			],
		});
		const fractions: number[] = [];
		const result = await separateStems({
			bridge,
			input: input(1000),
			signal: new AbortController().signal,
			onProgress: (fraction) => fractions.push(fraction),
			pollMs: 1,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The fake writes the stem's position in STEM_NAMES + 1 into every sample.
		expect(result.stems.drums).toEqual(new Int16Array(6).fill(1));
		expect(result.stems.bass).toEqual(new Int16Array(6).fill(2));
		expect(result.stems.vocals).toEqual(new Int16Array(6).fill(3));
		expect(result.stems.other).toEqual(new Int16Array(6).fill(4));
		expect(log.written).toEqual([{ position: 0, bytes: 4000, backing: 4000 }]);
		expect(log.calls[0]).toBe("begin");
		expect(log.calls.at(-1)).toBe("release");
		expect(log.calls.filter((c) => c.startsWith("read:")).length).toBe(4);
		// Progress only goes forward and ends at 1.
		expect(fractions.every((value, i) => i === 0 || value >= fractions[i - 1])).toBe(true);
		expect(fractions.at(-1)).toBeCloseTo(1, 5);
	});

	test("a long clip is sent in whole-frame chunks, position by position", async () => {
		const frames = Math.ceil((STEM_CHUNK_BYTES * 2.5) / 4);
		const { bridge, log } = fakeBridge({ statuses: [{ state: "done", percent: 100, samples: 2 }] });
		await separateStems({ bridge, input: input(frames), signal: new AbortController().signal, pollMs: 1 });
		expect(log.written.length).toBe(3);
		let expected = 0;
		for (const part of log.written) {
			expect(part.position).toBe(expected);
			expect(part.bytes % 4).toBe(0);
			expect(part.bytes).toBeLessThanOrEqual(STEM_CHUNK_BYTES);
			// A copy of its own: the bridge would send a view's whole backing buffer.
			expect(part.backing).toBe(part.bytes);
			expected += part.bytes;
		}
		expect(expected).toBe(frames * 4);
	});

	test("the codes of begin and of a failed job become reasons, and the job is released", async () => {
		for (const [code, reason] of [
			["too-long", "too-long"],
			["busy", "busy"],
			["engine-missing", "engine-missing"],
			["invalid", "separation-failed"],
		] as const) {
			const { bridge, log } = fakeBridge({ statuses: [], begin: { ok: false, code } });
			const result = await separateStems({ bridge, input: input(10), signal: new AbortController().signal, pollMs: 1 });
			expect(result).toEqual({ ok: false, reason });
			// No job exists, so nothing to release.
			expect(log.calls).toEqual(["begin"]);
		}
		const failed = fakeBridge({ statuses: [{ state: "failed", percent: 40, code: "timeout" }] });
		expect(await separateStems({ bridge: failed.bridge, input: input(10), signal: new AbortController().signal, pollMs: 1 })).toEqual({ ok: false, reason: "timeout" });
		expect(failed.log.calls.at(-1)).toBe("release");
		const refused = fakeBridge({ statuses: [], run: false });
		expect(await separateStems({ bridge: refused.bridge, input: input(10), signal: new AbortController().signal, pollMs: 1 })).toEqual({ ok: false, reason: "separation-failed" });
		expect(refused.log.calls.at(-1)).toBe("release");
	});

	test("aborting while the job runs cancels it, releases it and rejects with an AbortError", async () => {
		const controller = new AbortController();
		const { bridge, log } = fakeBridge({ statuses: [{ state: "running", percent: 20 }] });
		const pending = separateStems({ bridge, input: input(10), signal: controller.signal, pollMs: 5 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(log.calls).toContain("cancel");
		expect(log.calls.at(-1)).toBe("release");
		expect(log.calls.filter((c) => c.startsWith("read:")).length).toBe(0);
	});
});
