import {
	SEPARATION_SAMPLE_RATES,
	STEM_CHUNK_BYTES,
	STEM_NAMES,
	type StemBeginCode,
	type StemInstallCode,
	type StemJobCode,
	type StemJobStatus,
	type StemName,
	type StemsStatus,
} from "./types";

// `window.ccutStems`, set by the desktop app's preload (apps/electron/preload.js). Whatever
// comes back is checked here before the page uses it: a wrong shape is a failure code
// ("bridge-failed") or a StemsBridgeError, never a crash. Same shape as the link import bridge.

export interface StemsBridge {
	status(): Promise<StemsStatus | null>;
	/** Asks in the main process, downloads, verifies. Never rejects. */
	install(): Promise<{ ok: true } | { ok: false; code: StemInstallCode }>;
	cancelInstall(): Promise<boolean>;
	removeEngine(): Promise<boolean>;
	begin(request: {
		frames: number;
		sampleRate: number;
	}): Promise<{ ok: true; token: string } | { ok: false; code: StemBeginCode }>;
	/** `data`: at most STEM_CHUNK_BYTES of interleaved stereo PCM16, sent in order. */
	write(request: { token: string; position: number; data: Uint8Array }): Promise<void>;
	run(request: { token: string }): Promise<boolean>;
	jobStatus(request: { token: string }): Promise<StemJobStatus>;
	/** 1 .. length bytes of the stem (Int16 mono) at `offset`. */
	read(request: {
		token: string;
		stem: StemName;
		offset: number;
		length: number;
	}): Promise<Uint8Array>;
	cancel(request: { token: string }): Promise<boolean>;
	release(request: { token: string }): Promise<boolean>;
}

/** A rejected or malformed bridge call. `bridgeCode` is the main process's code, if any. */
export class StemsBridgeError extends Error {
	readonly bridgeCode: string | null;

	constructor({ bridgeCode }: { bridgeCode: string | null }) {
		super(`stems bridge: ${bridgeCode ?? "malformed answer"}`);
		this.name = "StemsBridgeError";
		this.bridgeCode = bridgeCode;
	}
}

const METHODS = [
	"status",
	"install",
	"cancelInstall",
	"removeEngine",
	"begin",
	"write",
	"run",
	"jobStatus",
	"read",
	"cancel",
	"release",
] as const;

const INSTALL_CODES: readonly StemInstallCode[] = [
	"unsupported",
	"pins-missing",
	"consent-declined",
	"busy",
	"download-failed",
	"verify-failed",
	"install-failed",
	"no-disk-space",
	"bridge-failed",
];
const BEGIN_CODES: readonly StemBeginCode[] = [
	"invalid",
	"too-long",
	"busy",
	"engine-missing",
	"bridge-failed",
];
const JOB_CODES: readonly StemJobCode[] = ["engine-failed", "timeout", "invalid-output", "out-of-memory"];
const ENGINE_STATES: readonly StemsStatus["engine"][] = ["missing", "installing", "ready", "broken"];
const MAX_MODEL_ID_CHARS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === "string" && list.some((item) => item === value);
}

// Realm-independent: a Uint8Array made in the preload's world is not `instanceof` here.
function isUint8Array(value: unknown): value is Uint8Array {
	return (
		ArrayBuffer.isView(value) &&
		Object.prototype.toString.call(value) === "[object Uint8Array]"
	);
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPercent = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

export function parseStatus({ value }: { value: unknown }): StemsStatus | null {
	if (!isRecord(value)) return null;
	const { supported, engine, installSizeBytes, installPercent, modelId } = value;
	if (
		typeof supported !== "boolean" ||
		!isOneOf(ENGINE_STATES, engine) ||
		typeof modelId !== "string" ||
		modelId.length === 0 ||
		modelId.length > MAX_MODEL_ID_CHARS
	) {
		return null;
	}
	if (installSizeBytes !== null && !isCount(installSizeBytes)) return null;
	if (installPercent !== null && !isPercent(installPercent)) return null;
	return { supported, engine, installSizeBytes, installPercent, modelId };
}

export function parseInstallResult({
	value,
}: {
	value: unknown;
}): { ok: true } | { ok: false; code: StemInstallCode } {
	if (isRecord(value)) {
		if (value.ok === true) return { ok: true };
		if (value.ok === false && isOneOf(INSTALL_CODES, value.code)) {
			return { ok: false, code: value.code };
		}
	}
	return { ok: false, code: "bridge-failed" };
}

export function parseBeginResult({
	value,
}: {
	value: unknown;
}): { ok: true; token: string } | { ok: false; code: StemBeginCode } {
	if (isRecord(value)) {
		if (value.ok === true && typeof value.token === "string" && /^[0-9a-f]{16,128}$/.test(value.token)) {
			return { ok: true, token: value.token };
		}
		if (value.ok === false && isOneOf(BEGIN_CODES, value.code)) {
			return { ok: false, code: value.code };
		}
	}
	return { ok: false, code: "bridge-failed" };
}

export function parseJobStatus({ value }: { value: unknown }): StemJobStatus | null {
	if (!isRecord(value) || !isPercent(value.percent)) return null;
	const { percent } = value;
	switch (value.state) {
		case "receiving":
			return { state: "receiving", percent };
		case "running":
			return { state: "running", percent };
		case "cancelled":
			return { state: "cancelled", percent };
		case "done":
			return isCount(value.samples) && value.samples > 0
				? { state: "done", percent, samples: value.samples }
				: null;
		case "failed":
			return isOneOf(JOB_CODES, value.code)
				? { state: "failed", percent, code: value.code }
				: null;
		default:
			return null;
	}
}

function bridgeCodeOf({ error }: { error: unknown }): string | null {
	const message = error instanceof Error ? error.message : String(error);
	return /CCUT_STEMS:([A-Z_]+)/.exec(message)?.[1] ?? null;
}

async function call(invoke: () => Promise<unknown>): Promise<unknown> {
	try {
		return await invoke();
	} catch (error) {
		throw new StemsBridgeError({ bridgeCode: bridgeCodeOf({ error }) });
	}
}

function isRawBridge(value: unknown): value is Record<(typeof METHODS)[number], (request?: unknown) => Promise<unknown>> {
	if (typeof value !== "object" || value === null) return false;
	return METHODS.every((name) => typeof Reflect.get(value, name) === "function");
}

/** The desktop bridge, wrapped and checked; null in a browser (or without the bridge). */
export function getStemsBridge({ scope = globalThis }: { scope?: object } = {}): StemsBridge | null {
	const raw: unknown = Reflect.get(scope, "ccutStems");
	if (!isRawBridge(raw)) return null;
	return {
		async status() {
			try {
				return parseStatus({ value: await raw.status() });
			} catch {
				return null;
			}
		},
		async install() {
			try {
				return parseInstallResult({ value: await raw.install() });
			} catch {
				return { ok: false, code: "bridge-failed" };
			}
		},
		async cancelInstall() {
			try {
				const answer = await raw.cancelInstall();
				return isRecord(answer) && answer.ok === true;
			} catch {
				return false;
			}
		},
		async removeEngine() {
			try {
				const answer = await raw.removeEngine();
				return isRecord(answer) && answer.ok === true;
			} catch {
				return false;
			}
		},
		async begin({ frames, sampleRate }) {
			if (
				!Number.isSafeInteger(frames) ||
				frames < 1 ||
				!SEPARATION_SAMPLE_RATES.some((rate) => rate === sampleRate)
			) {
				return { ok: false, code: "invalid" };
			}
			try {
				return parseBeginResult({ value: await raw.begin({ frames, sampleRate }) });
			} catch {
				return { ok: false, code: "bridge-failed" };
			}
		},
		async write({ token, position, data }) {
			if (data.byteLength < 1 || data.byteLength > STEM_CHUNK_BYTES || data.buffer.byteLength > STEM_CHUNK_BYTES) {
				throw new StemsBridgeError({ bridgeCode: "INVALID" });
			}
			await call(() => raw.write({ token, position, data }));
		},
		async run({ token }) {
			const answer = await call(() => raw.run({ token }));
			return isRecord(answer) && answer.ok === true;
		},
		async jobStatus({ token }) {
			const parsed = parseJobStatus({ value: await call(() => raw.jobStatus({ token })) });
			if (!parsed) throw new StemsBridgeError({ bridgeCode: null });
			return parsed;
		},
		async read({ token, stem, offset, length }) {
			if (!STEM_NAMES.some((name) => name === stem)) {
				throw new StemsBridgeError({ bridgeCode: "INVALID" });
			}
			const bytes = await call(() => raw.read({ token, stem, offset, length }));
			if (!isUint8Array(bytes) || bytes.byteLength < 1 || bytes.byteLength > length) {
				throw new StemsBridgeError({ bridgeCode: null });
			}
			return bytes;
		},
		async cancel({ token }) {
			const answer = await call(() => raw.cancel({ token }));
			return isRecord(answer) && answer.ok === true;
		},
		async release({ token }) {
			const answer = await call(() => raw.release({ token }));
			return isRecord(answer) && answer.ok === true;
		},
	};
}
