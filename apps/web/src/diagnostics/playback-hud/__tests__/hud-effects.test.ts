import { describe, expect, spyOn, test } from "bun:test";
import { playbackHud } from "../recorder";
import {
	PlaybackSession,
	type HudCacheCounters,
	type HudProbe,
	effectPassesOfFrame,
	formatGpuErrors,
	formatRow,
	formatSummary,
	frameSampleFromProbes,
} from "../session";

// The playback HUD shows how many effect passes each draw ran (each one is a
// full-frame shader run: the cost of a blur) and which render error the
// preview hit last. There is no measured effect time to show: the compositor
// has no GPU timer, and the wasm spans are whole-frame CPU times.

const NO_CACHE: HudCacheCounters = {
	hits: 0,
	readAheadHits: 0,
	advances: 0,
	restarts: 0,
	stalePresents: 0,
	draws: 0,
	skipped: 0,
	errors: 0,
	waitMs: 0,
};

function probe(atMs: number): HudProbe {
	return { atMs, cache: NO_CACHE, uploads: { uploads: 0, uploadedPixels: 0 } };
}

function pass() {
	return { shader: "gaussian-blur", uniforms: {} };
}

describe("the recorder", () => {
	test("its dump names the last render error, also before any playback", () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(playbackHud.dump()).toContain("last render error: none");
			playbackHud.recordRenderError({ message: "Invalid frame descriptor", nowMs: 5 });
			playbackHud.recordRenderError({ message: "Invalid frame descriptor", nowMs: 6 });
			const text = playbackHud.dump();
			expect(text).toContain("last render error: Invalid frame descriptor");
			expect(text.match(/last render error/g)).toHaveLength(1);
		} finally {
			log.mockRestore();
		}
	});
});

describe("the GPU error count", () => {
	test("formatGpuErrors: none, some with the last message, or not reported by this wasm build", () => {
		expect(formatGpuErrors({ count: 0, lastMessage: null })).toBe("gpu errors: 0");
		expect(formatGpuErrors({ count: 3, lastMessage: "Validation Error: bad bind group" })).toBe(
			"gpu errors: 3 (last: Validation Error: bad bind group)",
		);
		expect(formatGpuErrors(null)).toBe(
			"gpu errors: not reported (this wasm build has no getGpuErrorStats)",
		);
	});

	test("the recorder's dump shows the latest count", () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			playbackHud.recordGpuErrorStats({ count: 1, lastMessage: "a" });
			playbackHud.recordGpuErrorStats({ count: 2, lastMessage: "b" });
			const text = playbackHud.dump();
			expect(text).toContain("gpu errors: 2 (last: b)");
			expect(text.match(/gpu errors/g)).toHaveLength(1);
		} finally {
			log.mockRestore();
		}
	});

	test("the summary carries it", () => {
		const text = formatSummary({
			session: new PlaybackSession({ startMs: 0 }),
			nowMs: 1000,
			lastRenderError: null,
			gpuErrors: { count: 4, lastMessage: "x" },
		});
		expect(text).toContain("gpu errors: 4 (last: x)");
	});
});

describe("effectPassesOfFrame", () => {
	test("sums the passes of every group of every item, scene effects included", () => {
		expect(
			effectPassesOfFrame({
				items: [
					{ effectPassGroups: [[pass(), pass()], [pass()]] },
					{ effectPassGroups: [] },
					{ effectPassGroups: [[pass(), pass(), pass(), pass()]] },
				],
			}),
		).toBe(7);
	});

	test("no frame drawn yet: 0", () => {
		expect(effectPassesOfFrame(null)).toBe(0);
	});
});

describe("effect passes and render errors per bucket", () => {
	function session() {
		const playback = new PlaybackSession({ startMs: 0 });
		for (const [atMs, effectPasses] of [
			[100, 2],
			[200, 2],
			[300, 16],
			[1100, 0],
		]) {
			playback.addFrame(
				frameSampleFromProbes({ before: probe(atMs - 10), after: probe(atMs), effectPasses }),
			);
		}
		playback.addRenderError({ atMs: 250 });
		playback.addRenderError({ atMs: 260 });
		playback.addRenderError({ atMs: 1500 });
		return playback;
	}

	test("each draw's sample carries its pass count", () => {
		const sample = frameSampleFromProbes({ before: probe(0), after: probe(5), effectPasses: 4 });
		expect(sample.effectPasses).toBe(4);
	});

	test("a row has the median and the most passes of a draw, and the failed draws", () => {
		const [first, second] = session().rows({ bucketSeconds: 1, nowMs: 2000 });
		expect([first.effectPassesP50, first.effectPassesMax, first.renderErrors]).toEqual([2, 16, 2]);
		expect([second.effectPassesP50, second.effectPassesMax, second.renderErrors]).toEqual([0, 0, 1]);
	});

	test("a bucket without draws has no pass numbers", () => {
		const rows = new PlaybackSession({ startMs: 0 }).rows({ bucketSeconds: 1, nowMs: 1000 });
		expect([rows[0].effectPassesP50, rows[0].effectPassesMax, rows[0].renderErrors]).toEqual([
			null,
			null,
			0,
		]);
	});

	test("the row text shows them", () => {
		const [first] = session().rows({ bucketSeconds: 1, nowMs: 2000 });
		const text = formatRow(first);
		expect(text).toContain("fx passes 2/16");
		expect(text).toContain("render errors 2");
	});

	test("the dump names the last render error, says when there is none, and that effect time is not measured", () => {
		const withError = formatSummary({
			session: session(),
			nowMs: 2000,
			lastRenderError: "Failed to apply effects: At least one effect pass is required",
			gpuErrors: null,
		});
		expect(withError).toContain(
			"last render error: Failed to apply effects: At least one effect pass is required",
		);
		expect(withError).toContain("effect time is not measured");
		expect(
			formatSummary({ session: session(), nowMs: 2000, lastRenderError: null, gpuErrors: null }),
		).toContain("last render error: none");
	});
});

describe("what goes wrong under the picture is on the row", () => {
	// The cache counted decoder errors, and the compositor counted layer
	// pictures it kept (their canvas had been freed), but no row showed either:
	// a clip that vanished or froze looked like a clean run.
	test("decoder errors and pictures kept from an earlier frame are on the row", () => {
		const playback = new PlaybackSession({ startMs: 0 });
		playback.addFrame(
			frameSampleFromProbes({
				before: probe(90),
				after: {
					atMs: 100,
					cache: { ...NO_CACHE, errors: 3 },
					uploads: { uploads: 0, uploadedPixels: 0, skippedResized: 2 },
				},
				effectPasses: 0,
			}),
		);
		const text = formatRow(playback.rows({ bucketSeconds: 1, nowMs: 1000 })[0]);
		expect(text).toContain("decoder errors 3");
		expect(text).toContain("kept stale pictures 2");
	});

	test("a clean run says 0, not nothing", () => {
		const playback = new PlaybackSession({ startMs: 0 });
		playback.addFrame(frameSampleFromProbes({ before: probe(90), after: probe(100), effectPasses: 0 }));
		const text = formatRow(playback.rows({ bucketSeconds: 1, nowMs: 1000 })[0]);
		expect(text).toContain("decoder errors 0");
		expect(text).toContain("kept stale pictures 0");
	});
});
