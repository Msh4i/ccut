import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import {
	IndexedDBAdapter,
	deleteDatabase,
} from "@/services/storage/indexeddb-adapter";

interface Item {
	// set() adds the key as `id`, so reads carry it too.
	id?: string;
	name: string;
	count?: number;
}

function createAdapter({ dbName = "test-db" }: { dbName?: string } = {}) {
	return new IndexedDBAdapter<Item>({ dbName, storeName: "items" });
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});

// Do not leave this file's data behind for the next test file.
afterAll(() => {
	globalThis.indexedDB = new IDBFactory();
});

describe("IndexedDBAdapter", () => {
	test("get returns null for a missing key and for an empty store", async () => {
		const adapter = createAdapter();

		expect(await adapter.get("nope")).toBeNull();
		expect(await adapter.getAll()).toEqual([]);
		expect(await adapter.list()).toEqual([]);
	});

	test("set stores the value under key and get returns it with the id", async () => {
		const adapter = createAdapter();

		await adapter.set({ key: "a", value: { name: "first", count: 1 } });

		expect(await adapter.get("a")).toEqual({
			id: "a",
			name: "first",
			count: 1,
		});
	});

	test("set on an existing key overwrites the record", async () => {
		const adapter = createAdapter();

		await adapter.set({ key: "a", value: { name: "old", count: 1 } });
		await adapter.set({ key: "a", value: { name: "new" } });

		expect(await adapter.get("a")).toEqual({ id: "a", name: "new" });
		expect(await adapter.list()).toEqual(["a"]);
	});

	test("list returns keys and getAll returns records", async () => {
		const adapter = createAdapter();

		await adapter.set({ key: "b", value: { name: "second" } });
		await adapter.set({ key: "a", value: { name: "first" } });

		expect(await adapter.list()).toEqual(["a", "b"]);
		expect(await adapter.getAll()).toEqual([
			{ id: "a", name: "first" },
			{ id: "b", name: "second" },
		]);
	});

	test("remove deletes only the given key and tolerates a missing key", async () => {
		const adapter = createAdapter();
		await adapter.set({ key: "a", value: { name: "first" } });
		await adapter.set({ key: "b", value: { name: "second" } });

		await adapter.remove("a");
		await adapter.remove("never-existed");

		expect(await adapter.get("a")).toBeNull();
		expect(await adapter.list()).toEqual(["b"]);
	});

	test("clear empties the store", async () => {
		const adapter = createAdapter();
		await adapter.set({ key: "a", value: { name: "first" } });
		await adapter.set({ key: "b", value: { name: "second" } });

		await adapter.clear();

		expect(await adapter.getAll()).toEqual([]);
	});

	test("data persists across adapter instances of the same database", async () => {
		await createAdapter().set({ key: "a", value: { name: "first" } });

		expect(await createAdapter().get("a")).toEqual({ id: "a", name: "first" });
	});

	test("databases are isolated from each other", async () => {
		await createAdapter({ dbName: "one" }).set({
			key: "a",
			value: { name: "first" },
		});

		expect(await createAdapter({ dbName: "two" }).list()).toEqual([]);
	});

	test("keeps unicode, emoji and sql-looking keys intact", async () => {
		const adapter = createAdapter();
		const keys = ["proje-ğüşiöç-İ", "clip-🎬", "x'; DROP TABLE items;--", ""];

		for (const key of keys) {
			await adapter.set({ key, value: { name: key } });
		}

		for (const key of keys) {
			expect(await adapter.get(key)).toEqual({ id: key, name: key });
		}
		expect((await adapter.list()).sort()).toEqual([...keys].sort());
	});

	test("concurrent writes to different keys are all kept", async () => {
		const adapter = createAdapter();
		const keys = Array.from({ length: 100 }, (_, index) => `key-${index}`);

		await Promise.all(
			keys.map((key) => adapter.set({ key, value: { name: key } })),
		);

		expect(await adapter.list()).toHaveLength(100);
	});

	test("concurrent writes to the same key leave exactly one record", async () => {
		const adapter = createAdapter();

		await Promise.all(
			Array.from({ length: 20 }, (_, count) =>
				adapter.set({ key: "same", value: { name: "n", count } }),
			),
		);

		expect(await adapter.list()).toEqual(["same"]);
	});

	test("set rejects when the transaction fails to commit after the request succeeded", async () => {
		// A full disk or quota shows up when the transaction commits, after the
		// put request already reported success.
		const adapter = createAdapter();
		const originalPut = IDBObjectStore.prototype.put;
		const putSpy = spyOn(IDBObjectStore.prototype, "put").mockImplementation(
			function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
				const request = originalPut.apply(this, args);
				request.addEventListener("success", () => this.transaction.abort());
				return request;
			},
		);

		try {
			await expect(
				adapter.set({ key: "a", value: { name: "first" } }),
			).rejects.toBeDefined();
		} finally {
			putSpy.mockRestore();
		}

		expect(await adapter.get("a")).toBeNull();
	});

	test("set rejects with the transaction's own error when the commit is refused", async () => {
		const adapter = createAdapter();
		const quota = new DOMException("quota", "QuotaExceededError");
		const originalPut = IDBObjectStore.prototype.put;
		const putSpy = spyOn(IDBObjectStore.prototype, "put").mockImplementation(
			function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
				const request = originalPut.apply(this, args);
				request.addEventListener("success", () => {
					Object.defineProperty(this.transaction, "error", { value: quota });
					this.transaction.abort();
				});
				return request;
			},
		);

		try {
			await expect(
				adapter.set({ key: "a", value: { name: "first" } }),
			).rejects.toBe(quota);
		} finally {
			putSpy.mockRestore();
		}
	});

	test("rejects when the value cannot be structured-cloned", async () => {
		const adapter = new IndexedDBAdapter<Record<string, unknown>>({
			dbName: "test-db",
			storeName: "items",
		});

		await expect(
			adapter.set({ key: "bad", value: { fn: () => 1 } }),
		).rejects.toBeDefined();
		expect(await adapter.get("bad")).toBeNull();
	});
});

// Rejects when `promise` has not settled in time, instead of hanging the test.
function settlesWithin<T>({
	promise,
	ms = 500,
}: {
	promise: Promise<T>;
	ms?: number;
}): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("did not settle in time")), ms),
		),
	]);
}

describe("IndexedDBAdapter connections", () => {
	test("releases its connection after every operation", async () => {
		const adapter = createAdapter({ dbName: "release" });

		await adapter.set({ key: "a", value: { name: "first" } });
		await adapter.get("a");
		await adapter.list();
		await adapter.getAll();
		await adapter.remove("a");
		await adapter.clear();

		// An open connection would block this delete forever.
		await expect(
			settlesWithin({ promise: deleteDatabase({ dbName: "release" }) }),
		).resolves.toBeUndefined();
	});

	test("releases its connection when an operation fails", async () => {
		const adapter = new IndexedDBAdapter<Record<string, unknown>>({
			dbName: "release-failed",
			storeName: "items",
		});

		await expect(
			adapter.set({ key: "bad", value: { fn: () => 1 } }),
		).rejects.toBeDefined();

		await expect(
			settlesWithin({ promise: deleteDatabase({ dbName: "release-failed" }) }),
		).resolves.toBeUndefined();
	});

	test("rejects instead of hanging when another connection blocks the open, and lets go afterwards", async () => {
		const held = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("blocked-db", 1);
			request.onupgradeneeded = () =>
				request.result.createObjectStore("items", { keyPath: "id" });
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const upgraded = new IndexedDBAdapter<Item>({
			dbName: "blocked-db",
			storeName: "items",
			version: 2,
		});

		await expect(
			settlesWithin({ promise: upgraded.get("a") }),
		).rejects.toThrow(/blocked/i);

		// The pending open completes once the other connection closes: the
		// adapter must not keep that late connection.
		held.close();
		await expect(
			settlesWithin({ promise: deleteDatabase({ dbName: "blocked-db" }) }),
		).resolves.toBeUndefined();
	});

	test("remove rejects when the transaction fails to commit", async () => {
		const adapter = createAdapter();
		await adapter.set({ key: "a", value: { name: "first" } });
		const originalDelete = IDBObjectStore.prototype.delete;
		const deleteSpy = spyOn(
			IDBObjectStore.prototype,
			"delete",
		).mockImplementation(function (
			this: IDBObjectStore,
			...args: Parameters<IDBObjectStore["delete"]>
		) {
			const request = originalDelete.apply(this, args);
			request.addEventListener("success", () => this.transaction.abort());
			return request;
		});

		try {
			await expect(adapter.remove("a")).rejects.toBeDefined();
		} finally {
			deleteSpy.mockRestore();
		}

		expect(await adapter.get("a")).toEqual({ id: "a", name: "first" });
	});

	test("clear rejects when the transaction fails to commit", async () => {
		const adapter = createAdapter();
		await adapter.set({ key: "a", value: { name: "first" } });
		const originalClear = IDBObjectStore.prototype.clear;
		const clearSpy = spyOn(
			IDBObjectStore.prototype,
			"clear",
		).mockImplementation(function (this: IDBObjectStore) {
			const request = originalClear.apply(this);
			request.addEventListener("success", () => this.transaction.abort());
			return request;
		});

		try {
			await expect(adapter.clear()).rejects.toBeDefined();
		} finally {
			clearSpy.mockRestore();
		}

		expect(await adapter.list()).toEqual(["a"]);
	});
});

describe("deleteDatabase", () => {
	test("removes a database that has no open connections", async () => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open("to-delete", 1);
			request.onupgradeneeded = () => request.result.createObjectStore("items");
			request.onsuccess = () => {
				request.result.close();
				resolve();
			};
			request.onerror = () => reject(request.error);
		});
		expect((await indexedDB.databases()).map((db) => db.name)).toContain(
			"to-delete",
		);

		await deleteDatabase({ dbName: "to-delete" });

		expect((await indexedDB.databases()).map((db) => db.name)).not.toContain(
			"to-delete",
		);
	});

	test("resolves for a database that never existed", async () => {
		await expect(deleteDatabase({ dbName: "ghost" })).resolves.toBeUndefined();
	});
});
