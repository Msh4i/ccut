import type { LinkImportBridge } from "./bridge";

// The downloaded file comes from the main process in chunks (window.ccutLinkImport.read) and
// goes straight into a temporary file in the app's storage (OPFS), so the File handed to the
// import pipeline is disk-backed and the page never holds the whole file. One chunk at a time:
// the next read is asked for only after the previous chunk was written, so the page holds at
// most one chunk (TRANSFER_CHUNK_BYTES) of the download.
//
// The temporary files live in their own top-level OPFS directory, never inside a project's
// media directory. A file stays while this page session may still use it (the imported
// asset's File points at it until the app is reloaded; the project keeps its own copy) and is
// swept the next time the media panel opens in a new session.

export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
export const TEMP_DIRECTORY = "ccut-link-import";

export interface TempWritable {
	write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}

export interface TempFileStorage {
	create(name: string): Promise<TempWritable>;
	getFile(name: string): Promise<File>;
	remove(name: string): Promise<void>;
	list(): Promise<string[]>;
}

export class LinkTransferError extends Error {
	readonly code: "transfer-failed" | "cancelled";

	constructor({ code }: { code: "transfer-failed" | "cancelled" }) {
		super(`link import transfer: ${code}`);
		this.name = "LinkTransferError";
		this.code = code;
	}
}

// Realm-independent (the bytes are made by the desktop bridge); a SharedArrayBuffer is refused.
function isArrayBuffer(value: ArrayBufferLike): value is ArrayBuffer {
	return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

/** Copies the job's file into `storage` under `name` and returns it as a (disk-backed) File. */
export async function transferToTempFile({
	bridge,
	token,
	size,
	name,
	storage,
	chunkBytes = TRANSFER_CHUNK_BYTES,
	onProgress,
	signal,
}: {
	bridge: Pick<LinkImportBridge, "read">;
	token: string;
	size: number;
	name: string;
	storage: TempFileStorage;
	chunkBytes?: number;
	onProgress?: (progress: { transferredBytes: number; totalBytes: number }) => void;
	signal?: AbortSignal;
}): Promise<File> {
	if (!Number.isSafeInteger(size) || size < 1) {
		throw new LinkTransferError({ code: "transfer-failed" });
	}
	const writable = await storage.create(name);
	try {
		let offset = 0;
		const rounds = Math.ceil(size / chunkBytes);
		for (let round = 0; round < rounds && offset < size; round++) {
			if (signal?.aborted) throw new LinkTransferError({ code: "cancelled" });
			const length = Math.min(chunkBytes, size - offset);
			const chunk = await bridge.read({ token, offset, length });
			const buffer = chunk.buffer;
			if (chunk.byteLength !== length || !isArrayBuffer(buffer)) {
				throw new LinkTransferError({ code: "transfer-failed" });
			}
			// Written (and let go) before the next chunk is asked for. A view, not a copy.
			await writable.write(new Uint8Array(buffer, chunk.byteOffset, chunk.byteLength));
			offset += length;
			onProgress?.({ transferredBytes: offset, totalBytes: size });
		}
		if (offset !== size) throw new LinkTransferError({ code: "transfer-failed" });
		if (signal?.aborted) throw new LinkTransferError({ code: "cancelled" });
		await writable.close();
	} catch (error) {
		await writable.abort().catch(() => {});
		await storage.remove(name).catch(() => {});
		if (error instanceof LinkTransferError) throw error;
		throw new LinkTransferError({ code: "transfer-failed" });
	}
	return storage.getFile(name);
}

interface WritableLike {
	write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}

interface FileHandleLike {
	createWritable(): Promise<WritableLike>;
	getFile(): Promise<File>;
}

interface DirectoryLike {
	getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
	removeEntry(name: string): Promise<void>;
	keys(): AsyncIterable<string>;
}

interface RootLike {
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike>;
}

/** The temporary files in OPFS (`navigator.storage.getDirectory()` in the app). */
export function createOpfsTempStorage({
	getRoot,
}: {
	getRoot: () => Promise<RootLike>;
}): TempFileStorage {
	const directory = async () =>
		(await getRoot()).getDirectoryHandle(TEMP_DIRECTORY, { create: true });
	return {
		async create(name) {
			const handle = await (await directory()).getFileHandle(name, { create: true });
			return handle.createWritable();
		},
		async getFile(name) {
			const handle = await (await directory()).getFileHandle(name);
			return handle.getFile();
		},
		async remove(name) {
			try {
				await (await directory()).removeEntry(name);
			} catch {
				// Already gone.
			}
		},
		async list() {
			const names: string[] = [];
			for await (const name of (await directory()).keys()) names.push(name);
			return names;
		},
	};
}

/** Deletes temporary files left by earlier sessions; returns how many were deleted. */
export async function sweepTempFiles({
	storage,
	keep,
}: {
	storage: TempFileStorage;
	keep: ReadonlySet<string>;
}): Promise<number> {
	let names: string[];
	try {
		names = await storage.list();
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (keep.has(name)) continue;
		try {
			await storage.remove(name);
			removed++;
		} catch {
			// Try again next time.
		}
	}
	return removed;
}
