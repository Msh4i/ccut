import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { CustomFontRecord, FontAtlas } from "../types";
import { bufferFromAscii, buildSfnt, WINDOWS_ENGLISH } from "./sfnt-builder";
import { stubGlobals } from "./stub-globals";

// --- browser and storage stand-ins -----------------------------------------

const stored = new Map<string, unknown>();
const saved: CustomFontRecord[] = [];
const calls: string[] = [];
const storage = {
	list: mock(async (): Promise<unknown[]> => [...stored.values()]),
	save: mock(async ({ record }: { record: CustomFontRecord }) => {
		calls.push("save");
		saved.push(record);
		stored.set(record.id, record);
	}),
	remove: mock(async ({ id }: { id: string }) => {
		stored.delete(id);
	}),
};
mock.module("../../services/storage/custom-fonts-storage", () => ({
	customFontsStorage: storage,
}));

class FakeFontFace {
	static failFamilies = new Set<string>();
	// eslint-disable-next-line opencut/prefer-object-params -- mirrors the positional DOM FontFace constructor.
	constructor(
		readonly family: string,
		readonly data: ArrayBuffer,
		readonly descriptors: { weight: string; style: string },
	) {}
	async load() {
		if (FakeFontFace.failFamilies.has(this.family)) {
			throw new Error("OTS parsing error");
		}
		calls.push("load");
		return this;
	}
}

interface FakeLink {
	href: string;
	removed: boolean;
	listeners: Record<string, () => void>;
	addEventListener: (type: string, listener: () => void) => void;
	remove: () => void;
}

const registered: FakeFontFace[] = [];
const links: FakeLink[] = [];
let linkEvent: "load" | "error" = "load";
const fakeDocument = {
	createElement: (): FakeLink => {
		const link: FakeLink = {
			href: "",
			removed: false,
			listeners: {},
			// eslint-disable-next-line opencut/prefer-object-params -- mirrors DOM addEventListener(type, listener).
			addEventListener: (type, listener) => {
				link.listeners[type] = listener;
			},
			remove: () => {
				link.removed = true;
			},
		};
		return link;
	},
	head: {
		appendChild: (link: FakeLink) => {
			links.push(link);
			queueMicrotask(() => link.listeners[linkEvent]?.());
		},
	},
	fonts: {
		load: async () => [{}],
		add: (face: FakeFontFace) => {
			calls.push("add");
			registered.push(face);
		},
		delete: (face: FakeFontFace) => {
			const index = registered.indexOf(face);
			if (index >= 0) registered.splice(index, 1);
			return index >= 0;
		},
	},
};

const ATLAS: FontAtlas = {
	fonts: {
		Roboto: { x: 0, y: 0, w: 1, ch: 0, s: ["400", "700"] },
		Lobster: { x: 0, y: 0, w: 1, ch: 0, s: ["400"] },
	},
};

let atlasUp = true;
let fetchCalls = 0;
const restoreGlobals: (() => void)[] = [];

function installBrowser() {
	restoreGlobals.push(
		stubGlobals({
			stubs: {
				FontFace: FakeFontFace,
				document: fakeDocument,
				Image: class {
					src = "";
				},
				fetch: async () => {
					fetchCalls += 1;
					return atlasUp
						? { ok: true, json: async () => ATLAS }
						: { ok: false, status: 503 };
				},
			},
		}),
	);
}

function stubStorageEstimate({
	quota,
	usage,
}: {
	quota: number;
	usage: number;
}) {
	restoreGlobals.push(
		stubGlobals({
			stubs: {
				navigator: { storage: { estimate: async () => ({ quota, usage }) } },
			},
		}),
	);
}

const { useCustomFontsStore } = await import("../custom-fonts-store");

// Each test gets a fresh module instance, so registration state never leaks.
let instance = 0;
async function loadFontModules() {
	const custom: typeof import("../custom-fonts") = await import(
		`../custom-fonts?${++instance}`
	);
	const { clearFontAtlasCache } = await import("../google-fonts");
	clearFontAtlasCache();
	return { ...custom, useCustomFontsStore };
}

function fontFile({
	name = "Merriweather-Bold.ttf",
	family = "Merriweather",
	weightClass = 700,
}: { name?: string; family?: string; weightClass?: number } = {}) {
	const buffer = buildSfnt({
		names: [{ ...WINDOWS_ENGLISH, nameID: 1, text: family }],
		weightClass,
	});
	return new File([buffer], name);
}

function buildRecord(overrides: Partial<CustomFontRecord> = {}) {
	const record: CustomFontRecord = {
		schema: 1,
		id: crypto.randomUUID(),
		family: "Stored",
		weight: 400,
		style: "normal",
		format: "ttf",
		fileName: "stored.ttf",
		size: 4,
		addedAt: 1,
		data: new ArrayBuffer(4),
		...overrides,
	};
	return record;
}

function storedRecord(overrides: Partial<CustomFontRecord> = {}) {
	const record = buildRecord(overrides);
	stored.set(record.id, record);
	return record;
}

beforeEach(() => {
	stored.clear();
	saved.length = 0;
	calls.length = 0;
	registered.length = 0;
	links.length = 0;
	linkEvent = "load";
	atlasUp = true;
	fetchCalls = 0;
	FakeFontFace.failFamilies.clear();
	storage.list.mockClear();
	storage.save.mockClear();
	storage.remove.mockClear();
	useCustomFontsStore.setState({
		fonts: [],
		version: 0,
		isImporting: false,
		loadError: false,
	});
	installBrowser();
});

afterEach(() => {
	while (restoreGlobals.length > 0) restoreGlobals.pop()?.();
});

// --- pure helpers ------------------------------------------------------------

describe("buildFontKey", () => {
	it("ignores family case but not weight or style", async () => {
		const { buildFontKey } = await loadFontModules();
		const key = buildFontKey({
			family: "MyFont",
			weight: 400,
			style: "normal",
		});
		expect(
			buildFontKey({ family: "myfont", weight: 400, style: "normal" }),
		).toBe(key);
		expect(
			buildFontKey({ family: "MyFont", weight: 700, style: "normal" }),
		).not.toBe(key);
		expect(
			buildFontKey({ family: "MyFont", weight: 400, style: "italic" }),
		).not.toBe(key);
	});
});

describe("resolveFamilyCollision", () => {
	it("renames families that collide with system or Google fonts, ignoring case", async () => {
		const { resolveFamilyCollision } = await loadFontModules();
		expect(resolveFamilyCollision({ family: "Arial", atlas: ATLAS })).toBe(
			"Arial (Custom)",
		);
		expect(resolveFamilyCollision({ family: "roboto", atlas: ATLAS })).toBe(
			"roboto (Custom)",
		);
		expect(resolveFamilyCollision({ family: "Serif", atlas: ATLAS })).toBe(
			"Serif (Custom)",
		);
	});

	it("keeps unique names", async () => {
		const { resolveFamilyCollision } = await loadFontModules();
		expect(
			resolveFamilyCollision({ family: "Merriweather", atlas: ATLAS }),
		).toBe("Merriweather");
	});
});

describe("getMissingFontFamilies", () => {
	it("lists families that are neither system, Google nor custom", async () => {
		const { getMissingFontFamilies } = await loadFontModules();
		expect(
			getMissingFontFamilies({
				families: ["Arial", "roboto", "Mine", "Gone", "serif"],
				atlas: ATLAS,
				customFamilies: ["Mine"],
			}),
		).toEqual({ missing: ["Gone"], unverified: [] });
	});

	it("cannot tell missing from Google while the atlas is unavailable: reports unverified", async () => {
		const { getMissingFontFamilies } = await loadFontModules();
		expect(
			getMissingFontFamilies({
				families: ["Arial", "Mine", "Roboto", "Gone"],
				atlas: null,
				customFamilies: ["Mine"],
			}),
		).toEqual({ missing: [], unverified: ["Roboto", "Gone"] });
	});

	it("returns empty lists when nothing is used", async () => {
		const { getMissingFontFamilies } = await loadFontModules();
		expect(
			getMissingFontFamilies({
				families: [],
				atlas: ATLAS,
				customFamilies: [],
			}),
		).toEqual({ missing: [], unverified: [] });
	});
});

// --- import pipeline -----------------------------------------------------------

describe("importFontFiles", () => {
	it("loads, stores, registers and lists a valid font, in that order", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();

		const [result] = await importFontFiles({ files: [fontFile()] });

		expect(result.ok).toBe(true);
		expect(calls).toEqual(["load", "save", "add"]);
		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({
			family: "Merriweather",
			descriptors: { weight: "700", style: "normal" },
		});
		const [record] = saved;
		expect(record).toMatchObject({
			schema: 1,
			family: "Merriweather",
			weight: 700,
			style: "normal",
			format: "ttf",
			fileName: "Merriweather-Bold.ttf",
		});
		expect(record.data.byteLength).toBe(record.size);
		const state = useCustomFontsStore.getState();
		expect(state.fonts).toHaveLength(1);
		expect(state.fonts[0]).not.toHaveProperty("data");
		expect(state.fonts[0].id).toBe(record.id);
		expect(state.isImporting).toBe(false);
	});

	it("bumps the store version once per batch, however many fonts it adds", async () => {
		const {
			importFontFiles,
			ensureCustomFontsRegistered,
			useCustomFontsStore,
		} = await loadFontModules();
		await ensureCustomFontsRegistered();
		const before = useCustomFontsStore.getState().version;

		await importFontFiles({
			files: [
				fontFile({ name: "A.ttf", family: "Alpha", weightClass: 400 }),
				fontFile({ name: "B.ttf", family: "Beta", weightClass: 400 }),
				fontFile({ name: "C.ttf", family: "Gamma", weightClass: 400 }),
			],
		});

		const state = useCustomFontsStore.getState();
		expect(state.fonts).toHaveLength(3);
		expect(state.version).toBe(before + 1);
	});

	it("leaves the version alone when nothing was added", async () => {
		const {
			importFontFiles,
			ensureCustomFontsRegistered,
			useCustomFontsStore,
		} = await loadFontModules();
		await ensureCustomFontsRegistered();
		const before = useCustomFontsStore.getState().version;

		await importFontFiles({
			files: [new File([bufferFromAscii({ text: "nope" })], "bad.ttf")],
		});

		expect(useCustomFontsStore.getState().version).toBe(before);
	});

	it("stores and registers nothing when the browser rejects the font", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();
		FakeFontFace.failFamilies.add("Merriweather");

		const [result] = await importFontFiles({ files: [fontFile()] });

		expect(result.ok).toBe(false);
		expect(storage.save).not.toHaveBeenCalled();
		expect(registered).toHaveLength(0);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(0);
	});

	it("sniffs the first bytes and never reads the rest of a file that is not a font", async () => {
		const { importFontFiles } = await loadFontModules();
		const arrayBuffer = mock(async () => new ArrayBuffer(0));
		const html = Object.assign(
			new File([bufferFromAscii({ text: "<html></html>" })], "evil.ttf"),
			{ arrayBuffer },
		);

		const [result] = await importFontFiles({ files: [html] });

		expect(result).toMatchObject({ ok: false, fileName: "evil.ttf" });
		expect(arrayBuffer).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
		expect(storage.save).not.toHaveBeenCalled();
	});

	it("rejects empty and oversized files before reading them", async () => {
		const { importFontFiles } = await loadFontModules();
		const arrayBuffer = mock(async () => new ArrayBuffer(0));
		const huge = Object.assign(new File([new ArrayBuffer(8)], "huge.ttf"), {
			arrayBuffer,
		});
		Object.defineProperty(huge, "size", { value: 20 * 1024 * 1024 + 1 });

		const results = await importFontFiles({
			files: [huge, new File([], "empty.ttf")],
		});

		expect(results.map((r) => r.ok)).toEqual([false, false]);
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("reports a file that cannot be read and keeps importing the rest", async () => {
		const { importFontFiles } = await loadFontModules();
		const logged = spyOn(console, "error").mockImplementation(() => {});
		const unreadable = Object.assign(new File([buildSfnt()], "locked.ttf"), {
			arrayBuffer: async () => {
				throw new Error("NotReadableError");
			},
		});

		const results = await importFontFiles({
			files: [
				unreadable,
				fontFile({ name: "A.ttf", family: "Alpha", weightClass: 400 }),
			],
		});

		logged.mockRestore();
		expect(results.map((r) => r.ok)).toEqual([false, true]);
		expect(results[0]).toMatchObject({ fileName: "locked.ttf" });
	});

	it("imports files independently: one bad file does not stop the others", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();
		const bad = new File([bufferFromAscii({ text: "nope" })], "bad.ttf");

		const results = await importFontFiles({
			files: [
				bad,
				fontFile({ name: "A.ttf", family: "Alpha", weightClass: 400 }),
			],
		});

		expect(results.map((r) => r.ok)).toEqual([false, true]);
		expect(useCustomFontsStore.getState().fonts.map((f) => f.family)).toEqual([
			"Alpha",
		]);
	});

	it("rejects a font that is already imported and keeps the original", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();

		await importFontFiles({ files: [fontFile()] });
		const [second] = await importFontFiles({ files: [fontFile()] });

		expect(second.ok).toBe(false);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(1);
		expect(stored.size).toBe(1);
	});

	it("rejects the same font twice inside one batch", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();

		const results = await importFontFiles({
			files: [fontFile(), fontFile()],
		});

		expect(results.map((r) => r.ok)).toEqual([true, false]);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(1);
	});

	it("groups variants of a colliding family under one renamed family", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();

		await importFontFiles({
			files: [
				fontFile({
					name: "Roboto-Regular.ttf",
					family: "Roboto",
					weightClass: 400,
				}),
				fontFile({
					name: "Roboto-Bold.ttf",
					family: "Roboto",
					weightClass: 700,
				}),
			],
		});

		const fonts = useCustomFontsStore.getState().fonts;
		expect(fonts.map((f) => [f.family, f.weight])).toEqual([
			["Roboto (Custom)", 400],
			["Roboto (Custom)", 700],
		]);
	});

	it("refuses to import while the Google catalog cannot be read, so a name is never stored unrenamed", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		atlasUp = false;
		const roboto = fontFile({
			name: "Roboto-Regular.ttf",
			family: "Roboto",
			weightClass: 400,
		});
		const arrayBuffer = mock(async () => new ArrayBuffer(0));
		Object.assign(roboto, { arrayBuffer });

		const [offline] = await importFontFiles({ files: [roboto] });

		expect(offline).toMatchObject({
			ok: false,
			reason: "Font catalog unavailable, try again.",
		});
		expect(arrayBuffer).not.toHaveBeenCalled();
		expect(stored.size).toBe(0);

		atlasUp = true;
		const [online] = await importFontFiles({
			files: [
				fontFile({
					name: "Roboto-Regular.ttf",
					family: "Roboto",
					weightClass: 400,
				}),
			],
		});
		expect(online.ok).toBe(true);
		expect(useCustomFontsStore.getState().fonts[0].family).toBe(
			"Roboto (Custom)",
		);
		warn.mockRestore();
	});

	it("stops at the font limit", async () => {
		const { importFontFiles, MAX_CUSTOM_FONTS } = await loadFontModules();
		for (let i = 0; i < MAX_CUSTOM_FONTS; i++) {
			storedRecord({ id: String(i), family: `F${i}`, addedAt: i });
		}

		const [result] = await importFontFiles({ files: [fontFile()] });

		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringContaining("limit"),
		});
		expect(storage.save).not.toHaveBeenCalled();
	});

	it("stops at the total size cap before reading the file", async () => {
		const {
			importFontFiles,
			ensureCustomFontsRegistered,
			MAX_TOTAL_FONT_BYTES,
			useCustomFontsStore,
		} = await loadFontModules();
		await ensureCustomFontsRegistered();
		useCustomFontsStore.setState({
			fonts: [
				{
					id: "big",
					family: "Big",
					weight: 400,
					style: "normal",
					format: "ttf",
					fileName: "big.ttf",
					size: MAX_TOTAL_FONT_BYTES - 10,
					addedAt: 1,
				},
			],
		});
		const arrayBuffer = mock(async () => new ArrayBuffer(0));
		const file = Object.assign(fontFile(), { arrayBuffer });

		const [result] = await importFontFiles({ files: [file] });

		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringContaining("256 MB"),
		});
		expect(arrayBuffer).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});

	it("takes at most 50 files per batch and rejects the rest", async () => {
		const { importFontFiles, MAX_FONTS_PER_BATCH, useCustomFontsStore } =
			await loadFontModules();
		const files = Array.from({ length: MAX_FONTS_PER_BATCH + 1 }, (_, i) =>
			fontFile({ name: `F${i}.ttf`, family: `Family ${i}`, weightClass: 400 }),
		);

		const results = await importFontFiles({ files });

		expect(MAX_FONTS_PER_BATCH).toBe(50);
		expect(results.filter((r) => r.ok)).toHaveLength(50);
		expect(results[50]).toMatchObject({
			ok: false,
			reason: expect.stringContaining("50"),
		});
		expect(useCustomFontsStore.getState().fonts).toHaveLength(50);
	});

	it("rejects a file when the browser has too little free storage", async () => {
		const { importFontFiles } = await loadFontModules();
		stubStorageEstimate({ quota: 100 * 1024 * 1024, usage: 99 * 1024 * 1024 });

		const [result] = await importFontFiles({ files: [fontFile()] });

		expect(result).toMatchObject({
			ok: false,
			reason: "Not enough browser storage.",
		});
		expect(storage.save).not.toHaveBeenCalled();
	});

	it("imports when the estimate shows enough room", async () => {
		const { importFontFiles } = await loadFontModules();
		stubStorageEstimate({ quota: 10 * 1024 ** 3, usage: 1024 });

		const [result] = await importFontFiles({ files: [fontFile()] });

		expect(result.ok).toBe(true);
	});

	it("explains a quota error raised while saving", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();
		storage.save.mockImplementationOnce(async () => {
			throw new DOMException("full", "QuotaExceededError");
		});

		const [result] = await importFontFiles({ files: [fontFile()] });

		expect(result).toMatchObject({
			ok: false,
			reason: "Not enough browser storage.",
		});
		expect(registered).toHaveLength(0);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(0);
	});

	it("does not register a font whose save failed", async () => {
		const { importFontFiles, useCustomFontsStore } = await loadFontModules();
		storage.save.mockImplementationOnce(async () => {
			throw new Error("disk full");
		});

		const [result] = await importFontFiles({ files: [fontFile()] });

		expect(result.ok).toBe(false);
		expect(registered).toHaveLength(0);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(0);
	});

	it("refuses a second import while one is running", async () => {
		const { importFontFiles } = await loadFontModules();

		const first = importFontFiles({ files: [fontFile()] });
		const second = await importFontFiles({
			files: [fontFile({ name: "B.ttf", family: "Beta" })],
		});
		await first;

		expect(second[0].ok).toBe(false);
		expect(stored.size).toBe(1);
	});
});

describe("removeCustomFont", () => {
	it("deletes from storage and the browser, and bumps the version", async () => {
		const { importFontFiles, removeCustomFont, useCustomFontsStore } =
			await loadFontModules();
		await importFontFiles({ files: [fontFile()] });
		const { fonts, version } = useCustomFontsStore.getState();

		await removeCustomFont({ id: fonts[0].id });

		expect(stored.size).toBe(0);
		expect(registered).toHaveLength(0);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(0);
		expect(useCustomFontsStore.getState().version).toBeGreaterThan(version);
	});

	it("removes a font that was registered at startup, not just one imported this session", async () => {
		const {
			ensureCustomFontsRegistered,
			removeCustomFont,
			useCustomFontsStore,
		} = await loadFontModules();
		const record = storedRecord();
		await ensureCustomFontsRegistered();
		expect(registered).toHaveLength(1);

		await removeCustomFont({ id: record.id });

		expect(registered).toHaveLength(0);
		expect(stored.size).toBe(0);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(0);
	});

	it("leaves everything in place when storage fails", async () => {
		const { importFontFiles, removeCustomFont, useCustomFontsStore } =
			await loadFontModules();
		await importFontFiles({ files: [fontFile()] });
		storage.remove.mockImplementationOnce(async () => {
			throw new Error("blocked");
		});

		await expect(
			removeCustomFont({ id: useCustomFontsStore.getState().fonts[0].id }),
		).rejects.toThrow("blocked");

		expect(registered).toHaveLength(1);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(1);
	});
});

describe("ensureCustomFontsRegistered", () => {
	it("registers stored fonts once, however often it is called", async () => {
		const { ensureCustomFontsRegistered, useCustomFontsStore } =
			await loadFontModules();
		storedRecord({ family: "Later", addedAt: 2 });
		storedRecord({ family: "Earlier", addedAt: 1 });

		await Promise.all([
			ensureCustomFontsRegistered(),
			ensureCustomFontsRegistered(),
		]);
		await ensureCustomFontsRegistered();

		expect(storage.list).toHaveBeenCalledTimes(1);
		expect(registered.map((f) => f.family).sort()).toEqual([
			"Earlier",
			"Later",
		]);
		expect(useCustomFontsStore.getState().fonts.map((f) => f.family)).toEqual([
			"Earlier",
			"Later",
		]);
	});

	it("keeps a record the browser rejects visible, flagged as failed and deletable", async () => {
		const {
			ensureCustomFontsRegistered,
			removeCustomFont,
			useCustomFontsStore,
		} = await loadFontModules();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		FakeFontFace.failFamilies.add("Broken");
		const broken = storedRecord({ family: "Broken", addedAt: 1 });
		storedRecord({ family: "Fine", addedAt: 2 });

		await ensureCustomFontsRegistered();

		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
		expect(registered.map((f) => f.family)).toEqual(["Fine"]);
		const fonts = useCustomFontsStore.getState().fonts;
		expect(fonts.map((f) => [f.family, f.failed === true])).toEqual([
			["Broken", true],
			["Fine", false],
		]);

		await removeCustomFont({ id: broken.id });

		expect(stored.has(broken.id)).toBe(false);
		expect(useCustomFontsStore.getState().fonts.map((f) => f.family)).toEqual([
			"Fine",
		]);
	});

	it("counts a failed record toward duplicates, so it cannot be silently re-imported", async () => {
		const { ensureCustomFontsRegistered, importFontFiles } =
			await loadFontModules();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		FakeFontFace.failFamilies.add("Merriweather");
		storedRecord({ family: "Merriweather", weight: 700 });
		await ensureCustomFontsRegistered();
		FakeFontFace.failFamilies.clear();

		const [result] = await importFontFiles({ files: [fontFile()] });

		warn.mockRestore();
		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringContaining("already imported"),
		});
	});

	it("skips records with the wrong shape instead of passing them to the browser", async () => {
		const { ensureCustomFontsRegistered, useCustomFontsStore } =
			await loadFontModules();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		storedRecord({ family: "Valid" });
		stored.set("a", { id: "a", family: 12, weight: 400, style: "normal" });
		stored.set("b", { ...buildRecord({ id: "b" }), weight: "heavy" });
		stored.set("c", { ...buildRecord({ id: "c" }), data: "not a buffer" });
		stored.set("d", { ...buildRecord({ id: "d" }), style: "oblique" });
		stored.set("e", null);
		stored.set("f", "garbage");

		await ensureCustomFontsRegistered();

		warn.mockRestore();
		expect(registered.map((f) => f.family)).toEqual(["Valid"]);
		expect(useCustomFontsStore.getState().fonts).toHaveLength(1);
	});

	it("flags a storage read failure, never throws, and retries on the next call", async () => {
		const { ensureCustomFontsRegistered, useCustomFontsStore } =
			await loadFontModules();
		const logged = spyOn(console, "error").mockImplementation(() => {});
		storage.list.mockImplementationOnce(async () => {
			throw new Error("IndexedDB unavailable");
		});
		storedRecord({ family: "Retry" });

		await expect(ensureCustomFontsRegistered()).resolves.toBe(true);
		expect(logged).toHaveBeenCalledTimes(1);
		logged.mockRestore();
		expect(useCustomFontsStore.getState().loadError).toBe(true);
		expect(registered).toHaveLength(0);

		await ensureCustomFontsRegistered();
		expect(registered.map((f) => f.family)).toEqual(["Retry"]);
		expect(useCustomFontsStore.getState().loadError).toBe(false);
	});

	it("stops waiting after 5 seconds when storage hangs", async () => {
		const { ensureCustomFontsRegistered } = await loadFontModules();
		storage.list.mockImplementationOnce(() => new Promise(() => {}));
		restoreGlobals.push(
			stubGlobals({
				stubs: {
					setTimeout: (fire: () => void, ms: number) => {
						if (ms === 5000) fire();
						return 0;
					},
					clearTimeout: () => {},
				},
			}),
		);

		await expect(ensureCustomFontsRegistered()).resolves.toBe(false);
	});

	it("says it is ready once registration has finished", async () => {
		const { ensureCustomFontsRegistered } = await loadFontModules();
		storedRecord();

		await expect(ensureCustomFontsRegistered()).resolves.toBe(true);
	});

	it("never throws even if registration itself blows up, and retries later", async () => {
		const { ensureCustomFontsRegistered, useCustomFontsStore } =
			await loadFontModules();
		const logged = spyOn(console, "error").mockImplementation(() => {});
		storage.list.mockImplementationOnce(async () =>
			Object.assign([], {
				filter: () => {
					throw new Error("boom");
				},
			}),
		);
		storedRecord({ family: "After" });

		await expect(ensureCustomFontsRegistered()).resolves.toBe(true);

		logged.mockRestore();
		expect(useCustomFontsStore.getState().loadError).toBe(true);
		await ensureCustomFontsRegistered();
		expect(registered.map((f) => f.family)).toEqual(["After"]);
		expect(useCustomFontsStore.getState().loadError).toBe(false);
	});

	it("keeps size, format and file name trustworthy whatever the stored record says", async () => {
		const { ensureCustomFontsRegistered, useCustomFontsStore } =
			await loadFontModules();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		for (const [id, size] of [
			["a", Number.NaN],
			["b", -5],
			["c", "huge"],
			["d", Number.POSITIVE_INFINITY],
		] as const) {
			stored.set(id, {
				...buildRecord({ id, family: `F${id}`, addedAt: id.charCodeAt(0) }),
				size,
				format: "exe",
				fileName: 5,
			});
		}

		await ensureCustomFontsRegistered();

		warn.mockRestore();
		const fonts = useCustomFontsStore.getState().fonts;
		expect(fonts).toHaveLength(4);
		for (const font of fonts) {
			expect(font.size).toBe(4);
			expect(font.format).toBe("ttf");
			expect(font.fileName).toBe("");
		}
	});
});

describe("registration that is still running", () => {
	function hangRegistration() {
		let finish: (records: unknown[]) => void = () => {};
		storage.list.mockImplementationOnce(
			() =>
				new Promise<unknown[]>((resolve) => {
					finish = resolve;
				}),
		);
		const restoreTimers = stubGlobals({
			stubs: {
				setTimeout: (fire: () => void, ms: number) => {
					if (ms === 5000) fire();
					return 0;
				},
				clearTimeout: () => {},
			},
		});
		restoreGlobals.push(restoreTimers);
		return { finish: (records: unknown[]) => finish(records), restoreTimers };
	}

	it("reports not ready instead of an empty library", async () => {
		const { ensureCustomFontsRegistered, useCustomFontsStore } =
			await loadFontModules();
		hangRegistration();

		expect(await ensureCustomFontsRegistered()).toBe(false);
		expect(useCustomFontsStore.getState().fonts).toEqual([]);
	});

	it("does not report installed fonts as missing while they are still loading", async () => {
		const { prepareProjectFonts } = await loadFontModules();
		hangRegistration();

		const report = await prepareProjectFonts({
			families: ["Mine", "Roboto", "Gone"],
		});

		expect(report).toMatchObject({
			customFontsLoading: true,
			missing: [],
			unverified: [],
		});
	});

	it("refuses to import, so count, size and duplicate checks cannot be bypassed", async () => {
		const { importFontFiles } = await loadFontModules();
		hangRegistration();
		const arrayBuffer = mock(async () => new ArrayBuffer(0));
		const file = Object.assign(fontFile(), { arrayBuffer });

		const [result] = await importFontFiles({ files: [file] });

		expect(result).toMatchObject({
			ok: false,
			reason: "Fonts are still loading, try again.",
		});
		expect(arrayBuffer).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});

	it("merges the late result into the store instead of overwriting it", async () => {
		const { ensureCustomFontsRegistered, useCustomFontsStore } =
			await loadFontModules();
		const hung = hangRegistration();
		await ensureCustomFontsRegistered();
		const meanwhile = {
			id: "added-meanwhile",
			family: "Meanwhile",
			weight: 400,
			style: "normal" as const,
			format: "ttf" as const,
			fileName: "m.ttf",
			size: 4,
			addedAt: 5,
		};
		useCustomFontsStore.setState({ fonts: [meanwhile] });

		hung.finish([buildRecord({ id: "late", family: "Late", addedAt: 1 })]);
		hung.restoreTimers();
		await new Promise((resolve) => setImmediate(resolve));

		const ids = useCustomFontsStore.getState().fonts.map((f) => f.id);
		expect(ids.sort()).toEqual(["added-meanwhile", "late"]);
		expect(await ensureCustomFontsRegistered()).toBe(true);
	});

	it("refuses to import when the font library could not be read", async () => {
		const { importFontFiles, ensureCustomFontsRegistered } =
			await loadFontModules();
		const logged = spyOn(console, "error").mockImplementation(() => {});
		storage.list.mockImplementation(async () => {
			throw new Error("IndexedDB unavailable");
		});
		await ensureCustomFontsRegistered();

		const [result] = await importFontFiles({ files: [fontFile()] });

		logged.mockRestore();
		storage.list.mockImplementation(async () => [...stored.values()]);
		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringContaining("could not be read"),
		});
		expect(storage.save).not.toHaveBeenCalled();
	});
});

describe("summarizeImportFailures", () => {
	it("returns nothing when every file was imported", async () => {
		const { summarizeImportFailures } = await loadFontModules();
		const font = {
			id: "1",
			family: "A",
			weight: 400,
			style: "normal" as const,
			format: "ttf" as const,
			fileName: "a.ttf",
			size: 1,
			addedAt: 1,
		};
		expect(
			summarizeImportFailures({
				results: [{ ok: true, fileName: "a.ttf", font }],
			}),
		).toBeNull();
	});

	it("makes one summary: at most five names, the distinct reasons, no control characters", async () => {
		const { summarizeImportFailures } = await loadFontModules();
		const results = Array.from({ length: 7 }, (_, i) => ({
			ok: false as const,
			fileName: `font${i}.ttf`,
			reason: i % 2 === 0 ? "The file is empty." : "Larger than 20 MB.",
		}));
		results[0].fileName = "evil\u000c\u202e.ttf";

		expect(summarizeImportFailures({ results })).toEqual({
			title: "Could not import 7 files",
			description:
				"evil.ttf, font1.ttf, font2.ttf, font3.ttf, font4.ttf and 2 more. The file is empty. Larger than 20 MB.",
		});
	});

	it("uses the singular for one file", async () => {
		const { summarizeImportFailures } = await loadFontModules();
		expect(
			summarizeImportFailures({
				results: [{ ok: false, fileName: "a.ttf", reason: "Nope." }],
			})?.title,
		).toBe("Could not import 1 file");
	});
});

// --- project open --------------------------------------------------------------

describe("prepareProjectFonts", () => {
	it("classifies first and loads only what is left: a deleted custom font never reaches Google", async () => {
		const { prepareProjectFonts } = await loadFontModules();

		const report = await prepareProjectFonts({
			families: ["Arial", "Roboto", "Deleted Custom", "serif"],
		});

		expect(report.missing).toEqual(["Deleted Custom"]);
		expect(report.failed).toEqual([]);
		expect(links).toHaveLength(1);
		expect(links[0].href).toContain("family=Roboto:");
		expect(links.map((link) => link.href).join()).not.toContain("Deleted");
	});

	it("loads installed custom fonts from the browser, not from Google", async () => {
		const { prepareProjectFonts } = await loadFontModules();
		storedRecord({ family: "Mine" });

		const report = await prepareProjectFonts({ families: ["Mine"] });

		expect(report).toMatchObject({ missing: [], unverified: [], failed: [] });
		expect(links).toHaveLength(0);
	});

	it("makes no network request and reports unverified names while the catalog is down", async () => {
		const { prepareProjectFonts } = await loadFontModules();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		atlasUp = false;
		storedRecord({ family: "Mine" });

		const report = await prepareProjectFonts({
			families: ["Arial", "Mine", "Roboto", "Gone"],
		});

		warn.mockRestore();
		expect(report.unverified).toEqual(["Roboto", "Gone"]);
		expect(report.missing).toEqual([]);
		expect(links).toHaveLength(0);
	});

	it("reports Google fonts that could not be loaded", async () => {
		const { prepareProjectFonts } = await loadFontModules();
		linkEvent = "error";

		const report = await prepareProjectFonts({
			families: ["Roboto", "Lobster"],
		});

		expect(report.failed).toEqual(["Roboto", "Lobster"]);
		expect(links.every((link) => link.removed)).toBe(true);
	});

	it("skips the missing-fonts check when stored fonts could not be read", async () => {
		const { prepareProjectFonts } = await loadFontModules();
		const logged = spyOn(console, "error").mockImplementation(() => {});
		storage.list.mockImplementation(async () => {
			throw new Error("IndexedDB unavailable");
		});

		const report = await prepareProjectFonts({ families: ["Mine", "Roboto"] });

		logged.mockRestore();
		storage.list.mockImplementation(async () => [...stored.values()]);
		expect(report).toMatchObject({
			customFontsUnreadable: true,
			missing: [],
			unverified: [],
		});
	});

	it("lists custom fonts that failed to register, and treats them as unavailable", async () => {
		const { prepareProjectFonts } = await loadFontModules();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		FakeFontFace.failFamilies.add("Broken");
		storedRecord({ family: "Broken" });

		const report = await prepareProjectFonts({ families: ["Broken"] });

		warn.mockRestore();
		expect(report.brokenCustomFonts).toEqual(["Broken"]);
		expect(report.missing).toEqual(["Broken"]);
	});

	it("ignores values that are not strings, such as a corrupt mask fontFamily", async () => {
		const { prepareProjectFonts } = await loadFontModules();

		const report = await prepareProjectFonts({
			families: [undefined, 5, {}, "", "Arial"],
		});

		expect(report).toMatchObject({ missing: [], unverified: [], failed: [] });
		expect(fetchCalls).toBeLessThanOrEqual(1);
	});

	it("does not fail when a family name carries control characters", async () => {
		const { prepareProjectFonts } = await loadFontModules();

		await expect(
			prepareProjectFonts({ families: ["Style\u000cName"] }),
		).resolves.toMatchObject({ missing: ["Style\u000cName"] });
	});
});
