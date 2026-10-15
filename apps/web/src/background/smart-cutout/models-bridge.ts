import { SMART_CUTOUT_MODEL } from "./constants";

/**
 * `window.ccutModels`, set by the desktop app's preload (apps/electron/models-ipc.js). Whatever comes
 * back is checked here before the page uses it; a browser (no bridge) gets null.
 */
export type ModelStatus = {
	installed: boolean;
	installing: boolean;
	percent: number | null;
	sizeBytes: number;
};

export type ModelInstallCode =
	| "consent-declined"
	| "busy"
	| "download-failed"
	| "verify-failed"
	| "install-failed"
	| "cancelled"
	| "bridge-failed";

export interface ModelsBridge {
	status(): Promise<ModelStatus | null>;
	install(): Promise<{ ok: true } | { ok: false; code: ModelInstallCode }>;
	cancelInstall(): Promise<boolean>;
	remove(): Promise<boolean>;
	/** The verified model file, or null when it is missing or does not match the pin. */
	read(): Promise<Uint8Array | null>;
}

const METHODS = ["status", "install", "cancelInstall", "remove", "read"] as const;
const INSTALL_CODES: readonly ModelInstallCode[] = [
	"consent-declined",
	"busy",
	"download-failed",
	"verify-failed",
	"install-failed",
	"cancelled",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseModelStatus({ value }: { value: unknown }): ModelStatus | null {
	if (!isRecord(value)) return null;
	const { installed, installing, percent, sizeBytes } = value;
	if (typeof installed !== "boolean" || typeof installing !== "boolean") return null;
	if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null;
	if (percent !== null && (typeof percent !== "number" || !(percent >= 0 && percent <= 100))) return null;
	return { installed, installing, percent, sizeBytes };
}

export function parseInstallResult({ value }: { value: unknown }): { ok: true } | { ok: false; code: ModelInstallCode } {
	if (isRecord(value)) {
		if (value.ok === true) return { ok: true };
		const { code } = value;
		const known = INSTALL_CODES.find((candidate) => candidate === code);
		if (value.ok === false && known) return { ok: false, code: known };
	}
	return { ok: false, code: "bridge-failed" };
}

// Realm-independent: bytes made in the preload's world are not `instanceof` here.
function isUint8Array(value: unknown): value is Uint8Array {
	return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isRawBridge(value: unknown): value is Record<(typeof METHODS)[number], (request: unknown) => Promise<unknown>> {
	if (typeof value !== "object" || value === null) return false;
	return METHODS.every((name) => typeof Reflect.get(value, name) === "function");
}

export function getModelsBridge({ scope = globalThis }: { scope?: object } = {}): ModelsBridge | null {
	const raw: unknown = Reflect.get(scope, "ccutModels");
	if (!isRawBridge(raw)) return null;
	const request = { modelId: SMART_CUTOUT_MODEL.id };
	return {
		async status() {
			try {
				return parseModelStatus({ value: await raw.status(request) });
			} catch {
				return null;
			}
		},
		async install() {
			try {
				return parseInstallResult({ value: await raw.install(request) });
			} catch {
				return { ok: false, code: "bridge-failed" };
			}
		},
		async cancelInstall() {
			try {
				const answer = await raw.cancelInstall(request);
				return isRecord(answer) && answer.ok === true;
			} catch {
				return false;
			}
		},
		async remove() {
			try {
				const answer = await raw.remove(request);
				return isRecord(answer) && answer.ok === true;
			} catch {
				return false;
			}
		},
		async read() {
			try {
				const bytes = await raw.read(request);
				return isUint8Array(bytes) && bytes.byteLength === SMART_CUTOUT_MODEL.sizeBytes ? bytes : null;
			} catch {
				return null;
			}
		},
	};
}
