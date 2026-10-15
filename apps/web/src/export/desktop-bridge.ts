import type { ExportFormat } from "./index";
import type { FileErrorCode } from "./errors";

// `window.ccutExport`, set by the desktop app's preload (apps/electron/preload.js).
// The page never names a path: `begin` opens the native save dialog in the main
// process and only a token and the file's display name come back.

export type BeginResult =
	| { ok: true; token: string; displayName: string }
	| { ok: false; reason: "cancelled" | "busy" | "invalid" | "dir-not-writable" | "name-too-long" };

export interface CcutExportBridge {
	begin(request: { suggestedName: string; container: ExportFormat; estimatedBytes: number }): Promise<BeginResult>;
	/** Rejects on any failure; the main process has then ended the session and deleted its part file. */
	write(request: { token: string; position: number; data: Uint8Array }): Promise<void>;
	finish(request: { token: string; totalBytes: number }): Promise<{ displayName: string; bytes: number }>;
	abort(request: { token: string }): Promise<void>;
	/** Shows a COMPLETED export in the file manager; false for anything else. */
	reveal(request: { token: string }): Promise<boolean>;
}

const BRIDGE_METHODS = ["begin", "write", "finish", "abort", "reveal"] as const;

function isBridge(value: unknown): value is CcutExportBridge {
	if (typeof value !== "object" || value === null) return false;
	return BRIDGE_METHODS.every((name) => typeof Reflect.get(value, name) === "function");
}

/** The desktop bridge, or null in a browser (or a desktop build without it). */
export function getDesktopExportBridge({
	scope = globalThis,
}: { scope?: object } = {}): CcutExportBridge | null {
	const candidate: unknown = Reflect.get(scope, "ccutExport");
	return isBridge(candidate) ? candidate : null;
}

function messageOf({ error }: { error: unknown }): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The code a rejected bridge call carries. Electron wraps the main process's
 * error ("Error invoking remote method 'ccut-export:write': ExportIpcError:
 * CCUT_EXPORT:DISK_FULL"), so the code is looked for inside the message.
 * A session the main process no longer has (UNKNOWN_SESSION: it expired, or
 * was closed with the page) is told apart; the rest is a write failure.
 */
export function bridgeErrorCode({ error }: { error: unknown }): FileErrorCode {
	const code = /CCUT_EXPORT:([A-Z_]+)/.exec(messageOf({ error }))?.[1];
	if (code === "DISK_FULL" || code === "VERIFY_FAILED") return code;
	if (code === "UNKNOWN_SESSION") return "SESSION_EXPIRED";
	return "WRITE_FAILED";
}

const MAX_DETAIL_MESSAGE_CHARS = 120;

/**
 * The technical line of a failed bridge call, for the copyable error text:
 * `stage` and the bridge's own code ("while writing (CCUT_EXPORT:FORBIDDEN)"),
 * or, when the error is not the main process's (a clone error in the real
 * window, say), what it said. This is how a failure that the user-facing
 * message flattens (FORBIDDEN, INVALID) stays diagnosable.
 */
export function bridgeErrorDetail({ error, stage }: { error: unknown; stage: string }): string {
	const message = messageOf({ error });
	const code = /CCUT_EXPORT:[A-Z_]+/.exec(message)?.[0];
	return `${stage} (${code ?? (message.slice(0, MAX_DETAIL_MESSAGE_CHARS) || "no message")})`;
}
