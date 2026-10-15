import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
	LinkBridgeError,
	getLinkImportBridge,
	parseJobStatus,
	parseStartResult,
	parseUpdateResult,
} from "../bridge";

// The typed client around window.ccutLinkImport: nothing that comes back from the desktop
// bridge is trusted; a wrong shape becomes "bridge-failed", never a crash or a wrong path.

const token = "ab".repeat(32);
const file = {
	size: 1000,
	ext: "mp4",
	mime: "video/mp4",
	title: "Clip",
	width: 640,
	height: 360,
	duration: 6,
	vcodec: "avc1.42001E",
	combined: false,
	combineTried: false,
};

function rawBridge(overrides: Record<string, unknown> = {}) {
	return {
		start: async () => ({ ok: true, token }),
		status: async () => ({ state: "ready", phase: null, progress: null, file, code: null }),
		cancel: async () => true,
		read: async () => new Uint8Array([1, 2, 3]),
		release: async () => true,
		...overrides,
	};
}

const scopeWith = (raw: unknown) => ({ ccutLinkImport: raw });

describe("getLinkImportBridge", () => {
	test("null in a browser, or when the object lacks a function", () => {
		expect(getLinkImportBridge({ scope: {} })).toBeNull();
		expect(getLinkImportBridge({ scope: scopeWith(null) })).toBeNull();
		expect(getLinkImportBridge({ scope: scopeWith({ ...rawBridge(), read: "x" }) })).toBeNull();
		expect(getLinkImportBridge({ scope: scopeWith(rawBridge()) })).not.toBeNull();
	});
});

describe("parseStartResult", () => {
	test("a token of 64 hex digits, or a known code; anything else is bridge-failed", () => {
		expect(parseStartResult({ value: { ok: true, token } })).toEqual({ ok: true, token });
		expect(parseStartResult({ value: { ok: false, code: "busy" } })).toEqual({ ok: false, code: "busy" });
		for (const value of [
			null,
			{ ok: true },
			{ ok: true, token: "short" },
			{ ok: true, token: token.toUpperCase() },
			{ ok: true, token: `${token}00` },
			{ ok: false, code: "private" }, // a job code is not a start code
			{ ok: false, code: "toString" },
			{ ok: "yes", token },
		]) {
			expect(parseStartResult({ value })).toEqual({ ok: false, code: "bridge-failed" });
		}
	});
});

describe("parseJobStatus", () => {
	test("each state with its fields", () => {
		expect(parseJobStatus({ value: { state: "preparing", phase: "consent", progress: null, file: null, code: null } })).toEqual({
			state: "preparing",
			step: "consent",
		});
		expect(parseJobStatus({ value: { state: "preparing", phase: null } })).toEqual({ state: "preparing", step: "tool-check" });
		const progress = { downloadedBytes: 10, totalBytes: 100, speed: 5.5, eta: 18 };
		expect(parseJobStatus({ value: { state: "downloading", progress } })).toEqual({ state: "downloading", progress });
		expect(parseJobStatus({ value: { state: "downloading", progress: null } })).toEqual({ state: "downloading", progress: null });
		expect(parseJobStatus({ value: { state: "ready", progress: null, file } })).toEqual({ state: "ready", progress: null, file });
		expect(parseJobStatus({ value: { state: "failed", code: "geo-blocked" } })).toEqual({ state: "failed", code: "geo-blocked" });
		expect(parseJobStatus({ value: { state: "cancelled" } })).toEqual({ state: "cancelled" });
		// combining the video-only and the audio download in the main process (YouTube, Video)
		expect(parseJobStatus({ value: { state: "processing", phase: null, progress, fraction: 0.42, file: null, code: null } })).toEqual({ state: "processing", fraction: 0.42 });
		expect(parseJobStatus({ value: { state: "processing", fraction: null } })).toEqual({ state: "processing", fraction: null });
		expect(parseJobStatus({ value: { state: "processing", fraction: 0 } })).toEqual({ state: "processing", fraction: 0 });
		expect(parseJobStatus({ value: { state: "processing", fraction: 1 } })).toEqual({ state: "processing", fraction: 1 });
		expect(parseJobStatus({ value: { state: "ready", progress: null, file: { ...file, combined: true } } })).toEqual({ state: "ready", progress: null, file: { ...file, combined: true } });
	});

	test("refused: unknown state/phase/code, bad numbers, a MIME or extension off the list, a mismatching pair, oversized text", () => {
		const bad: unknown[] = [
			null,
			"ready",
			{ state: "done" },
			{ state: "preparing", phase: "hacking" },
			{ state: "failed", code: "rm -rf" },
			{ state: "failed", code: "busy" },
			{ state: "downloading", progress: { downloadedBytes: -1, totalBytes: null, speed: null, eta: null } },
			{ state: "downloading", progress: { downloadedBytes: 1.5, totalBytes: null, speed: null, eta: null } },
			{ state: "downloading", progress: { downloadedBytes: 1, totalBytes: Number.NaN, speed: null, eta: null } },
			{ state: "downloading", progress: { downloadedBytes: 1, totalBytes: null, speed: "fast", eta: null } },
			{ state: "ready", progress: null, file: null },
			{ state: "ready", progress: null, file: { ...file, mime: "text/html" } },
			{ state: "ready", progress: null, file: { ...file, ext: "exe" } },
			{ state: "ready", progress: null, file: { ...file, ext: "m4a" } }, // video/mp4 is not an m4a's type
			{ state: "ready", progress: null, file: { ...file, size: 0 } },
			{ state: "ready", progress: null, file: { ...file, size: 3 * 1024 ** 3 } },
			{ state: "ready", progress: null, file: { ...file, title: 5 } },
			{ state: "ready", progress: null, file: { ...file, title: "x".repeat(1001) } },
			{ state: "ready", progress: null, file: { ...file, width: -1 } },
			{ state: "ready", progress: null, file: { ...file, vcodec: 5 } },
			{ state: "ready", progress: null, file: { ...file, combined: "yes" } },
			{ state: "ready", progress: null, file: { ...file, combineTried: 1 } },
			{ state: "ready", progress: null, file: { ...file, combineTried: undefined } },
			{ state: "ready", progress: null, file: { ...file, combined: undefined } },
			{ state: "processing", fraction: 1.5 },
			{ state: "processing", fraction: -0.1 },
			{ state: "processing", fraction: Number.NaN },
			{ state: "processing", fraction: "50%" },
			{ state: "processing" },
		];
		for (const value of bad) expect(parseJobStatus({ value })).toBeNull();
	});
});

describe("the client", () => {
	test("start: a rejected or malformed answer is bridge-failed, never a throw", async () => {
		const throwing = getLinkImportBridge({ scope: scopeWith(rawBridge({ start: async () => Promise.reject(new Error("CCUT_LINK_IMPORT:FORBIDDEN")) })) });
		expect(await throwing?.start({ url: "https://youtu.be/x", mode: "video", quality: "best" })).toEqual({ ok: false, code: "bridge-failed" });
		const odd = getLinkImportBridge({ scope: scopeWith(rawBridge({ start: async () => ({ ok: true, token: 5 }) })) });
		expect(await odd?.start({ url: "https://youtu.be/x", mode: "video", quality: "best" })).toEqual({ ok: false, code: "bridge-failed" });
	});

	test("status: a malformed answer throws LinkBridgeError; the main process's code is kept in the error", async () => {
		const odd = getLinkImportBridge({ scope: scopeWith(rawBridge({ status: async () => ({ state: "weird" }) })) });
		await expect(odd?.status({ token })).rejects.toBeInstanceOf(LinkBridgeError);
		const unknown = getLinkImportBridge({
			scope: scopeWith(rawBridge({ status: async () => Promise.reject(new Error("Error invoking remote method 'ccut-link-import:status': LinkImportError: CCUT_LINK_IMPORT:UNKNOWN_JOB")) })),
		});
		const error = await unknown?.status({ token }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LinkBridgeError);
		expect(error instanceof LinkBridgeError ? error.bridgeCode : null).toBe("UNKNOWN_JOB");
	});

	test("read: only a Uint8Array of 1 .. length bytes is accepted (one from another realm too)", async () => {
		const page = runInNewContext("new Uint8Array([1, 2])");
		const fromOtherRealm = getLinkImportBridge({ scope: scopeWith(rawBridge({ read: async () => page })) });
		expect(Array.from((await fromOtherRealm?.read({ token, offset: 0, length: 2 })) ?? [])).toEqual([1, 2]);
		for (const answer of [new Uint8Array(0), new Uint8Array(5), [1, 2], "ab", new Uint16Array(1), null]) {
			const bridge = getLinkImportBridge({ scope: scopeWith(rawBridge({ read: async () => answer })) });
			await expect(bridge?.read({ token, offset: 0, length: 4 })).rejects.toBeInstanceOf(LinkBridgeError);
		}
	});

	test("cancel and release: true only for a literal true", async () => {
		for (const [answer, expected] of [
			[true, true],
			[false, false],
			["true", false],
			[1, false],
		] as const) {
			const bridge = getLinkImportBridge({ scope: scopeWith(rawBridge({ cancel: async () => answer, release: async () => answer })) });
			expect(await bridge?.cancel({ token })).toBe(expected);
			expect(await bridge?.release({ token })).toBe(expected);
		}
	});
});

describe("update calls", () => {
	const raw = (overrides: Record<string, unknown>) => ({
		start: async () => ({}),
		status: async () => ({}),
		cancel: async () => true,
		read: async () => new Uint8Array(1),
		release: async () => true,
		...overrides,
	});

	test("checkUpdate hands on a release tag and nothing else (anything odd, or a rejection, is null)", async () => {
		for (const [answer, expected] of [["2026.10.01", "2026.10.01"], ["2024.12.06.232909", "2024.12.06.232909"], ["2026.10.01\n", null], ["<img src=x>", null], ["/etc/passwd", null], [1, null], [null, null], [{ version: "2026.10.01" }, null]] as const) {
			const bridge = getLinkImportBridge({ scope: { ccutLinkImport: raw({ checkUpdate: async () => answer }) } });
			expect(await bridge?.checkUpdate()).toBe(expected);
		}
		const rejecting = getLinkImportBridge({ scope: { ccutLinkImport: raw({ checkUpdate: async () => Promise.reject(new Error("x")) }) } });
		expect(await rejecting?.checkUpdate()).toBeNull();
		const old = getLinkImportBridge({ scope: { ccutLinkImport: raw({}) } });
		expect(await old?.checkUpdate()).toBeNull();
		expect(await old?.updateTool()).toEqual({ ok: false, code: "bridge-failed" });
	});

	test("updateTool answers only a tag or a known code; the rest is bridge-failed", () => {
		expect(parseUpdateResult({ value: { ok: true, version: "2026.10.01" } })).toEqual({ ok: true, version: "2026.10.01" });
		expect(parseUpdateResult({ value: { ok: false, code: "up-to-date", path: "/home/x" } })).toEqual({ ok: false, code: "up-to-date" });
		for (const bad of [null, "x", { ok: true }, { ok: true, version: "latest" }, { ok: false, code: "extractor-failed" }, { ok: false, code: "/home/x" }, { ok: false }]) {
			expect(parseUpdateResult({ value: bad })).toEqual({ ok: false, code: "bridge-failed" });
		}
	});
});
