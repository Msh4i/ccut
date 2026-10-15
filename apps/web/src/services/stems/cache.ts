import type { StorageAdapter } from "@/services/storage/types";
import { STEM_NAMES, type StemName, type StemSamples, type StemSet } from "./types";

// Separated stems, kept so a second run (or another stem) is instant. Mono, 22.05 kHz,
// 16-bit: about 9 MB per stem for a 200 s song. One index file holds the use time and size of
// every entry; the least recently used entries go first when the limit is exceeded. Browser
// storage inside the app's own profile: no stored project is read, rewritten or deleted.

export const STEM_CACHE_DEFAULT_LIMIT_BYTES = 500 * 1024 * 1024;
const INDEX_NAME = "index.json";

type Entry = { bytes: number; usedAt: number };
type Index = Record<string, Entry>;

export interface StemCache {
	/** One stem of an entry, or null when the entry is absent or incomplete. */
	get({ key, stem }: { key: string; stem: StemName }): Promise<StemSamples | null>;
	has({ key }: { key: string }): Promise<boolean>;
	put({ key, stems }: { key: string; stems: StemSet }): Promise<void>;
	totalBytes(): Promise<number>;
	clear(): Promise<void>;
}

async function entryId({ key }: { key: string }): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const fileName = ({ id, stem }: { id: string; stem: StemName }) => `${id}.${stem}.s16`;

function toFile({ samples, name }: { samples: StemSamples; name: string }): File {
	// A copy: the caller may hold a view into a larger buffer.
	return new File([samples.slice()], name);
}

async function toSamples({ file }: { file: File }): Promise<StemSamples | null> {
	const bytes = await file.arrayBuffer();
	if (bytes.byteLength === 0 || bytes.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
		return null;
	}
	return new Int16Array(bytes);
}

function parseIndex({ text }: { text: string }): Index {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const index: Index = {};
		for (const [id, entry] of Object.entries(parsed)) {
			if (
				/^[0-9a-f]{64}$/.test(id) &&
				typeof entry === "object" &&
				entry !== null &&
				"bytes" in entry &&
				"usedAt" in entry &&
				typeof entry.bytes === "number" &&
				typeof entry.usedAt === "number" &&
				Number.isFinite(entry.bytes) &&
				Number.isFinite(entry.usedAt)
			) {
				index[id] = { bytes: entry.bytes, usedAt: entry.usedAt };
			}
		}
		return index;
	} catch {
		return {};
	}
}

export function createStemCache({
	adapter,
	limitBytes = STEM_CACHE_DEFAULT_LIMIT_BYTES,
	now = Date.now,
}: {
	adapter: StorageAdapter<File>;
	limitBytes?: number;
	now?: () => number;
}): StemCache {
	// One writer at a time: the index is read, changed and written back as a whole.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const result = queue.then(task, task);
		queue = result.catch(() => undefined);
		return result;
	};

	async function readIndex(): Promise<Index> {
		const file = await adapter.get(INDEX_NAME);
		return file ? parseIndex({ text: await file.text() }) : {};
	}

	async function writeIndex({ index }: { index: Index }): Promise<void> {
		await adapter.set({
			key: INDEX_NAME,
			value: new File([JSON.stringify(index)], INDEX_NAME),
		});
	}

	async function removeEntry({ id }: { id: string }): Promise<void> {
		for (const stem of STEM_NAMES) {
			await adapter.remove(fileName({ id, stem }));
		}
	}

	return {
		get({ key, stem }) {
			return serial(async () => {
				const id = await entryId({ key });
				const index = await readIndex();
				if (!index[id]) return null;
				const file = await adapter.get(fileName({ id, stem }));
				const samples = file ? await toSamples({ file }) : null;
				if (!samples) return null;
				index[id] = { ...index[id], usedAt: now() };
				await writeIndex({ index });
				return samples;
			});
		},

		has({ key }) {
			return serial(async () => {
				const id = await entryId({ key });
				const index = await readIndex();
				if (!index[id]) return false;
				for (const stem of STEM_NAMES) {
					if (!(await adapter.get(fileName({ id, stem })))) return false;
				}
				return true;
			});
		},

		put({ key, stems }) {
			return serial(async () => {
				const id = await entryId({ key });
				let bytes = 0;
				for (const stem of STEM_NAMES) {
					bytes += stems[stem].byteLength;
					await adapter.set({
						key: fileName({ id, stem }),
						value: toFile({ samples: stems[stem], name: fileName({ id, stem }) }),
					});
				}
				const index = await readIndex();
				index[id] = { bytes, usedAt: now() };
				// Least recently used first; the entry just written is never the one evicted.
				const others = Object.entries(index)
					.filter(([otherId]) => otherId !== id)
					.sort((a, b) => a[1].usedAt - b[1].usedAt);
				let total = Object.values(index).reduce((sum, entry) => sum + entry.bytes, 0);
				for (const [otherId, entry] of others) {
					if (total <= limitBytes) break;
					try {
						await removeEntry({ id: otherId });
					} catch (error) {
						// A file that cannot be removed must not lose the entry just written:
						// the victim leaves the index anyway (its files stay until Clear).
						console.warn("Evicting a separated stem failed:", error);
					}
					delete index[otherId];
					total -= entry.bytes;
				}
				await writeIndex({ index });
			});
		},

		totalBytes() {
			return serial(async () =>
				Object.values(await readIndex()).reduce((sum, entry) => sum + entry.bytes, 0),
			);
		},

		clear() {
			return serial(async () => {
				await adapter.clear();
			});
		},
	};
}
