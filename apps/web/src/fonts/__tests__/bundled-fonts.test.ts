import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
	clearFontManifestCache,
	getBundledFontFiles,
	loadBundledFont,
	loadFontManifest,
} from "../bundled-fonts";
import type { BundledFontFile, FontManifest } from "../types";
import { stubGlobals } from "./stub-globals";

const LATIN = "U+0000-00FF,U+0131";
const LATIN_EXT = "U+0100-02BA";

function file({
	weight,
	subset = "latin",
	id = "roboto",
}: {
	weight: number;
	subset?: string;
	id?: string;
}): BundledFontFile {
	return {
		weight,
		subset,
		url: `/fonts/files/${id}/${subset}-${weight}-normal.woff2`,
		unicodeRange: subset === "latin" ? LATIN : LATIN_EXT,
	};
}

const ROBOTO_FILES = [
	file({ weight: 400 }),
	file({ weight: 400, subset: "latin-ext" }),
	file({ weight: 700 }),
	file({ weight: 700, subset: "latin-ext" }),
];

const MANIFEST: FontManifest = {
	Roboto: {
		id: "roboto",
		version: "5.3.0",
		weights: [400, 700],
		files: ROBOTO_FILES,
	},
	Lobster: {
		id: "lobster",
		version: "5.3.0",
		weights: [400],
		files: [
			file({ weight: 400, id: "lobster" }),
			file({ weight: 400, subset: "latin-ext", id: "lobster" }),
		],
	},
};

// --- browser stand-ins ------------------------------------------------------

class FakeFontFace {
	// eslint-disable-next-line opencut/prefer-object-params -- mirrors the positional DOM FontFace constructor.
	constructor(
		readonly family: string,
		readonly source: string,
		readonly descriptors: Record<string, string>,
	) {
		created.push(this);
	}
	load() {
		return faceLoad({ face: this });
	}
}

let created: FakeFontFace[] = [];
let added: FakeFontFace[] = [];
let removed: FakeFontFace[] = [];
let fontsLoadCalls: string[] = [];
let fontsLoadResult: () => Promise<unknown[]> = async () => [{}];
let faceLoad: (args: { face: FakeFontFace }) => Promise<unknown> = async ({
	face,
}) => face;
let manifestResponse: () => Promise<unknown> = async () => ({
	ok: true,
	json: async () => MANIFEST,
});
let fetchCalls: string[] = [];
let lastFetchSignal: AbortSignal | undefined;
let restoreGlobals: () => void = () => {};

beforeEach(() => {
	clearFontManifestCache();
	created = [];
	added = [];
	removed = [];
	fontsLoadCalls = [];
	fontsLoadResult = async () => [{}];
	faceLoad = async ({ face }) => face;
	manifestResponse = async () => ({ ok: true, json: async () => MANIFEST });
	fetchCalls = [];
	restoreGlobals = stubGlobals({
		stubs: {
			FontFace: FakeFontFace,
			fetch: async (url: string, init?: { signal?: AbortSignal }) => {
				fetchCalls.push(url);
				lastFetchSignal = init?.signal;
				return manifestResponse();
			},
			document: {
				fonts: {
					add: (face: FakeFontFace) => added.push(face),
					delete: (face: FakeFontFace) => removed.push(face),
					load: (font: string) => {
						fontsLoadCalls.push(font);
						return fontsLoadResult();
					},
				},
			},
		},
	});
});

afterEach(() => {
	restoreGlobals();
	clearFontManifestCache();
});

// --- the manifest -----------------------------------------------------------

describe("loadFontManifest", () => {
	it("reads the bundled manifest once and serves it from the cache afterwards", async () => {
		const [first, second] = await Promise.all([
			loadFontManifest(),
			loadFontManifest(),
		]);
		const third = await loadFontManifest();

		expect(first).toEqual(MANIFEST);
		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(fetchCalls).toEqual(["/fonts/files/manifest.json"]);
	});

	it("gives up on a request that never answers after 8 seconds", async () => {
		const timeout = new AbortController();
		const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(
			timeout.signal,
		);
		await loadFontManifest();

		expect(timeoutSpy).toHaveBeenCalledWith(8000);
		expect(lastFetchSignal).toBe(timeout.signal);
		timeoutSpy.mockRestore();
	});

	it("resolves null instead of throwing and does not cache a failure", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		manifestResponse = async () => {
			throw new Error("offline");
		};
		expect(await loadFontManifest()).toBeNull();

		manifestResponse = async () => ({ ok: true, json: async () => MANIFEST });
		expect(await loadFontManifest()).toEqual(MANIFEST);
		expect(fetchCalls).toHaveLength(2);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("treats an HTTP error or a manifest that is not an object as unavailable", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		manifestResponse = async () => ({ ok: false, status: 404 });
		expect(await loadFontManifest()).toBeNull();

		for (const body of [null, [], "Roboto", 7]) {
			manifestResponse = async () => ({ ok: true, json: async () => body });
			expect(await loadFontManifest()).toBeNull();
		}
		warn.mockRestore();
	});
});

describe("getBundledFontFiles", () => {
	it("returns the files of the wanted weights only", () => {
		expect(
			getBundledFontFiles({
				manifest: MANIFEST,
				family: "Roboto",
				weights: [400],
			}),
		).toEqual([ROBOTO_FILES[0], ROBOTO_FILES[1]]);
		expect(
			getBundledFontFiles({
				manifest: MANIFEST,
				family: "Roboto",
				weights: [400, 700],
			}),
		).toEqual(ROBOTO_FILES);
	});

	it("is null when the family is not bundled or a wanted weight is not", () => {
		const find = ({ family, weights }: { family: string; weights: number[] }) =>
			getBundledFontFiles({ manifest: MANIFEST, family, weights });

		expect(find({ family: "Lato", weights: [400] })).toBeNull();
		expect(find({ family: "Lobster", weights: [400, 700] })).toBeNull();
		expect(find({ family: "Roboto", weights: [300] })).toBeNull();
		expect(find({ family: "Roboto", weights: [] })).toBeNull();
		expect(
			getBundledFontFiles({ manifest: null, family: "Roboto", weights: [400] }),
		).toBeNull();
	});

	it("never mistakes an object key for a family", () => {
		for (const family of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
			expect(
				getBundledFontFiles({ manifest: MANIFEST, family, weights: [400] }),
			).toBeNull();
		}
	});

	it("refuses entries that would send a request anywhere but the bundled files", () => {
		const find = ({ files }: { files: unknown }) =>
			getBundledFontFiles({
				// A fetched manifest is untrusted data until each entry is checked.
				manifest: JSON.parse(JSON.stringify({ Evil: { files } })),
				family: "Evil",
				weights: [400],
			});
		const good = file({ weight: 400 });

		expect(find({ files: [good] })).toEqual([good]);
		for (const url of [
			"https://example.com/a.woff2",
			"//example.com/a.woff2",
			"/fonts/files/../../secret.woff2",
			"/fonts/files/a/b.woff2) format('woff2'), url(https://example.com/x",
			"/fonts/files/a/b.ttf",
			"data:font/woff2;base64,AAAA",
		]) {
			expect(find({ files: [{ ...good, url }] })).toBeNull();
		}
		expect(find({ files: "x" })).toBeNull();
		expect(find({ files: [null] })).toBeNull();
		expect(find({ files: [{ ...good, weight: "400" }] })).toBeNull();
		expect(find({ files: [{ ...good, unicodeRange: 1 }] })).toBeNull();
		expect(find({ files: [{ ...good, unicodeRange: "} body {x:y" }] })).toBeNull();
	});
});

// --- registering the files --------------------------------------------------

describe("loadBundledFont", () => {
	it("registers one FontFace per file with its own weight and unicode range", async () => {
		const ok = await loadBundledFont({
			family: "Roboto",
			weights: [400, 700],
			files: ROBOTO_FILES,
		});

		expect(ok).toBe(true);
		expect(
			created.map((face) => [face.family, face.source, face.descriptors]),
		).toEqual(
			ROBOTO_FILES.map((f) => [
				"Roboto",
				`url(${f.url}) format('woff2')`,
				{ weight: String(f.weight), unicodeRange: f.unicodeRange, display: "swap" },
			]),
		);
		expect(added).toEqual(created);
		expect(removed).toEqual([]);
	});

	it("loads every face, the latin-ext ones too, before it reports success", async () => {
		const loading: string[] = [];
		faceLoad = async ({ face }) => {
			loading.push(face.source);
			return face;
		};

		await loadBundledFont({
			family: "Roboto",
			weights: [400, 700],
			files: ROBOTO_FILES,
		});

		expect(loading).toHaveLength(4);
		expect(loading.filter((source) => source.includes("latin-ext"))).toHaveLength(2);
	});

	it("asks the browser for each weight with the family quoted", async () => {
		await loadBundledFont({
			family: "Press Start 2P",
			weights: [400],
			files: [file({ weight: 400 })],
		});
		expect(fontsLoadCalls).toEqual(['400 16px "Press Start 2P"']);
	});

	it("fails when a file does not load, and registers nothing", async () => {
		faceLoad = async ({ face }) => {
			if (face.source.includes("latin-ext-700")) throw new Error("404");
			return face;
		};

		expect(
			await loadBundledFont({
				family: "Roboto",
				weights: [400, 700],
				files: ROBOTO_FILES,
			}),
		).toBe(false);
		expect(added).toEqual([]);
	});

	it("fails and takes the faces back when the browser finds none for a weight", async () => {
		fontsLoadResult = async () => [];

		expect(
			await loadBundledFont({
				family: "Roboto",
				weights: [400],
				files: [ROBOTO_FILES[0], ROBOTO_FILES[1]],
			}),
		).toBe(false);
		expect(added).toHaveLength(2);
		expect(removed).toEqual(added);
	});

	it("fails instead of throwing when the browser rejects the font string", async () => {
		fontsLoadResult = async () => {
			throw new SyntaxError("bad font");
		};

		expect(
			await loadBundledFont({
				family: "Roboto",
				weights: [400],
				files: [ROBOTO_FILES[0]],
			}),
		).toBe(false);
		expect(removed).toEqual(added);
	});

	it("fails instead of throwing when the browser rejects a face descriptor", async () => {
		const restoreFontFace = stubGlobals({
			stubs: {
				FontFace: class {
					constructor() {
						throw new SyntaxError("bad descriptor");
					}
				},
			},
		});
		try {
			expect(
				await loadBundledFont({
					family: "Roboto",
					weights: [400],
					files: [ROBOTO_FILES[0]],
				}),
			).toBe(false);
		} finally {
			restoreFontFace();
		}
		expect(added).toEqual([]);
	});

	it("gives up on a file that never finishes loading", async () => {
		faceLoad = () => new Promise(() => {});
		const restoreTimers = stubGlobals({
			stubs: {
				setTimeout: (fire: () => void, ms: number) => {
					if (ms >= 8000) fire();
					return 0;
				},
				clearTimeout: () => {},
			},
		});
		try {
			expect(
				await loadBundledFont({
					family: "Roboto",
					weights: [400],
					files: [ROBOTO_FILES[0]],
				}),
			).toBe(false);
		} finally {
			restoreTimers();
		}
		expect(added).toEqual([]);
	});

	it("never touches the network", async () => {
		await loadBundledFont({
			family: "Roboto",
			weights: [400],
			files: [ROBOTO_FILES[0]],
		});
		expect(fetchCalls).toEqual([]);
	});
});

// --- the files on disk ------------------------------------------------------

const PUBLIC = new URL("../../../public/", import.meta.url);
const PACK = new URL("fonts/files/", PUBLIC);

describe("the bundled pack on disk", () => {
	const manifest: FontManifest = JSON.parse(
		readFileSync(new URL("manifest.json", PACK), "utf8"),
	);
	const atlas: { fonts: Record<string, { s: string[] }> } = JSON.parse(
		readFileSync(new URL("fonts/font-atlas.json", PUBLIC), "utf8"),
	);
	const turkish: string[] = JSON.parse(
		readFileSync(new URL("fonts/turkish-support.json", PUBLIC), "utf8"),
	);
	const entries = Object.entries(manifest);
	const onDisk = ({ url }: { url: string }) => new URL(`.${url}`, PUBLIC);

	it("holds the 80 verified families and nothing else", () => {
		expect(entries).toHaveLength(80);
		const folders = readdirSync(PACK).filter((name) => name !== "manifest.json");
		expect(folders.sort()).toEqual(entries.map(([, entry]) => entry.id).sort());
	});

	it("lists only catalog families that have all Turkish letters", () => {
		const supported = new Set(turkish);
		for (const [family] of entries) {
			expect(Object.hasOwn(atlas.fonts, family)).toBe(true);
			expect(supported.has(family)).toBe(true);
		}
	});

	it("has exactly the 400 and 700 weights the catalog offers, latin and latin-ext each", () => {
		for (const [family, entry] of entries) {
			const offered = atlas.fonts[family].s
				.filter((style) => /^\d+$/.test(style))
				.map(Number);
			const expected = [400, 700].filter((weight) => offered.includes(weight));

			expect(entry.weights).toEqual(expected);
			expect(entry.files.map((f) => `${f.weight}/${f.subset}`).sort()).toEqual(
				expected.flatMap((w) => [`${w}/latin`, `${w}/latin-ext`]).sort(),
			);
		}
	});

	it("pins an exact package version", () => {
		for (const [, entry] of entries) {
			expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
		}
	});

	it("has every listed file, a real WOFF2, whose header size and sha256 match", () => {
		for (const [family, entry] of entries) {
			expect(getBundledFontFiles({ manifest, family, weights: entry.weights })).toEqual(
				entry.files,
			);
			for (const listed of entry.files) {
				expect(listed.url).toBe(`/fonts/files/${entry.id}/${listed.subset}-${listed.weight}-normal.woff2`);
				const bytes = readFileSync(onDisk(listed));
				expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
				expect(bytes.byteLength).toBeGreaterThan(1000);
				expect(bytes.readUInt32BE(8)).toBe(bytes.byteLength);
				expect(listed.sha256).toBe(
					createHash("sha256").update(bytes).digest("hex"),
				);
				expect(listed.unicodeRange).toMatch(/^U\+[0-9A-F]/);
			}
		}
	});

	it("ships no file the manifest does not list, and a LICENSE with each family", () => {
		for (const [, entry] of entries) {
			const folder = new URL(`${entry.id}/`, PACK);
			const listed = entry.files.map((f) => f.url.split("/").pop() ?? "").sort();
			const present = readdirSync(folder).filter((name) => name !== "LICENSE");

			expect(present.sort()).toEqual(listed);
			expect(existsSync(new URL("LICENSE", folder))).toBe(true);
			expect(statSync(new URL("LICENSE", folder)).size).toBeGreaterThan(1000);
		}
	});

	it("keeps the pack near 5 MB", () => {
		const bytes = entries
			.flatMap(([, entry]) => entry.files)
			.reduce((sum, listed) => sum + statSync(onDisk(listed)).size, 0);

		expect(bytes).toBeGreaterThan(4_000_000);
		expect(bytes).toBeLessThan(6_000_000);
	});
});
