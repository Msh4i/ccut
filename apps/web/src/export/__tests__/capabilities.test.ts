import { describe, expect, test } from "bun:test";
import { createFakeTimers, flushMicrotasks } from "@/media/__tests__/fake-timers";
import {
	ENCODER_PROBE_TIMEOUT_MS,
	capabilityKey,
	probeCapabilities,
	resolvePlan,
	type EncoderQuery,
	type ExportCapabilities,
} from "../capabilities";
import { defaultExportSettings, type ExportProject } from "../settings";

function project(overrides: Partial<ExportProject> = {}): ExportProject {
	return { width: 1920, height: 1080, fps: { numerator: 30, denominator: 1 }, durationSeconds: 60, ...overrides };
}

function recordingSupport(answer: (query: EncoderQuery) => boolean | Promise<boolean>) {
	const calls: EncoderQuery[] = [];
	return {
		calls,
		isConfigSupported: async (query: EncoderQuery) => {
			calls.push(query);
			return answer(query);
		},
	};
}

describe("probeCapabilities", () => {
	test("asks for every resolution x fps x codec the dialog can offer", async () => {
		const support = recordingSupport(() => true);
		const capabilities = await probeCapabilities({
			project: project(),
			isConfigSupported: support.isConfigSupported,
			aacAvailable: true,
			opusAvailable: true,
		});
		// 3 sizes (project, 720, 480) x 5 rates (project 30, 24, 25, 50, 60) x 2 codecs.
		expect(Object.keys(capabilities.video)).toHaveLength(30);
		expect(support.calls).toHaveLength(30);
		expect(capabilities.video[capabilityKey({ codec: "avc", width: 1280, height: 720, fps: 60 })]).toEqual({
			supported: true,
			hardwareAcceleration: "no-preference",
			reason: null,
		});
	});

	test("the H.264 query carries the level's codec string; VP9's is left to the wiring", async () => {
		const support = recordingSupport(() => true);
		await probeCapabilities({ project: project(), isConfigSupported: support.isConfigSupported, aacAvailable: true, opusAvailable: true });
		const avc = support.calls.find((call) => call.codec === "avc" && call.width === 1920 && call.framerate === 30);
		expect(avc?.codecString).toBe("avc1.640028");
		expect(avc?.bitrate).toBeGreaterThan(0);
		expect(support.calls.find((call) => call.codec === "vp9")?.codecString).toBeNull();
	});

	test("chain: no-preference first, prefer-software only if that is refused", async () => {
		const support = recordingSupport((query) => query.hardwareAcceleration === "prefer-software");
		const capabilities = await probeCapabilities({
			project: project({ width: 640, height: 360 }),
			isConfigSupported: support.isConfigSupported,
			aacAvailable: true,
			opusAvailable: true,
		});
		const key = capabilityKey({ codec: "avc", width: 640, height: 360, fps: 30 });
		expect(capabilities.video[key]).toEqual({ supported: true, hardwareAcceleration: "prefer-software", reason: null });
		const forKey = support.calls.filter((call) => call.codec === "avc" && call.width === 640 && call.framerate === 30);
		expect(forKey.map((call) => call.hardwareAcceleration)).toEqual(["no-preference", "prefer-software"]);
	});

	test("refused by both: unsupported, with a reason naming codec, size and fps", async () => {
		const support = recordingSupport((query) => !(query.codec === "vp9" && query.framerate === 60));
		const capabilities = await probeCapabilities({
			project: project(),
			isConfigSupported: support.isConfigSupported,
			aacAvailable: true,
			opusAvailable: true,
		});
		const entry = capabilities.video[capabilityKey({ codec: "vp9", width: 1920, height: 1080, fps: 60 })];
		expect(entry.supported).toBe(false);
		expect(entry.hardwareAcceleration).toBeNull();
		expect(entry.reason).toBe("This computer cannot encode VP9 at 1920x1080, 60 fps.");
	});

	test("a check that throws counts as a refusal and is reported", async () => {
		const support = recordingSupport(() => {
			throw new Error("GPU process gone");
		});
		const capabilities = await probeCapabilities({
			project: project({ width: 640, height: 360 }),
			isConfigSupported: support.isConfigSupported,
			aacAvailable: true,
			opusAvailable: true,
		});
		const entry = capabilities.video[capabilityKey({ codec: "avc", width: 640, height: 360, fps: 30 })];
		expect(entry.supported).toBe(false);
		expect(entry.reason).toContain("GPU process gone");
	});

	test("a check that never answers is given up after the probe timeout", async () => {
		const timers = createFakeTimers();
		let settled: ExportCapabilities | null = null;
		const promise = probeCapabilities({
			project: project({ width: 640, height: 360, fps: { numerator: 30, denominator: 1 } }),
			isConfigSupported: () => new Promise<boolean>(() => {}),
			aacAvailable: true,
			opusAvailable: true,
			codecs: ["avc"],
			timers,
		}).then((value) => {
			settled = value;
		});
		// 1 size x 5 rates x 2 chain steps, each waiting for its own timeout.
		for (let i = 0; i < 10; i++) {
			await flushMicrotasks();
			timers.advance(ENCODER_PROBE_TIMEOUT_MS);
		}
		await promise;
		const entry = (settled as ExportCapabilities | null)?.video[capabilityKey({ codec: "avc", width: 640, height: 360, fps: 30 })];
		expect(entry?.supported).toBe(false);
		expect(entry?.reason).toContain("did not answer");
	});

	test("sizes beyond H.264 level 5.2 are refused without asking the encoder", async () => {
		const support = recordingSupport(() => true);
		const capabilities = await probeCapabilities({
			project: project({ width: 7680, height: 4320 }),
			isConfigSupported: support.isConfigSupported,
			aacAvailable: true,
			opusAvailable: true,
		});
		const entry = capabilities.video[capabilityKey({ codec: "avc", width: 7680, height: 4320, fps: 30 })];
		expect(entry.supported).toBe(false);
		expect(entry.reason).toContain("H.264");
		expect(support.calls.some((call) => call.codec === "avc" && call.width === 7680)).toBe(false);
		expect(support.calls.some((call) => call.codec === "vp9" && call.width === 7680)).toBe(true);
	});
});

async function allSupported({ aacAvailable = true, opusAvailable = true, canvas = project() } = {}) {
	return probeCapabilities({ project: canvas, isConfigSupported: async () => true, aacAvailable, opusAvailable });
}

describe("resolvePlan", () => {
	test("a full plan for the defaults", async () => {
		const result = resolvePlan({ settings: defaultExportSettings(), project: project(), capabilities: await allSupported() });
		if (!result.ok) throw new Error(JSON.stringify(result.issues));
		expect(result.plan).toMatchObject({
			container: "mp4",
			render: { width: 1920, height: 1080 },
			output: { width: 1920, height: 1080 },
			scaledCanvas: false,
			fps: { numerator: 30, denominator: 1 },
			video: { codec: "avc", fullCodecString: "avc1.640028", hardwareAcceleration: "no-preference", keyFrameIntervalSec: 2 },
			audio: { codec: "aac", bitrate: 192_000, backend: "wasm" },
		});
		expect(result.plan.estimate.bytes).toBeGreaterThan(0);
		expect(result.warnings).toEqual([]);
	});

	test("a smaller output uses the scaled canvas", async () => {
		const result = resolvePlan({
			settings: { ...defaultExportSettings(), resolution: { kind: "short-side", shortSide: 720 } },
			project: project(),
			capabilities: await allSupported(),
		});
		expect(result.ok && result.plan.scaledCanvas).toBe(true);
		expect(result.ok && result.plan.output).toEqual({ width: 1280, height: 720 });
	});

	test("invalid settings give the validation issues and no plan", async () => {
		const result = resolvePlan({
			settings: { ...defaultExportSettings(), quality: { kind: "custom", mbps: 0.1 } },
			project: project(),
			capabilities: await allSupported(),
		});
		expect(result.ok).toBe(false);
		expect(!result.ok && result.issues.map((issue) => `${issue.field}:${issue.code}`)).toEqual(["quality:out-of-range"]);
	});

	test("an unsupported combination is an error with the probe's reason", async () => {
		const capabilities = await probeCapabilities({
			project: project(),
			isConfigSupported: async (query) => query.framerate !== 60,
			aacAvailable: true,
			opusAvailable: true,
		});
		const result = resolvePlan({ settings: { ...defaultExportSettings(), fps: { kind: "fixed", fps: 60 } }, project: project(), capabilities });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.issues[0]).toMatchObject({ field: "resolution", code: "unsupported", severity: "error" });
		expect(!result.ok && result.issues[0].message).toContain("60 fps");
	});

	test("a combination that was never probed is refused, not assumed", () => {
		const empty: ExportCapabilities = { video: {}, aacAvailable: true, opusAvailable: true };
		const result = resolvePlan({ settings: defaultExportSettings(), project: project(), capabilities: empty });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.issues[0].code).toBe("not-probed");
	});

	test("MP4 without AAC: the audio is off and a warning says so; it is never Opus", async () => {
		const result = resolvePlan({
			settings: defaultExportSettings(),
			project: project(),
			capabilities: await allSupported({ aacAvailable: false }),
		});
		if (!result.ok) throw new Error("expected a plan");
		expect(result.plan.audio).toBeNull();
		expect(result.warnings.map((warning) => warning.code)).toEqual(["aac-unavailable"]);
	});

	test("WebM uses Opus through WebCodecs; without Opus the audio is off with a warning", async () => {
		const webm = { ...defaultExportSettings(), container: "webm" as const, audioBitrate: 128_000 };
		const withOpus = resolvePlan({ settings: webm, project: project(), capabilities: await allSupported() });
		expect(withOpus.ok && withOpus.plan.audio).toEqual({ codec: "opus", bitrate: 128_000, backend: "webcodecs" });
		expect(withOpus.ok && withOpus.plan.video.codec).toBe("vp9");
		const withoutOpus = resolvePlan({ settings: webm, project: project(), capabilities: await allSupported({ opusAvailable: false }) });
		expect(withoutOpus.ok && withoutOpus.plan.audio).toBeNull();
		expect(withoutOpus.ok && withoutOpus.warnings.map((warning) => warning.code)).toEqual(["opus-unavailable"]);
	});

	test("audio off: no audio in the plan, no warning, smaller estimate", async () => {
		const capabilities = await allSupported();
		const on = resolvePlan({ settings: defaultExportSettings(), project: project(), capabilities });
		const off = resolvePlan({ settings: { ...defaultExportSettings(), includeAudio: false }, project: project(), capabilities });
		if (!on.ok || !off.ok) throw new Error("expected plans");
		expect(off.plan.audio).toBeNull();
		expect(off.warnings).toEqual([]);
		expect(off.plan.estimate.bytes).toBeLessThan(on.plan.estimate.bytes);
	});

	test("fps above the project's comes through as a warning", async () => {
		const result = resolvePlan({
			settings: { ...defaultExportSettings(), fps: { kind: "fixed", fps: 60 } },
			project: project(),
			capabilities: await allSupported(),
		});
		expect(result.ok && result.warnings.map((warning) => warning.code)).toEqual(["above-project"]);
	});
});
