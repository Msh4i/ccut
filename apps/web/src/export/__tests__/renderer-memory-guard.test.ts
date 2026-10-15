import { describe, expect, test } from "bun:test";
import {
	ExportMemoryLimitError,
	RENDERER_CEILING_BYTES,
	RENDERER_RELIEF_BYTES,
	createExportMemoryGuard,
	readRendererDataBytes,
} from "../renderer-memory-guard";

// The export stops with a clear message before Chromium's 8 GiB renderer limit would kill the window.

const GiB = 1024 ** 3;

function guardWith({ bytes }: { bytes: Array<number | null> | Error }) {
	const calls = { reads: 0, relieved: 0 };
	const guard = createExportMemoryGuard({
		read: async () => {
			const answer = bytes instanceof Error ? bytes : (bytes[Math.min(calls.reads, bytes.length - 1)] ?? null);
			calls.reads += 1;
			if (answer instanceof Error) throw answer;
			return answer;
		},
		relieve: () => {
			calls.relieved += 1;
		},
	});
	const at = (index: number) => guard({ index, frameCount: 1000, seconds: index / 30, totalSeconds: 33.3 });
	return { at, calls };
}

describe("createExportMemoryGuard", () => {
	test("stops the export at the ceiling with a memory-limit message, before the limit", async () => {
		const { at } = guardWith({ bytes: [6.2 * GiB] });
		const failure = await at(600).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ExportMemoryLimitError);
		const message = failure instanceof Error ? failure.message : "";
		expect(message).toContain("memory limit");
		expect(message).toContain("20.0 s of 33.3 s");
		expect(RENDERER_CEILING_BYTES).toBeLessThan(8 * GiB);
	});

	test("gives memory back from the relief line on, keeps going below the ceiling", async () => {
		const { at, calls } = guardWith({ bytes: [2 * GiB, RENDERER_RELIEF_BYTES + 1, 5.9 * GiB] });
		await at(0);
		await at(10);
		await at(20);
		expect(calls.relieved).toBe(2);
	});

	test("reads only every few frames, and a missing or failing reading never stops an export", async () => {
		const { at, calls } = guardWith({ bytes: [9 * GiB] });
		await at(3);
		expect(calls.reads).toBe(0);
		await expect(guardWith({ bytes: [null] }).at(0)).resolves.toBeUndefined();
		await expect(guardWith({ bytes: new Error("bridge gone") }).at(0)).resolves.toBeUndefined();
	});
});

describe("readRendererDataBytes", () => {
	const hostWith = (answer: unknown) => ({ ccutSystem: { memoryInfo: async () => answer } });

	test("takes only a finite non-negative number from the desktop bridge", async () => {
		expect(await readRendererDataBytes({ host: hostWith({ rendererDataBytes: 123 }) })).toBe(123);
		for (const bad of [{ rendererDataBytes: "1" }, { rendererDataBytes: -1 }, { rendererDataBytes: Number.NaN }, {}, null]) {
			expect(await readRendererDataBytes({ host: hostWith(bad) })).toBeNull();
		}
		expect(await readRendererDataBytes({ host: {} })).toBeNull();
		expect(await readRendererDataBytes({ host: null })).toBeNull();
	});
});
