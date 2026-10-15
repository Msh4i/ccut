import {
	JOB_ERROR_CODES,
	START_ERROR_CODES,
	UPDATE_ERROR_CODES,
	type JobErrorCode,
	type LinkFileInfo,
	type LinkImportRequest,
	type LinkJobStatus,
	type LinkProgress,
	type PreparingStep,
	type StartResult,
	type UpdateResult,
} from "./types";

// `window.ccutLinkImport`, set by the desktop app's preload (apps/electron/preload.js).
// Everything that comes back is checked here before the page uses it: a wrong shape is
// "bridge-failed" (start) or a LinkBridgeError (the other calls), never a crash.

export interface LinkImportBridge {
	/** Never rejects: a failure is { ok: false, code }. */
	start(request: LinkImportRequest): Promise<StartResult>;
	status(request: { token: string }): Promise<LinkJobStatus>;
	cancel(request: { token: string }): Promise<boolean>;
	/** 1 .. length bytes of the downloaded file at `offset`. */
	read(request: {
		token: string;
		offset: number;
		length: number;
	}): Promise<Uint8Array>;
	release(request: { token: string }): Promise<boolean>;
	/**
	 * A newer yt-dlp release for Ccut's own copy (checked at most once a day in the main
	 * process), as a version tag; null when there is none or anything is wrong. Never rejects.
	 */
	checkUpdate(): Promise<string | null>;
	/** The user's click on "Update": the main process asks, then installs the verified release. Never rejects. */
	updateTool(): Promise<UpdateResult>;
}

/** A rejected or malformed bridge call. `bridgeCode` is the main process's code, if any. */
export class LinkBridgeError extends Error {
	readonly bridgeCode: string | null;

	constructor({ bridgeCode }: { bridgeCode: string | null }) {
		super(`link import bridge: ${bridgeCode ?? "malformed answer"}`);
		this.name = "LinkBridgeError";
		this.bridgeCode = bridgeCode;
	}
}

interface RawBridge {
	start: (request: unknown) => Promise<unknown>;
	status: (request: unknown) => Promise<unknown>;
	cancel: (request: unknown) => Promise<unknown>;
	read: (request: unknown) => Promise<unknown>;
	release: (request: unknown) => Promise<unknown>;
	// Absent in a preload that predates the update policy.
	checkUpdate?: () => Promise<unknown>;
	updateTool?: () => Promise<unknown>;
}

const METHODS = ["start", "status", "cancel", "read", "release"] as const;
const PREPARING_STEPS: readonly PreparingStep[] = [
	"tool-check",
	"consent",
	"tool-download",
];
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_TITLE_CHARS = 1000;
const MAX_CODEC_CHARS = 128;
// Extension -> the MIME types the main process may pair with it (link-import-jobs.js OUTPUT_TYPES).
const FILE_TYPES: Record<string, readonly string[]> = {
	mp4: ["video/mp4"],
	webm: ["video/webm", "audio/webm"],
	m4a: ["audio/mp4"],
	mp3: ["audio/mpeg"],
	ogg: ["audio/ogg"],
	opus: ["audio/ogg"],
};

// What yt-dlp's release tags look like (TAG_PATTERN in apps/electron/link-import-tool.js).
const RELEASE_TAG = /^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,10})?$/;
export const isReleaseTag = (value: unknown): value is string =>
	typeof value === "string" && RELEASE_TAG.test(value);

export function parseUpdateResult({ value }: { value: unknown }): UpdateResult {
	if (isRecord(value)) {
		if (value.ok === true && isReleaseTag(value.version)) {
			return { ok: true, version: value.version };
		}
		if (value.ok === false && isOneOf(UPDATE_ERROR_CODES, value.code)) {
			return { ok: false, code: value.code };
		}
	}
	return { ok: false, code: "bridge-failed" };
}

function isRawBridge(value: unknown): value is RawBridge {
	if (typeof value !== "object" || value === null) return false;
	return METHODS.every((name) => typeof Reflect.get(value, name) === "function");
}

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

const isCount = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNonNegative = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const isFraction = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const nullOr = ({
	value,
	check,
}: {
	value: unknown;
	check: (value: unknown) => boolean;
}) => value === null || check(value);

function parseProgress({ value }: { value: unknown }): LinkProgress | null {
	if (!isRecord(value)) return null;
	const { downloadedBytes, totalBytes, speed, eta } = value;
	if (
		typeof downloadedBytes !== "number" ||
		!isCount(downloadedBytes) ||
		!nullOr({ value: totalBytes, check: isNonNegative }) ||
		!nullOr({ value: speed, check: isNonNegative }) ||
		!nullOr({ value: eta, check: isNonNegative })
	) {
		return null;
	}
	return {
		downloadedBytes,
		totalBytes: typeof totalBytes === "number" ? totalBytes : null,
		speed: typeof speed === "number" ? speed : null,
		eta: typeof eta === "number" ? eta : null,
	};
}

const positiveDimension = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function parseFile({ value }: { value: unknown }): LinkFileInfo | null {
	if (!isRecord(value)) return null;
	const { size, ext, mime, title, width, height, duration, vcodec, combined, combineTried } = value;
	if (typeof size !== "number" || !isCount(size) || size < 1 || size > MAX_FILE_BYTES) return null;
	if (typeof ext !== "string" || !Object.hasOwn(FILE_TYPES, ext)) return null;
	if (typeof mime !== "string" || !FILE_TYPES[ext].includes(mime)) return null;
	if (typeof title !== "string" || title.length > MAX_TITLE_CHARS) return null;
	if (
		!nullOr({ value: width, check: positiveDimension }) ||
		!nullOr({ value: height, check: positiveDimension }) ||
		!nullOr({ value: duration, check: isNonNegative })
	) {
		return null;
	}
	if (vcodec !== null && (typeof vcodec !== "string" || vcodec.length > MAX_CODEC_CHARS)) return null;
	if (typeof combined !== "boolean" || typeof combineTried !== "boolean") return null;
	return {
		size,
		ext,
		mime,
		title,
		width: typeof width === "number" ? width : null,
		height: typeof height === "number" ? height : null,
		duration: typeof duration === "number" ? duration : null,
		vcodec,
		combined,
		combineTried,
	};
}

export function parseStartResult({ value }: { value: unknown }): StartResult {
	if (isRecord(value)) {
		if (value.ok === true && typeof value.token === "string" && /^[0-9a-f]{64}$/.test(value.token)) {
			return { ok: true, token: value.token };
		}
		if (value.ok === false && isOneOf(START_ERROR_CODES, value.code)) {
			return { ok: false, code: value.code };
		}
	}
	return { ok: false, code: "bridge-failed" };
}

export function parseJobStatus({ value }: { value: unknown }): LinkJobStatus | null {
	if (!isRecord(value)) return null;
	switch (value.state) {
		case "preparing": {
			if (value.phase === null || value.phase === undefined) return { state: "preparing", step: "tool-check" };
			return isOneOf(PREPARING_STEPS, value.phase) ? { state: "preparing", step: value.phase } : null;
		}
		case "downloading": {
			if (value.progress === null || value.progress === undefined) return { state: "downloading", progress: null };
			const progress = parseProgress({ value: value.progress });
			return progress ? { state: "downloading", progress } : null;
		}
		case "processing": {
			const { fraction } = value;
			if (fraction === null) return { state: "processing", fraction: null };
			return isFraction(fraction) ? { state: "processing", fraction } : null;
		}
		case "ready": {
			const file = parseFile({ value: value.file });
			if (!file) return null;
			const progress = value.progress === null || value.progress === undefined ? null : parseProgress({ value: value.progress });
			return { state: "ready", progress, file };
		}
		case "failed": {
			const code: unknown = value.code;
			return isOneOf<JobErrorCode>(JOB_ERROR_CODES, code) ? { state: "failed", code } : null;
		}
		case "cancelled":
			return { state: "cancelled" };
		default:
			return null;
	}
}

function bridgeCodeOf({ error }: { error: unknown }): string | null {
	const message = error instanceof Error ? error.message : String(error);
	return /CCUT_LINK_IMPORT:([A-Z_]+)/.exec(message)?.[1] ?? null;
}

async function call(invoke: () => Promise<unknown>): Promise<unknown> {
	try {
		return await invoke();
	} catch (error) {
		throw new LinkBridgeError({ bridgeCode: bridgeCodeOf({ error }) });
	}
}

/** The desktop bridge, wrapped and checked; null in a browser (or without the bridge). */
export function getLinkImportBridge({
	scope = globalThis,
}: { scope?: object } = {}): LinkImportBridge | null {
	const raw: unknown = Reflect.get(scope, "ccutLinkImport");
	if (!isRawBridge(raw)) return null;
	return {
		async start(request) {
			try {
				return parseStartResult({ value: await raw.start(request) });
			} catch {
				return { ok: false, code: "bridge-failed" };
			}
		},
		async status({ token }) {
			const parsed = parseJobStatus({ value: await call(() => raw.status({ token })) });
			if (!parsed) throw new LinkBridgeError({ bridgeCode: null });
			return parsed;
		},
		async cancel({ token }) {
			return (await call(() => raw.cancel({ token }))) === true;
		},
		async read({ token, offset, length }) {
			const bytes = await call(() => raw.read({ token, offset, length }));
			if (!isUint8Array(bytes) || bytes.byteLength < 1 || bytes.byteLength > length) {
				throw new LinkBridgeError({ bridgeCode: null });
			}
			return bytes;
		},
		async release({ token }) {
			return (await call(() => raw.release({ token }))) === true;
		},
		async checkUpdate() {
			const { checkUpdate } = raw;
			if (typeof checkUpdate !== "function") return null;
			try {
				const version: unknown = await checkUpdate.call(raw);
				return isReleaseTag(version) ? version : null;
			} catch {
				return null;
			}
		},
		async updateTool() {
			const { updateTool } = raw;
			if (typeof updateTool !== "function") return { ok: false, code: "bridge-failed" };
			try {
				return parseUpdateResult({ value: await updateTool.call(raw) });
			} catch {
				return { ok: false, code: "bridge-failed" };
			}
		},
	};
}
