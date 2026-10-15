import { LIMITS, MAX_STORED_RUNS, SMART_CUTOUT_MODEL } from "./constants";
import type { SequenceMeta } from "./matte-sequence";

/**
 * Where finished mattes are kept between sessions: IndexedDB, keyed by the media, the trimmed
 * range, the model and the model file's SHA-256 (a different model or file never reuses them).
 * Never in the project JSON.
 */
export function matteKey({
	mediaId,
	trimStartTicks,
	trimEndTicks,
	modelId = SMART_CUTOUT_MODEL.id,
	modelSha256 = SMART_CUTOUT_MODEL.sha256,
}: {
	mediaId: string;
	trimStartTicks: number;
	trimEndTicks: number;
	modelId?: string;
	modelSha256?: string;
}): string {
	return `${mediaId}|${trimStartTicks}-${trimEndTicks}|${modelId}|${modelSha256}`;
}

export type StoredMeta = SequenceMeta & { complete: boolean; usedAt?: number };

export interface MatteStore {
	getMeta({ key }: { key: string }): Promise<StoredMeta | null>;
	putMeta({ key, meta }: { key: string; meta: StoredMeta }): Promise<void>;
	getFrame({ key, index }: { key: string; index: number }): Promise<Uint8Array | null>;
	putFrame({ key, index, data }: { key: string; index: number; data: Uint8Array }): Promise<void>;
	/** Removes the whole run. */
	clear({ key }: { key: string }): Promise<void>;
	/** Every stored run's key and meta (for pruning). */
	listMetas(): Promise<Array<{ key: string; meta: StoredMeta }>>;
}

export class MemoryMatteStore implements MatteStore {
	readonly entries = new Map<string, unknown>();
	async getMeta({ key }: { key: string }) {
		const value = this.entries.get(`${key}#meta`);
		return isStoredMeta(value) ? value : null;
	}
	async putMeta({ key, meta }: { key: string; meta: StoredMeta }) {
		this.entries.set(`${key}#meta`, meta);
	}
	async getFrame({ key, index }: { key: string; index: number }) {
		const value = this.entries.get(`${key}#${index}`);
		return value instanceof Uint8Array ? value : null;
	}
	async putFrame({ key, index, data }: { key: string; index: number; data: Uint8Array }) {
		this.entries.set(`${key}#${index}`, data);
	}
	async listMetas() {
		const found: Array<{ key: string; meta: StoredMeta }> = [];
		for (const [name, value] of this.entries) if (name.endsWith("#meta") && isStoredMeta(value)) found.push({ key: name.slice(0, -5), meta: value });
		return found;
	}
	async clear({ key }: { key: string }) {
		for (const name of [...this.entries.keys()]) if (name.startsWith(`${key}#`)) this.entries.delete(name);
	}
}

const isInt = ({ value, min, max }: { value: unknown; min: number; max: number }) =>
	typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** A stored meta is trusted only when every number is a sane integer or rate (a damaged entry means "not stored"). */
export function isStoredMeta(value: unknown): value is StoredMeta {
	if (typeof value !== "object" || value === null) return false;
	const get = (name: string): unknown => Reflect.get(value, name);
	const fps = get("fps");
	const start = get("startSeconds");
	return (
		isInt({ value: get("width"), min: 1, max: LIMITS.maxSide }) &&
		isInt({ value: get("height"), min: 1, max: LIMITS.maxSide }) &&
		typeof fps === "number" && Number.isFinite(fps) && fps > 0 && fps <= LIMITS.maxFps &&
		typeof start === "number" && Number.isFinite(start) && start >= 0 &&
		isInt({ value: get("stride"), min: 1, max: LIMITS.maxStride }) &&
		isInt({ value: get("frameCount"), min: 1, max: LIMITS.maxFrames }) &&
		typeof get("complete") === "boolean"
	);
}

/** The keys to delete so that at most `keep` runs stay: the least recently used first; `protect` is never deleted. */
export function runsToEvict({
	metas,
	keep = MAX_STORED_RUNS,
	protect,
}: {
	metas: ReadonlyArray<{ key: string; meta: StoredMeta }>;
	keep?: number;
	protect: string;
}): string[] {
	const others = metas.filter((entry) => entry.key !== protect).sort((a, b) => (a.meta.usedAt ?? 0) - (b.meta.usedAt ?? 0));
	return others.slice(0, Math.max(0, metas.length - keep)).map((entry) => entry.key);
}

const DB_NAME = "ccut-smart-cutout";
const STORE = "mattes";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export class IndexedDbMatteStore implements MatteStore {
	private db: Promise<IDBDatabase> | null = null;

	private readonly factory: IDBFactory;
	private readonly keyRange: typeof IDBKeyRange;

	constructor({ factory, keyRange }: { factory: IDBFactory; keyRange: typeof IDBKeyRange }) {
		this.factory = factory;
		this.keyRange = keyRange;
	}

	private open(): Promise<IDBDatabase> {
		this.db ??= new Promise((resolve, reject) => {
			const opening = this.factory.open(DB_NAME, 1);
			opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => reject(opening.error);
		});
		return this.db;
	}

	private async store(mode: IDBTransactionMode) {
		return (await this.open()).transaction(STORE, mode).objectStore(STORE);
	}

	async getMeta({ key }: { key: string }) {
		const value: unknown = await request((await this.store("readonly")).get(`${key}#meta`));
		return isStoredMeta(value) ? value : null;
	}
	async putMeta({ key, meta }: { key: string; meta: StoredMeta }) {
		await request((await this.store("readwrite")).put(meta, `${key}#meta`));
	}
	async getFrame({ key, index }: { key: string; index: number }) {
		const value: unknown = await request((await this.store("readonly")).get(`${key}#${index}`));
		return value instanceof Uint8Array ? value : null;
	}
	async putFrame({ key, index, data }: { key: string; index: number; data: Uint8Array }) {
		await request((await this.store("readwrite")).put(data, `${key}#${index}`));
	}
	async clear({ key }: { key: string }) {
		// every entry of this run starts with "<key>#"
		await request((await this.store("readwrite")).delete(this.keyRange.bound(`${key}#`, `${key}#￿`)));
	}

	async listMetas() {
		const found: Array<{ key: string; meta: StoredMeta }> = [];
		const range = this.keyRange.bound("", "\uffff");
		const keys: unknown[] = await request((await this.store("readonly")).getAllKeys(range));
		for (const name of keys) {
			if (typeof name !== "string" || !name.endsWith("#meta")) continue;
			const value: unknown = await request((await this.store("readonly")).get(name));
			if (isStoredMeta(value)) found.push({ key: name.slice(0, -5), meta: value });
		}
		return found;
	}
}
