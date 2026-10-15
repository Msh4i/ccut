import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from "mediabunny";
import type { ExportFormat } from "./index";
import { bridgeErrorCode, bridgeErrorDetail, type CcutExportBridge } from "./desktop-bridge";
import { createFileErrorFor, createTooLargeForMemoryError, type ExportError } from "./errors";
import { IN_MEMORY_EXPORT_LIMIT_BYTES } from "./memory-limit";

/** What a successful export produced: a file on disk (desktop) or the bytes (browser). */
export type SinkResult =
	| { kind: "file"; displayName: string; bytes: number; revealToken: string }
	| { kind: "buffer"; buffer: ArrayBuffer; bytes: number };

/**
 * Where an export's bytes go. `target` is handed to mediabunny's `Output`.
 * `commit` is called once, only after `Output.finalize()` succeeded (never from
 * the stream's close: `Output.cancel()` closes it too, export-v2 A4). `abort`
 * may be called any number of times, at any point; after a commit it does
 * nothing, so callers can call it in a `finally`.
 */
export interface ExportSink {
	readonly target: Target;
	/** MP4 layout: "reserve" streams with the moov at the front; "in-memory" builds it in RAM. */
	readonly fastStart: "reserve" | "in-memory";
	commit(): Promise<SinkResult>;
	abort(): Promise<void>;
}

/** Writes per IPC call (each copied once into the call); mediabunny's chunked mode gathers them. */
export const DESKTOP_CHUNK_BYTES = 16 * 2 ** 20;

/**
 * While an export runs the page sends a zero-length write this often. The main
 * process drops a session that nothing was written to for hours (its window is
 * gone), and a slow export can go a long time between real writes: the first
 * one comes only when mediabunny's 16 MiB chunk fills, and an unreadable-audio
 * question waits for the user for as long as they like.
 */
export const KEEPALIVE_INTERVAL_MS = 60_000;

type IntervalId = ReturnType<typeof setInterval> | number;

export interface KeepAliveTimers {
	setInterval: ({ callback, ms }: { callback: () => void; ms: number }) => IntervalId;
	clearInterval: (id: IntervalId) => void;
}

const realKeepAliveTimers: KeepAliveTimers = {
	setInterval: ({ callback, ms }) => setInterval(callback, ms),
	clearInterval: (id) => clearInterval(id),
};

/** The suggested file name sent to the main process (it keeps 120 code points anyway and refuses over 1000 UTF-16 units). */
export const MAX_SUGGESTED_NAME_CODE_POINTS = 120;

/** `name` cut to `MAX_SUGGESTED_NAME_CODE_POINTS` code points, never through a surrogate pair. */
export function shortenSuggestedName({ name }: { name: string }): string {
	const points = Array.from(name);
	return points.length > MAX_SUGGESTED_NAME_CODE_POINTS ? points.slice(0, MAX_SUGGESTED_NAME_CODE_POINTS).join("") : name;
}

/** The bytes of `data` alone: a view into a larger buffer would send that whole buffer over IPC. */
function ownBytes({ data }: { data: Uint8Array }): Uint8Array {
	return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
}

/**
 * Streams to the main process's part file. Writes go one at a time (the
 * WritableStream serialises them) and each waits for the main process, which is
 * the back pressure that slows the encoders down instead of filling memory.
 * The first failed write is turned into a coded `ExportError` and kept: the
 * stream errors, mediabunny throws it at its next flush or at finalize.
 * From the moment the file is opened until commit, abort or a failure, a
 * keepalive (an empty write at position 0, which adds nothing to the file) is
 * sent every `KEEPALIVE_INTERVAL_MS`.
 */
export function createDesktopSink({
	bridge,
	token,
	keepAlive = realKeepAliveTimers,
}: {
	bridge: CcutExportBridge;
	token: string;
	keepAlive?: KeepAliveTimers;
}): ExportSink {
	let state: "open" | "committed" | "aborted" = "open";
	let end = 0;
	let failure: ExportError | null = null;

	const keepAliveTimer = keepAlive.setInterval({
		ms: KEEPALIVE_INTERVAL_MS,
		callback: () => {
			void (async () => {
				try {
					await bridge.write({ token, position: 0, data: new Uint8Array(0) });
				} catch {
					// The main process no longer has the session. Whatever is sent next (a write,
					// the commit) is refused with the real reason and reported from there.
					keepAlive.clearInterval(keepAliveTimer);
				}
			})();
		},
	});
	const stopKeepAlive = () => keepAlive.clearInterval(keepAliveTimer);

	const writable = new WritableStream<StreamTargetChunk>({
		write: async (chunk) => {
			if (state !== "open") throw failure ?? createFileErrorFor({ code: "WRITE_FAILED", detail: "write after the export ended" });
			const data = ownBytes({ data: chunk.data });
			try {
				await bridge.write({ token, position: chunk.position, data });
			} catch (error) {
				stopKeepAlive();
				failure ??= createFileErrorFor({
					code: bridgeErrorCode({ error }),
					detail: bridgeErrorDetail({ error, stage: "while writing" }),
					cause: error,
				});
				throw failure;
			}
			end = Math.max(end, chunk.position + data.byteLength);
		},
	});

	return {
		target: new StreamTarget(writable, { chunked: true, chunkSize: DESKTOP_CHUNK_BYTES }),
		fastStart: "reserve",
		async commit() {
			if (state !== "open") throw failure ?? createFileErrorFor({ code: "WRITE_FAILED", detail: "commit after the export ended" });
			if (failure) throw failure;
			// Whatever happens next, the main process has finished with this token.
			state = "committed";
			stopKeepAlive();
			try {
				const { displayName, bytes } = await bridge.finish({ token, totalBytes: end });
				return { kind: "file", displayName, bytes, revealToken: token };
			} catch (error) {
				throw createFileErrorFor({
					code: bridgeErrorCode({ error }),
					detail: bridgeErrorDetail({ error, stage: "while finishing" }),
					cause: error,
				});
			}
		},
		async abort() {
			stopKeepAlive();
			if (state !== "open") return;
			state = "aborted";
			try {
				await bridge.abort({ token });
			} catch {
				// Already ended by the main process (a failed write ends the session there).
			}
		},
	};
}

/** Today's path, without the desktop app: the whole file in memory, downloaded afterwards. */
export function createBufferSink(): ExportSink {
	const target = new BufferTarget();
	let state: "open" | "committed" | "aborted" = "open";
	return {
		target,
		fastStart: "in-memory",
		async commit() {
			if (state !== "open" || !target.buffer) {
				throw createFileErrorFor({ code: "WRITE_FAILED", detail: "no file was produced" });
			}
			state = "committed";
			return { kind: "buffer", buffer: target.buffer, bytes: target.buffer.byteLength };
		},
		async abort() {
			if (state === "open") state = "aborted";
		},
	};
}

/**
 * Opens the destination before any long work starts, so the save dialog comes
 * first. With the desktop bridge: the native dialog in the main process; null
 * when the user cancels it. Without it (browser): in memory, refused up front
 * when the estimate is over `IN_MEMORY_EXPORT_LIMIT_BYTES`.
 */
export async function openExportSink({
	bridge,
	format,
	suggestedName,
	estimatedBytes,
}: {
	bridge: CcutExportBridge | null;
	format: ExportFormat;
	suggestedName: string;
	estimatedBytes: number;
}): Promise<ExportSink | null> {
	if (!bridge) {
		if (estimatedBytes > IN_MEMORY_EXPORT_LIMIT_BYTES) {
			throw createTooLargeForMemoryError({ estimatedBytes, limitBytes: IN_MEMORY_EXPORT_LIMIT_BYTES });
		}
		return createBufferSink();
	}

	let result: Awaited<ReturnType<CcutExportBridge["begin"]>>;
	try {
		result = await bridge.begin({ suggestedName: shortenSuggestedName({ name: suggestedName }), container: format, estimatedBytes });
	} catch (error) {
		throw createFileErrorFor({
			code: bridgeErrorCode({ error }),
			detail: bridgeErrorDetail({ error, stage: "while opening the file" }),
			cause: error,
		});
	}
	if (result.ok) return createDesktopSink({ bridge, token: result.token });
	switch (result.reason) {
		case "cancelled":
			return null;
		case "busy":
			throw createFileErrorFor({ code: "EXPORT_BUSY", detail: "busy" });
		case "name-too-long":
			throw createFileErrorFor({ code: "NAME_TOO_LONG", detail: result.reason });
		case "invalid":
		case "dir-not-writable":
			throw createFileErrorFor({ code: "WRITE_FAILED", detail: result.reason });
	}
}
