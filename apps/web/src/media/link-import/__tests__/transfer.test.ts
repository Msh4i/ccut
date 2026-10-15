import { describe, expect, test } from "bun:test";
import type { LinkImportBridge } from "../bridge";
import {
	LinkTransferError,
	TEMP_DIRECTORY,
	TRANSFER_CHUNK_BYTES,
	type TempFileStorage,
	createOpfsTempStorage,
	sweepTempFiles,
	transferToTempFile,
} from "../transfer";

// The downloaded file comes over in chunks and goes straight into a temporary file in the
// app's storage (OPFS), so the File handed to the import pipeline is disk-backed. At most one
// chunk is in the page's hands at any time: that bounds the page's memory by the chunk size.

const token = "ab".repeat(32);
const pattern = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 13 + 5) & 0xff);

/** A bridge that serves `bytes` and measures what the page holds. */
function servingBridge({ bytes, failAt = null }: { bytes: Uint8Array; failAt?: number | null }) {
	const stats = { reads: [] as Array<{ offset: number; length: number }>, inFlight: 0, maxInFlight: 0, held: 0, maxHeld: 0 };
	const bridge: Pick<LinkImportBridge, "read"> = {
		async read({ offset, length }) {
			stats.inFlight++;
			stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
			stats.reads.push({ offset, length });
			await new Promise((resolve) => setTimeout(resolve, 1));
			stats.inFlight--;
			if (failAt !== null && offset >= failAt) throw new Error("CCUT_LINK_IMPORT:READ_FAILED");
			const chunk = bytes.slice(offset, offset + length);
			stats.held += chunk.byteLength; // the page now holds this chunk
			stats.maxHeld = Math.max(stats.maxHeld, stats.held);
			return chunk;
		},
	};
	return { bridge, stats };
}

/** In-memory storage; a write "releases" the chunk (it is in the file now). */
function memoryStorage({ stats }: { stats?: { held: number } } = {}) {
	const files = new Map<string, Uint8Array[]>();
	const closed = new Set<string>();
	const aborted = new Set<string>();
	let writing = false;
	const events: string[] = [];
	const storage: TempFileStorage = {
		async create(name) {
			files.set(name, []);
			return {
				async write(chunk) {
					writing = true;
					await new Promise((resolve) => setTimeout(resolve, 1));
					files.get(name)?.push(chunk.slice());
					if (stats) stats.held -= chunk.byteLength;
					writing = false;
					events.push(`write ${chunk.byteLength}`);
				},
				async close() {
					closed.add(name);
				},
				async abort() {
					aborted.add(name);
				},
			};
		},
		async getFile(name) {
			const parts = files.get(name) ?? [];
			return new File(parts.map((part) => new Uint8Array(part)), name);
		},
		async remove(name) {
			files.delete(name);
		},
		async list() {
			return [...files.keys()];
		},
	};
	return { storage, files, closed, aborted, isWriting: () => writing, events };
}

async function bytesOf(file: File) {
	return new Uint8Array(await file.arrayBuffer());
}

describe("transferToTempFile", () => {
	test("the file arrives byte for byte, in chunks of at most the chunk size, one read at a time", async () => {
		const bytes = pattern(10_007);
		const { bridge, stats } = servingBridge({ bytes });
		const memory = memoryStorage({ stats });
		const progress: number[] = [];
		const file = await transferToTempFile({
			bridge,
			token,
			size: bytes.length,
			name: "t.mp4",
			storage: memory.storage,
			chunkBytes: 4096,
			onProgress: ({ transferredBytes }) => progress.push(transferredBytes),
		});
		expect(await bytesOf(file)).toEqual(bytes);
		expect(stats.reads).toEqual([
			{ offset: 0, length: 4096 },
			{ offset: 4096, length: 4096 },
			{ offset: 8192, length: 1815 },
		]);
		expect(stats.maxInFlight).toBe(1);
		expect(progress).toEqual([4096, 8192, 10_007]);
		expect(memory.closed.has("t.mp4")).toBe(true);
	});

	test("peak memory: the page never holds more than one chunk (each chunk is written before the next is asked for)", async () => {
		const bytes = pattern(100_000);
		const { bridge, stats } = servingBridge({ bytes });
		const memory = memoryStorage({ stats });
		const chunkBytes = 8192;
		const originalRead = bridge.read;
		bridge.read = async (request) => {
			expect(memory.isWriting()).toBe(false); // no read while a write is pending
			return originalRead(request);
		};
		await transferToTempFile({ bridge, token, size: bytes.length, name: "t.mp4", storage: memory.storage, chunkBytes });
		expect(stats.maxHeld).toBeLessThanOrEqual(chunkBytes);
		expect(stats.held).toBe(0);
	});

	test("the default chunk is 4 MiB (the main process allows up to 8 MiB)", () => {
		expect(TRANSFER_CHUNK_BYTES).toBe(4 * 1024 * 1024);
	});

	test("a failing read: the temporary file is aborted and removed, transfer-failed", async () => {
		const bytes = pattern(10_000);
		const { bridge } = servingBridge({ bytes, failAt: 4096 });
		const memory = memoryStorage();
		const error = await transferToTempFile({ bridge, token, size: bytes.length, name: "t.mp4", storage: memory.storage, chunkBytes: 4096 }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LinkTransferError);
		expect(error instanceof LinkTransferError ? error.code : null).toBe("transfer-failed");
		expect(memory.aborted.has("t.mp4")).toBe(true);
		expect(memory.files.has("t.mp4")).toBe(false);
	});

	test("a short or long chunk (not what was asked) is refused", async () => {
		for (const wrong of [100, 5000]) {
			const bridge: Pick<LinkImportBridge, "read"> = { read: async () => new Uint8Array(wrong) };
			const memory = memoryStorage();
			const error = await transferToTempFile({ bridge, token, size: 10_000, name: "t.mp4", storage: memory.storage, chunkBytes: 4096 }).catch((caught: unknown) => caught);
			expect(error instanceof LinkTransferError ? error.code : null).toBe("transfer-failed");
			expect(memory.files.size).toBe(0);
		}
	});

	test("cancel (abort signal) between chunks: no further chunk is read, removed, cancelled", async () => {
		const bytes = pattern(20_000);
		const { bridge, stats } = servingBridge({ bytes });
		const memory = memoryStorage();
		const controller = new AbortController();
		const error = await transferToTempFile({
			bridge,
			token,
			size: bytes.length,
			name: "t.mp4",
			storage: memory.storage,
			chunkBytes: 4096,
			signal: controller.signal,
			onProgress: ({ transferredBytes }) => {
				if (transferredBytes >= 8192) controller.abort();
			},
		}).catch((caught: unknown) => caught);
		expect(error instanceof LinkTransferError ? error.code : null).toBe("cancelled");
		expect(stats.reads).toHaveLength(2); // of 5: it stopped at the abort
		expect(memory.files.has("t.mp4")).toBe(false);
	});

	test("a size that is not a positive whole number is refused before anything is created", async () => {
		for (const size of [0, -1, 1.5, Number.NaN]) {
			const memory = memoryStorage();
			const error = await transferToTempFile({ bridge: servingBridge({ bytes: pattern(1) }).bridge, token, size, name: "t.mp4", storage: memory.storage }).catch((caught: unknown) => caught);
			expect(error instanceof LinkTransferError ? error.code : null).toBe("transfer-failed");
			expect(memory.files.size).toBe(0);
		}
	});
});

// A fake OPFS root: directory handles with file handles whose writables collect bytes.
function fakeOpfs() {
	const directories = new Map<string, Map<string, Uint8Array[]>>();
	const removed: string[] = [];
	const directoryHandle = (dirName: string) => {
		const entries = directories.get(dirName) ?? new Map<string, Uint8Array[]>();
		directories.set(dirName, entries);
		return {
			// OPFS's positional (name, options) shape, taken as one rest parameter.
			async getFileHandle(...[name, options]: [string, { create?: boolean }?]) {
				if (!entries.has(name)) {
					if (!options?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
					entries.set(name, []);
				}
				return {
					async createWritable() {
						const parts: Uint8Array[] = [];
						return {
							async write(chunk: Uint8Array) {
								parts.push(chunk.slice());
							},
							async close() {
								entries.set(name, parts);
							},
							async abort() {},
						};
					},
					async getFile() {
						return new File((entries.get(name) ?? []).map((part) => new Uint8Array(part)), name);
					},
				};
			},
			async removeEntry(name: string) {
				removed.push(name);
				entries.delete(name);
			},
			async *keys() {
				for (const name of [...entries.keys()]) yield name;
			},
		};
	};
	const root = {
		async getDirectoryHandle(...[name, options]: [string, { create?: boolean }?]) {
			if (!directories.has(name) && !options?.create) throw new Error("NotFoundError");
			return directoryHandle(name);
		},
	};
	return { root, directories, removed };
}

describe("createOpfsTempStorage", () => {
	test("files live in their own top-level directory, away from the projects' media directories", async () => {
		const opfs = fakeOpfs();
		const storage = createOpfsTempStorage({ getRoot: async () => opfs.root });
		const writable = await storage.create("a.mp4");
		await writable.write(new Uint8Array([1, 2, 3]));
		await writable.close();
		expect([...opfs.directories.keys()]).toEqual([TEMP_DIRECTORY]);
		expect(TEMP_DIRECTORY).toBe("ccut-link-import");
		expect(Array.from(new Uint8Array(await (await storage.getFile("a.mp4")).arrayBuffer()))).toEqual([1, 2, 3]);
		expect(await storage.list()).toEqual(["a.mp4"]);
		await storage.remove("a.mp4");
		expect(await storage.list()).toEqual([]);
	});

	test("removing a file that is not there is fine", async () => {
		const storage = createOpfsTempStorage({ getRoot: async () => fakeOpfs().root });
		await storage.remove("missing.mp4");
	});
});

describe("sweepTempFiles", () => {
	test("deletes every temporary file except the ones this page session still uses", async () => {
		const memory = memoryStorage();
		for (const name of ["old1.mp4", "old2.m4a", "current.mp4"]) {
			const writable = await memory.storage.create(name);
			await writable.close();
		}
		expect(await sweepTempFiles({ storage: memory.storage, keep: new Set(["current.mp4"]) })).toBe(2);
		expect([...memory.files.keys()]).toEqual(["current.mp4"]);
	});

	test("a storage that fails to list is not an error (nothing swept)", async () => {
		const broken: TempFileStorage = {
			create: async () => Promise.reject(new Error("no")),
			getFile: async () => Promise.reject(new Error("no")),
			remove: async () => Promise.reject(new Error("no")),
			list: async () => Promise.reject(new Error("no")),
		};
		expect(await sweepTempFiles({ storage: broken, keep: new Set() })).toBe(0);
	});
});
