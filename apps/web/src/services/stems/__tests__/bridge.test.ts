import { describe, expect, test } from "bun:test";
import {
	getStemsBridge,
	parseBeginResult,
	parseJobStatus,
	parseStatus,
	StemsBridgeError,
} from "../bridge";
import { STEM_CHUNK_BYTES, type StemsStatus } from "../types";

const TOKEN = "ab".repeat(32);

describe("what the main process may answer", () => {
	test("a job status is accepted only with a known state, a 0..100 percent and, when done, a stem length", () => {
		expect(parseJobStatus({ value: { state: "running", percent: 40 } })).toEqual({ state: "running", percent: 40 });
		expect(parseJobStatus({ value: { state: "done", percent: 100, samples: 5 } })).toEqual({ state: "done", percent: 100, samples: 5 });
		expect(parseJobStatus({ value: { state: "done", percent: 100 } })).toBeNull();
		expect(parseJobStatus({ value: { state: "done", percent: 100, samples: 0 } })).toBeNull();
		expect(parseJobStatus({ value: { state: "running", percent: 101 } })).toBeNull();
		expect(parseJobStatus({ value: { state: "failed", percent: 1, code: "engine-failed" } })).toEqual({ state: "failed", percent: 1, code: "engine-failed" });
		expect(parseJobStatus({ value: { state: "failed", percent: 1, code: "/etc/passwd" } })).toBeNull();
		expect(parseJobStatus({ value: { state: "sleeping", percent: 1 } })).toBeNull();
	});

	test("begin answers a hex token or a known code; anything else is a bridge failure", () => {
		expect(parseBeginResult({ value: { ok: true, token: TOKEN } })).toEqual({ ok: true, token: TOKEN });
		expect(parseBeginResult({ value: { ok: true, token: "../../x" } })).toEqual({ ok: false, code: "bridge-failed" });
		expect(parseBeginResult({ value: { ok: false, code: "too-long" } })).toEqual({ ok: false, code: "too-long" });
		expect(parseBeginResult({ value: { ok: false, code: "whatever" } })).toEqual({ ok: false, code: "bridge-failed" });
		expect(parseBeginResult({ value: null })).toEqual({ ok: false, code: "bridge-failed" });
	});

	test("the engine status needs every field in its type", () => {
		const good: StemsStatus = { supported: true, engine: "ready", installSizeBytes: 5, installPercent: null, modelId: "htdemucs" };
		expect(parseStatus({ value: good })).toEqual(good);
		expect(parseStatus({ value: { ...good, engine: "exploded" } })).toBeNull();
		expect(parseStatus({ value: { ...good, installPercent: 120 } })).toBeNull();
		expect(parseStatus({ value: { ...good, modelId: "" } })).toBeNull();
	});
});

function rawBridge(overrides: Record<string, unknown> = {}) {
	const names = ["status", "install", "cancelInstall", "removeEngine", "begin", "write", "run", "jobStatus", "read", "cancel", "release"];
	const raw: Record<string, unknown> = {};
	for (const name of names) raw[name] = async () => ({ ok: true });
	return { ...raw, ...overrides };
}

describe("the wrapper around window.ccutStems", () => {
	test("is null without the bridge or with a bridge that lacks a function (a browser, an old preload)", () => {
		expect(getStemsBridge({ scope: {} })).toBeNull();
		expect(getStemsBridge({ scope: { ccutStems: { status: async () => null } } })).toBeNull();
		expect(getStemsBridge({ scope: { ccutStems: rawBridge() } })).not.toBeNull();
	});

	test("a chunk that is a view of a big buffer is refused before it is sent (the bridge sends the whole backing buffer)", async () => {
		const sent: unknown[] = [];
		const bridge = getStemsBridge({ scope: { ccutStems: rawBridge({ write: async (request: unknown) => void sent.push(request) }) } });
		if (!bridge) throw new Error("no bridge");
		const big = new Uint8Array(STEM_CHUNK_BYTES * 2);
		await expect(bridge.write({ token: TOKEN, position: 0, data: big.subarray(0, 8) })).rejects.toBeInstanceOf(StemsBridgeError);
		await bridge.write({ token: TOKEN, position: 0, data: big.slice(0, 8) });
		expect(sent.length).toBe(1);
	});

	test("begin refuses a rate the main process does not take without calling it", async () => {
		let called = false;
		const bridge = getStemsBridge({ scope: { ccutStems: rawBridge({ begin: async () => { called = true; return { ok: true, token: TOKEN }; } }) } });
		if (!bridge) throw new Error("no bridge");
		expect(await bridge.begin({ frames: 10, sampleRate: 12345 })).toEqual({ ok: false, code: "invalid" });
		expect(called).toBe(false);
	});
});
