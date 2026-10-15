import { describe, expect, test } from "bun:test";
import type { StorageAdapter } from "@/services/storage/types";
import { createStemCache } from "../cache";
import type { StemSet } from "../types";

function memoryAdapter(): StorageAdapter<File> & { files: Map<string, File> } {
	const files = new Map<string, File>();
	return {
		files,
		get: async (key) => files.get(key) ?? null,
		set: async ({ key, value }) => {
			files.set(key, value);
		},
		remove: async (key) => {
			files.delete(key);
		},
		list: async () => [...files.keys()],
		clear: async () => {
			files.clear();
		},
	};
}

function stemsOf({ samples, fill }: { samples: number; fill: number }): StemSet {
	const make = (value: number) => new Int16Array(samples).fill(value);
	return { drums: make(fill), bass: make(fill + 1), vocals: make(fill + 2), other: make(fill + 3) };
}

describe("stem cache", () => {
	test("a stored entry comes back sample for sample, an unknown key is a miss", async () => {
		const cache = createStemCache({ adapter: memoryAdapter() });
		await cache.put({ key: "song-a", stems: stemsOf({ samples: 100, fill: 10 }) });
		expect(await cache.get({ key: "song-a", stem: "bass" })).toEqual(new Int16Array(100).fill(11));
		expect(await cache.has({ key: "song-a" })).toBe(true);
		expect(await cache.get({ key: "song-b", stem: "drums" })).toBeNull();
		expect(await cache.has({ key: "song-b" })).toBe(false);
	});

	test("over the limit the least recently USED entry goes, not the oldest written", async () => {
		let clock = 0;
		const adapter = memoryAdapter();
		// Each entry is 4 stems x 100 samples x 2 bytes = 800 bytes; the limit holds two.
		const cache = createStemCache({ adapter, limitBytes: 1700, now: () => ++clock });
		await cache.put({ key: "a", stems: stemsOf({ samples: 100, fill: 1 }) });
		await cache.put({ key: "b", stems: stemsOf({ samples: 100, fill: 2 }) });
		// Using "a" makes "b" the least recently used.
		expect(await cache.get({ key: "a", stem: "drums" })).not.toBeNull();
		await cache.put({ key: "c", stems: stemsOf({ samples: 100, fill: 3 }) });
		expect(await cache.has({ key: "a" })).toBe(true);
		expect(await cache.has({ key: "b" })).toBe(false);
		expect(await cache.has({ key: "c" })).toBe(true);
		expect(await cache.totalBytes()).toBe(1600);
		// The evicted entry's files are really gone.
		expect([...adapter.files.keys()].filter((name) => name.endsWith(".s16")).length).toBe(8);
	});

	test("an entry larger than the limit is still kept (the last one written is never evicted)", async () => {
		const cache = createStemCache({ adapter: memoryAdapter(), limitBytes: 10 });
		await cache.put({ key: "big", stems: stemsOf({ samples: 100, fill: 1 }) });
		expect(await cache.has({ key: "big" })).toBe(true);
	});

	test("an entry with a missing or damaged file is a miss, not an exception", async () => {
		const adapter = memoryAdapter();
		const cache = createStemCache({ adapter });
		await cache.put({ key: "a", stems: stemsOf({ samples: 100, fill: 1 }) });
		const damaged = [...adapter.files.keys()].find((name) => name.endsWith(".vocals.s16"));
		if (!damaged) throw new Error("no vocals file");
		adapter.files.set(damaged, new File([new Uint8Array(3)], damaged));
		expect(await cache.get({ key: "a", stem: "vocals" })).toBeNull();
		adapter.files.delete(damaged);
		expect(await cache.has({ key: "a" })).toBe(false);
	});

	test("a corrupt index is treated as empty and clear empties the directory", async () => {
		const adapter = memoryAdapter();
		adapter.files.set("index.json", new File(["{not json"], "index.json"));
		const cache = createStemCache({ adapter });
		expect(await cache.totalBytes()).toBe(0);
		await cache.put({ key: "a", stems: stemsOf({ samples: 10, fill: 1 }) });
		await cache.clear();
		expect(adapter.files.size).toBe(0);
		expect(await cache.has({ key: "a" })).toBe(false);
	});

	test("an eviction that fails still keeps the entry just written and drops the victim from the index", async () => {
		let clock = 0;
		const adapter = memoryAdapter();
		const cache = createStemCache({ adapter, limitBytes: 900, now: () => ++clock });
		await cache.put({ key: "old", stems: stemsOf({ samples: 100, fill: 1 }) });
		const remove = adapter.remove;
		adapter.remove = async (key) => {
			if (key.endsWith(".drums.s16")) throw new Error("locked");
			await remove(key);
		};
		await cache.put({ key: "new", stems: stemsOf({ samples: 100, fill: 2 }) });
		expect(await cache.has({ key: "new" })).toBe(true);
		expect(await cache.get({ key: "old", stem: "bass" })).toBeNull();
		expect(await cache.totalBytes()).toBe(800);
	});
});
