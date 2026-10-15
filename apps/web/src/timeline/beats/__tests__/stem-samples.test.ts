import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { StemsBridge } from "@/services/stems/bridge";
import type { StemCache } from "@/services/stems/cache";
import type { StemSet, StemsStatus } from "@/services/stems/types";
import type { UploadAudioElement } from "@/timeline";
import { mediaTime } from "@/wasm";
import {
	getStemAudio,
	stemCacheKey,
	stemToFloat,
	type StemDeps,
	type StemStage,
} from "../stem-samples";
import type { BeatTarget } from "../targets";

const target: BeatTarget = {
	trackId: "t1",
	element: {
		id: "a1",
		type: "audio",
		sourceType: "upload",
		mediaId: "m1",
		name: "Song",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	} satisfies UploadAudioElement,
	mediaAsset: {
		id: "m1",
		name: "Song",
		type: "audio",
		file: new File([new Uint8Array(10)], "song.mp3", { lastModified: 1234 }),
	} satisfies MediaAsset,
	sourceKey: "media:m1",
};

const stems = (value: number): StemSet => ({
	drums: Int16Array.from([value, 0]),
	bass: Int16Array.from([value + 1, 0]),
	vocals: Int16Array.from([value + 2, 0]),
	other: Int16Array.from([value + 3, 0]),
});

function memoryCache(initial?: { key: string; stems: StemSet }): StemCache & { puts: string[] } {
	const store = new Map<string, StemSet>(initial ? [[initial.key, initial.stems]] : []);
	const puts: string[] = [];
	return {
		puts,
		get: async ({ key, stem }) => store.get(key)?.[stem] ?? null,
		has: async ({ key }) => store.has(key),
		put: async ({ key, stems: value }) => {
			puts.push(key);
			store.set(key, value);
		},
		totalBytes: async () => 0,
		clear: async () => store.clear(),
	};
}

function fakeBridge(overrides: Partial<StemsBridge> & { statuses?: StemsStatus[] } = {}): {
	bridge: StemsBridge;
	calls: string[];
} {
	const calls: string[] = [];
	const statuses = overrides.statuses ?? [
		{ supported: true, engine: "ready", installSizeBytes: null, installPercent: null, modelId: "htdemucs" },
	];
	let polled = 0;
	const unused = async () => {
		throw new Error("not used");
	};
	const bridge: StemsBridge = {
		status: async () => {
			calls.push("status");
			return statuses[Math.min(polled++, statuses.length - 1)];
		},
		install: async () => {
			calls.push("install");
			return { ok: true };
		},
		cancelInstall: async () => {
			calls.push("cancelInstall");
			return true;
		},
		removeEngine: unused,
		begin: unused,
		write: unused,
		run: unused,
		jobStatus: unused,
		read: unused,
		cancel: unused,
		release: unused,
		...overrides,
	};
	return { bridge, calls };
}

const okDecode: StemDeps["decode"] = async () => ({
	ok: true,
	samples: new Int16Array(8),
	sampleRate: 44100,
	frames: 4,
});

function depsOf(overrides: Partial<StemDeps>): StemDeps {
	return {
		bridge: fakeBridge().bridge,
		cache: memoryCache(),
		decode: okDecode,
		separate: async () => ({ ok: true, stems: stems(100) }),
		pollMs: 1,
		...overrides,
	};
}

const run = ({ deps, stages = [] as StemStage[], signal = new AbortController().signal }: { deps: StemDeps; stages?: StemStage[]; signal?: AbortSignal }) =>
	getStemAudio({ target, stem: "bass", signal, onStage: (stage) => stages.push(stage), deps });

describe("getStemAudio", () => {
	test("a cached stem is returned as floats without touching the separator", async () => {
		const key = stemCacheKey({ target });
		if (!key) throw new Error("no key");
		const { bridge, calls } = fakeBridge();
		const result = await run({ deps: depsOf({ bridge, cache: memoryCache({ key, stems: stems(16384) }) }) });
		expect(result).toEqual({
			ok: true,
			samples: Float32Array.from([0.5 + 1 / 32768, 0]),
			sampleRate: 22050,
			offsetSeconds: 0,
		});
		expect(calls).toEqual([]);
	});

	test("the cache key names the model, the media and the file", () => {
		expect(stemCacheKey({ target })).toBe("htdemucs:media:m1:10:1234");
		expect(stemCacheKey({ target: { ...target, mediaAsset: null } })).toBeNull();
	});

	test("a miss is decoded, separated, cached and the asked stem returned; stages are reported", async () => {
		const cache = memoryCache();
		const stages: StemStage[] = [];
		const result = await run({
			stages,
			deps: depsOf({
				cache,
				separate: async ({ onProgress }) => {
					onProgress?.(0.5);
					return { ok: true, stems: stems(100) };
				},
			}),
		});
		expect(result.ok && result.samples).toEqual(stemToFloat({ samples: Int16Array.from([101, 0]) }));
		expect(cache.puts).toEqual(["htdemucs:media:m1:10:1234"]);
		expect(stages).toEqual([{ kind: "reading" }, { kind: "separating", percent: 50 }]);
	});

	test("no bridge (a browser) is a clear failure, never the mixed audio", async () => {
		expect(await run({ deps: depsOf({ bridge: null }) })).toEqual({ ok: false, reason: "stems-unavailable" });
	});

	test("a separator that is missing is installed first, with its progress reported; a refusal is reported as such", async () => {
		const stages: StemStage[] = [];
		const missing = { supported: true, engine: "missing", installSizeBytes: 1, installPercent: null, modelId: "htdemucs" } as const;
		const installing = { ...missing, engine: "installing", installPercent: 40 } as const;
		const { bridge, calls } = fakeBridge({ statuses: [missing, installing, installing] });
		const result = await run({ deps: depsOf({ bridge }), stages });
		expect(result.ok).toBe(true);
		expect(calls[0]).toBe("status");
		expect(calls).toContain("install");
		expect(stages).toContainEqual({ kind: "installing", percent: 40 });

		const broken = { ...missing, engine: "broken" } as const;
		const repairStages: StemStage[] = [];
		await run({ deps: depsOf({ bridge: fakeBridge({ statuses: [broken] }).bridge }), stages: repairStages });
		expect(repairStages[0]).toEqual({ kind: "repairing" });

		const declined = fakeBridge({ statuses: [missing], install: async () => ({ ok: false, code: "consent-declined" }) });
		expect(await run({ deps: depsOf({ bridge: declined.bridge }) })).toEqual({ ok: false, reason: "stems-declined" });
		const unsupported = fakeBridge({ statuses: [{ ...missing, supported: false }] });
		expect(await run({ deps: depsOf({ bridge: unsupported.bridge }) })).toEqual({ ok: false, reason: "stems-unavailable" });
		const pins = fakeBridge({ statuses: [missing], install: async () => ({ ok: false, code: "pins-missing" }) });
		expect(await run({ deps: depsOf({ bridge: pins.bridge }) })).toEqual({ ok: false, reason: "stems-pins-missing" });
	});

	test("decode and separation failures keep their reasons, and a cache that cannot be written does not lose the result", async () => {
		expect(await run({ deps: depsOf({ decode: async () => ({ ok: false, reason: "too-long" }) }) })).toEqual({ ok: false, reason: "stems-too-long" });
		expect(await run({ deps: depsOf({ separate: async () => ({ ok: false, reason: "busy" }) }) })).toEqual({ ok: false, reason: "stems-busy" });
		expect(await run({ deps: depsOf({ separate: async () => ({ ok: false, reason: "timeout" }) }) })).toEqual({ ok: false, reason: "separation-failed" });
		const brokenCache: StemCache = {
			...memoryCache(),
			put: async () => {
				throw new Error("quota");
			},
		};
		expect((await run({ deps: depsOf({ cache: brokenCache }) })).ok).toBe(true);
	});

	test("aborting during the install cancels it and rejects with an AbortError", async () => {
		const controller = new AbortController();
		const missing = { supported: true, engine: "missing", installSizeBytes: 1, installPercent: null, modelId: "htdemucs" } as const;
		let finish: (value: { ok: false; code: "install-failed" }) => void = () => {};
		const { bridge, calls } = fakeBridge({
			statuses: [missing],
			install: () => new Promise((resolve) => { finish = resolve; }),
		});
		const pending = run({ deps: depsOf({ bridge }), signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		finish({ ok: false, code: "install-failed" });
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toContain("cancelInstall");
	});

	test("a cancel that arrives while the status is read never opens the install dialog", async () => {
		const controller = new AbortController();
		const missing = { supported: true, engine: "missing", installSizeBytes: 1, installPercent: null, modelId: "htdemucs" } as const;
		const { bridge, calls } = fakeBridge({
			status: async () => {
				controller.abort();
				return missing;
			},
		});
		await expect(run({ deps: depsOf({ bridge }), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).not.toContain("install");
	});
});
