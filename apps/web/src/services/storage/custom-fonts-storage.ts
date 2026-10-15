import type { CustomFontRecord } from "@/fonts/types";
import { IndexedDBAdapter } from "./indexeddb-adapter";

const adapter = new IndexedDBAdapter<CustomFontRecord>({
	dbName: "video-editor-fonts",
	storeName: "fonts",
	version: 1,
});

export const customFontsStorage = {
	list: (): Promise<CustomFontRecord[]> => adapter.getAll(),
	save: ({ record }: { record: CustomFontRecord }): Promise<void> =>
		adapter.set({ key: record.id, value: record }),
	remove: ({ id }: { id: string }): Promise<void> => adapter.remove(id),
};
