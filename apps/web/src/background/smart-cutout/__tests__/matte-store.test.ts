import { expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbMatteStore } from "../matte-store";

test("IndexedDB store: frames and meta round-trip, clear removes only that run", async () => {
	const store = new IndexedDbMatteStore({ factory: new IDBFactory(), keyRange: IDBKeyRange });
	const meta = { width: 2, height: 1, fps: 30, startSeconds: 1, stride: 2, frameCount: 4, complete: true };
	await store.putMeta({ key: "a", meta });
	await store.putFrame({ key: "a", index: 0, data: Uint8Array.from([1, 2]) });
	await store.putFrame({ key: "b", index: 0, data: Uint8Array.from([9, 9]) });
	expect(await store.getMeta({ key: "a" })).toEqual(meta);
	expect([...((await store.getFrame({ key: "a", index: 0 })) ?? [])]).toEqual([1, 2]);
	await store.clear({ key: "a" });
	expect(await store.getMeta({ key: "a" })).toBeNull();
	expect(await store.getFrame({ key: "a", index: 0 })).toBeNull();
	expect(await store.getFrame({ key: "b", index: 0 })).not.toBeNull();
});
