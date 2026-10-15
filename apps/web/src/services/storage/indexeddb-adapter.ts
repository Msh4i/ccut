import type { StorageAdapter } from "./types";

export class IndexedDBAdapter<T> implements StorageAdapter<T> {
	private dbName: string;
	private storeName: string;
	private version: number;

	constructor({
		dbName,
		storeName,
		version = 1,
	}: {
		dbName: string;
		storeName: string;
		version?: number;
	}) {
		this.dbName = dbName;
		this.storeName = storeName;
		this.version = version;
	}

	private async getDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, this.version);
			let isSettled = false;

			request.onerror = () => {
				isSettled = true;
				reject(request.error);
			};
			// Another connection (an old tab) holds the database and blocks the open.
			request.onblocked = () => {
				isSettled = true;
				reject(
					new DOMException(
						`Opening "${this.dbName}" is blocked by another tab.`,
						"InvalidStateError",
					),
				);
			};
			request.onsuccess = () => {
				const db = request.result;
				if (isSettled) {
					// The caller already gave up on this open: do not keep the connection.
					db.close();
					return;
				}
				isSettled = true;
				// Let another tab upgrade or delete the database.
				db.onversionchange = () => db.close();
				resolve(db);
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName, { keyPath: "id" });
				}
			};
		});
	}

	// One connection and one transaction per operation. Settles when the
	// transaction does, not when the request does: a full disk or quota only
	// shows up when the transaction commits, after the request reported success.
	// The connection is always released.
	private async run<R>({
		mode,
		operation,
	}: {
		mode: IDBTransactionMode;
		operation: (store: IDBObjectStore) => IDBRequest<R>;
	}): Promise<R> {
		const db = await this.getDB();

		return new Promise<R>((resolve, reject) => {
			let result: { value: R } | null = null;
			try {
				const transaction = db.transaction([this.storeName], mode);
				transaction.oncomplete = () => {
					db.close();
					if (result) {
						resolve(result.value);
					} else {
						reject(new DOMException("No result", "UnknownError"));
					}
				};
				transaction.onabort = () => {
					db.close();
					reject(
						transaction.error ??
							new DOMException("The transaction was aborted", "AbortError"),
					);
				};

				const request = operation(transaction.objectStore(this.storeName));
				request.onsuccess = () => {
					result = { value: request.result };
				};
				request.onerror = () => reject(request.error);
			} catch (error) {
				db.close();
				reject(error);
			}
		});
	}

	async get(key: string): Promise<T | null> {
		const result = await this.run<T | undefined>({
			mode: "readonly",
			operation: (store) => store.get(key),
		});
		return result || null;
	}

	async set({
		key,
		value,
	}: {
		key: string;
		value: T;
	}): Promise<void> {
		await this.run({
			mode: "readwrite",
			operation: (store) => store.put({ id: key, ...value }),
		});
	}

	async remove(key: string): Promise<void> {
		await this.run({
			mode: "readwrite",
			operation: (store) => store.delete(key),
		});
	}

	async list(): Promise<string[]> {
		const keys = await this.run({
			mode: "readonly",
			operation: (store) => store.getAllKeys(),
		});
		return keys as string[];
	}

	async getAll(): Promise<T[]> {
		const items = await this.run({
			mode: "readonly",
			operation: (store) => store.getAll(),
		});
		return items || [];
	}

	async clear(): Promise<void> {
		await this.run({
			mode: "readwrite",
			operation: (store) => store.clear(),
		});
	}
}

export async function deleteDatabase({
	dbName,
}: {
	dbName: string;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(dbName);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}
