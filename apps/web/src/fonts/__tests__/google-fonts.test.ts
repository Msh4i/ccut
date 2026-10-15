import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	clearFontAtlasCache,
	loadFontAtlas,
	loadFonts,
	loadFullFont,
} from "../google-fonts";
import type { BundledFontFile, FontAtlas, FontManifest } from "../types";
import { stubGlobals } from "./stub-globals";

function entry({ styles }: { styles: string[] }) {
	return { x: 0, y: 0, w: 10, ch: 0, s: styles };
}

const ATLAS: FontAtlas = {
	fonts: {
		Lobster: entry({ styles: ["400"] }),
		Roboto: entry({ styles: ["100", "400", "400i", "700"] }),
		"Press Start 2P": entry({ styles: ["400"] }),
		"A&B": entry({ styles: ["400"] }),
		Odd: entry({ styles: ["300", "500"] }),
	},
};

function bundled({
	id,
	weights,
}: {
	id: string;
	weights: number[];
}): FontManifest[string] {
	const files: BundledFontFile[] = weights.flatMap((weight) =>
		["latin", "latin-ext"].map((subset) => ({
			weight,
			subset,
			url: `/fonts/files/${id}/${subset}-${weight}-normal.woff2`,
			unicodeRange: subset === "latin" ? "U+0000-00FF" : "U+0100-02BA",
		})),
	);
	return { id, version: "5.3.0", weights, files };
}

const MANIFEST: FontManifest = {
	Roboto: bundled({ id: "roboto", weights: [400, 700] }),
	Lobster: bundled({ id: "lobster", weights: [400] }),
	Ghost: bundled({ id: "ghost", weights: [400] }),
};

class FakeFontFace {
	// eslint-disable-next-line opencut/prefer-object-params -- mirrors the positional DOM FontFace constructor.
	constructor(
		readonly family: string,
		readonly source: string,
		readonly descriptors: Record<string, string>,
	) {
		faces.push(this);
	}
	load() {
		return faceLoad({ face: this });
	}
}

type LinkEvent = "load" | "error" | "hang";

interface FakeLink {
	href: string;
	rel: string;
	removed: boolean;
	listeners: Record<string, () => void>;
	addEventListener: (type: string, listener: () => void) => void;
	remove: () => void;
}

let linkEvent: LinkEvent = "load";
let links: FakeLink[] = [];
let fontsLoadResult: () => Promise<unknown[]> = async () => [{}];
let fontsLoadCalls: string[] = [];
let atlasResponse: () => Promise<unknown> = async () => ({
	ok: true,
	json: async () => ATLAS,
});
let manifestResponse: () => Promise<unknown> = async () => ({
	ok: true,
	json: async () => MANIFEST,
});
let faces: FakeFontFace[] = [];
let addedFaces: FakeFontFace[] = [];
let faceLoad: (args: { face: FakeFontFace }) => Promise<unknown> = async ({
	face,
}) => face;
let externalNetworkDown = false;
let fetchCalls: string[] = [];
let lastFetchSignal: AbortSignal | undefined;
let restoreGlobals: () => void = () => {};

function installBrowser() {
	restoreGlobals = stubGlobals({
		stubs: {
			Image: class {
				src = "";
			},
			FontFace: FakeFontFace,
			fetch: async (url: string, init?: { signal?: AbortSignal }) => {
				fetchCalls.push(url);
				lastFetchSignal = init?.signal;
				if (externalNetworkDown && !url.startsWith("/fonts/")) {
					throw new TypeError("network down");
				}
				return url === "/fonts/files/manifest.json"
					? manifestResponse()
					: atlasResponse();
			},
			document: {
				createElement: (): FakeLink => {
					const link: FakeLink = {
						href: "",
						rel: "",
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
						if (linkEvent !== "hang") {
							queueMicrotask(() => link.listeners[linkEvent]?.());
						}
					},
				},
				fonts: {
					add: (face: FakeFontFace) => addedFaces.push(face),
					delete: (face: FakeFontFace) => {
						addedFaces = addedFaces.filter((added) => added !== face);
					},
					load: (font: string) => {
						fontsLoadCalls.push(font);
						return fontsLoadResult();
					},
				},
			},
		},
	});
}

beforeEach(() => {
	clearFontAtlasCache();
	linkEvent = "load";
	links = [];
	fontsLoadResult = async () => [{}];
	fontsLoadCalls = [];
	fetchCalls = [];
	atlasResponse = async () => ({ ok: true, json: async () => ATLAS });
	// No pack unless a test sets one, so the Google-path tests stay as they were.
	manifestResponse = async () => ({ ok: false, status: 404 });
	faces = [];
	addedFaces = [];
	faceLoad = async ({ face }) => face;
	externalNetworkDown = false;
	installBrowser();
});

afterEach(() => {
	restoreGlobals();
	clearFontAtlasCache();
});

describe("loadFontAtlas", () => {
	it("does not cache a failed fetch, so the next call tries again", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		atlasResponse = async () => {
			throw new Error("offline");
		};
		expect(await loadFontAtlas()).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);

		atlasResponse = async () => ({ ok: true, json: async () => ATLAS });
		expect(await loadFontAtlas()).toEqual(ATLAS);
		expect(fetchCalls).toHaveLength(2);
		warn.mockRestore();
	});

	it("gives up on a request that never answers after 8 seconds", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const timeout = new AbortController();
		const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(
			timeout.signal,
		);
		atlasResponse = () =>
			new Promise((_resolve, reject) => {
				timeout.signal.addEventListener("abort", () =>
					reject(new DOMException("timed out", "TimeoutError")),
				);
			});

		const pending = loadFontAtlas();
		timeout.abort();

		expect(await pending).toBeNull();
		expect(timeoutSpy).toHaveBeenCalledWith(8000);
		expect(lastFetchSignal).toBe(timeout.signal);
		expect(warn).toHaveBeenCalledTimes(1);
		timeoutSpy.mockRestore();
		warn.mockRestore();
	});

	it("treats an HTTP error or a malformed catalog as unavailable", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		atlasResponse = async () => ({ ok: false, status: 404 });
		expect(await loadFontAtlas()).toBeNull();

		atlasResponse = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
		expect(await loadFontAtlas()).toBeNull();

		atlasResponse = async () => ({ ok: true, json: async () => null });
		expect(await loadFontAtlas()).toBeNull();
		expect(warn).toHaveBeenCalledTimes(3);
		warn.mockRestore();
	});

	it("shares one request between concurrent callers and caches success", async () => {
		await Promise.all([loadFontAtlas(), loadFontAtlas()]);
		await loadFontAtlas();
		expect(fetchCalls).toHaveLength(1);
	});
});

describe("loadFullFont privacy", () => {
	it("never contacts Google for a name that is not in the bundled catalog", async () => {
		expect(await loadFullFont({ family: "My Private Font" })).toBe(false);
		expect(await loadFullFont({ family: "Arial" })).toBe(false);
		expect(await loadFullFont({ family: "toString" })).toBe(false);
		expect(links).toHaveLength(0);
		expect(fontsLoadCalls).toHaveLength(0);
	});

	it("makes no request at all while the catalog is unavailable", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		atlasResponse = async () => ({ ok: false, status: 500 });

		expect(await loadFullFont({ family: "Roboto" })).toBe(false);
		expect(links).toHaveLength(0);
		warn.mockRestore();
	});

	it("encodes the family for the URL", async () => {
		await loadFullFont({ family: "Press Start 2P" });
		await loadFullFont({ family: "A&B" });

		expect(links[0].href).toContain("family=Press+Start+2P:");
		expect(links[1].href).toContain("family=A%26B:");
	});

	it("asks only for weights the family has", async () => {
		await loadFullFont({ family: "Lobster" });
		await loadFullFont({ family: "Roboto" });
		await loadFullFont({ family: "Odd" });

		expect(links[0].href).toContain(":wght@400&");
		expect(links[1].href).toContain(":wght@400;700&");
		expect(links[2].href).toContain(":wght@300&");
	});
});

describe("loadFullFont result", () => {
	it("is true only when the stylesheet loaded and the browser found the faces", async () => {
		expect(await loadFullFont({ family: "Roboto" })).toBe(true);
		expect(links[0].removed).toBe(false);
	});

	it("remembers a success: a second call makes no new request", async () => {
		await loadFullFont({ family: "Roboto" });
		expect(await loadFullFont({ family: "Roboto" })).toBe(true);
		expect(links).toHaveLength(1);
	});

	it("fails when the stylesheet errors, removes the link and can be retried", async () => {
		linkEvent = "error";
		expect(await loadFullFont({ family: "Roboto" })).toBe(false);
		expect(links[0].removed).toBe(true);

		linkEvent = "load";
		expect(await loadFullFont({ family: "Roboto" })).toBe(true);
		expect(links).toHaveLength(2);
		expect(links[1].removed).toBe(false);
	});

	it("fails when the browser returns no faces", async () => {
		fontsLoadResult = async () => [];
		expect(await loadFullFont({ family: "Roboto" })).toBe(false);
		expect(links[0].removed).toBe(true);
	});

	it("fails instead of throwing when the font load itself throws", async () => {
		fontsLoadResult = async () => {
			throw new SyntaxError("bad font");
		};
		expect(await loadFullFont({ family: "Roboto" })).toBe(false);
		expect(links[0].removed).toBe(true);
	});

	it("gives up on a stylesheet that never answers", async () => {
		linkEvent = "hang";
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
			expect(await loadFullFont({ family: "Roboto" })).toBe(false);
		} finally {
			restoreTimers();
		}
		expect(links[0].removed).toBe(true);
	});

	it("gives up when the browser never finishes loading the font files", async () => {
		fontsLoadResult = () => new Promise(() => {});
		let timers = 0;
		const restoreTimers = stubGlobals({
			stubs: {
				// Second timer = the font file wait; the first is the stylesheet.
				setTimeout: (fire: () => void) => {
					timers += 1;
					if (timers === 2) fire();
					return 0;
				},
				clearTimeout: () => {},
			},
		});
		try {
			expect(await loadFullFont({ family: "Roboto" })).toBe(false);
		} finally {
			restoreTimers();
		}
		expect(links[0].removed).toBe(true);
	});

	it("quotes the family it asks the browser for", async () => {
		await loadFullFont({ family: "Press Start 2P" });
		expect(fontsLoadCalls[0]).toBe('400 16px "Press Start 2P"');
	});
});

describe("loadFullFont in flight", () => {
	beforeEach(() => {
		manifestResponse = async () => ({ ok: true, json: async () => MANIFEST });
	});

	it("shares one load between concurrent calls for a pack family", async () => {
		const results = await Promise.all([
			loadFullFont({ family: "Roboto" }),
			loadFullFont({ family: "Roboto" }),
			loadFonts({ families: ["Roboto"] }),
		]);

		expect(results[0]).toBe(true);
		expect(results[1]).toBe(true);
		expect(results[2]).toEqual({ failed: [] });
		expect(faces).toHaveLength(4);
		expect(addedFaces).toHaveLength(4);
	});

	it("shares one stylesheet between concurrent calls for a Google family", async () => {
		const results = await Promise.all([
			loadFullFont({ family: "Press Start 2P" }),
			loadFullFont({ family: "Press Start 2P" }),
		]);

		expect(results).toEqual([true, true]);
		expect(links).toHaveLength(1);
	});

	it("gives every waiting caller the same failure, then lets a retry start fresh", async () => {
		faceLoad = async () => {
			throw new Error("404");
		};
		expect(
			await Promise.all([
				loadFullFont({ family: "Roboto" }),
				loadFullFont({ family: "Roboto" }),
			]),
		).toEqual([false, false]);

		faceLoad = async ({ face }) => face;
		expect(await loadFullFont({ family: "Roboto" })).toBe(true);
	});

	it("does not mix up different families", async () => {
		expect(
			await Promise.all([
				loadFullFont({ family: "Roboto" }),
				loadFullFont({ family: "Lobster" }),
			]),
		).toEqual([true, true]);
		expect(faces).toHaveLength(6);
	});
});

describe("loadFonts", () => {
	it("requests only catalog families and reports the ones that failed", async () => {
		fontsLoadResult = async () => [];

		const result = await loadFonts({
			families: ["Roboto", "Arial", "serif", "Gone Custom", "Lobster"],
		});

		expect(result).toEqual({ failed: ["Roboto", "Lobster"] });
		expect(links.map((link) => link.href).join()).not.toContain("Gone");
	});

	it("ignores values that are not strings", async () => {
		const result = await loadFonts({
			families: [undefined, null, 7, {}, ["Roboto"], "Roboto"],
		});

		expect(result).toEqual({ failed: [] });
		expect(links).toHaveLength(1);
	});

	it("reports nothing and requests nothing while the catalog is unavailable", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		atlasResponse = async () => {
			throw new Error("offline");
		};

		expect(await loadFonts({ families: ["Roboto", "Mine"] })).toEqual({
			failed: [],
		});
		expect(links).toHaveLength(0);
		warn.mockRestore();
	});

	it("lets one family fail without affecting the others", async () => {
		let calls = 0;
		fontsLoadResult = async () => {
			calls += 1;
			if (calls <= 2) throw new SyntaxError("bad");
			return [{}];
		};

		const result = await loadFonts({ families: ["Roboto", "Lobster"] });

		expect(result.failed).toHaveLength(1);
	});
});

describe("loadFullFont with the offline pack", () => {
	beforeEach(() => {
		manifestResponse = async () => ({ ok: true, json: async () => MANIFEST });
	});

	const hasGoogleRequest = () =>
		links.length > 0 || fetchCalls.some((url) => url.includes("googleapis"));

	it("registers the bundled files and never contacts Google", async () => {
		expect(await loadFullFont({ family: "Roboto" })).toBe(true);

		expect(faces.map((face) => face.source)).toEqual([
			"url(/fonts/files/roboto/latin-400-normal.woff2) format('woff2')",
			"url(/fonts/files/roboto/latin-ext-400-normal.woff2) format('woff2')",
			"url(/fonts/files/roboto/latin-700-normal.woff2) format('woff2')",
			"url(/fonts/files/roboto/latin-ext-700-normal.woff2) format('woff2')",
		]);
		expect(faces[1].descriptors).toEqual({
			weight: "400",
			unicodeRange: "U+0100-02BA",
			display: "swap",
		});
		expect(addedFaces).toEqual(faces);
		expect(fontsLoadCalls).toEqual(['400 16px "Roboto"', '700 16px "Roboto"']);
		expect(hasGoogleRequest()).toBe(false);
	});

	it("loads with the outside network down: only same-origin requests are made", async () => {
		externalNetworkDown = true;
		linkEvent = "error";

		expect(await loadFullFont({ family: "Roboto" })).toBe(true);
		expect(await loadFonts({ families: ["Lobster"] })).toEqual({ failed: [] });

		expect(fetchCalls.every((url) => url.startsWith("/fonts/"))).toBe(true);
		expect(hasGoogleRequest()).toBe(false);
	});

	it("does not ask for a weight the family lacks", async () => {
		await loadFullFont({ family: "Lobster" });

		expect(faces.map((face) => face.descriptors.weight)).toEqual(["400", "400"]);
		expect(fontsLoadCalls).toEqual(['400 16px "Lobster"']);
	});

	it("loads only the weights it is asked for", async () => {
		await loadFullFont({ family: "Roboto", weights: [700] });

		expect(faces.map((face) => face.descriptors.weight)).toEqual(["700", "700"]);
	});

	it("remembers a success: a second call registers nothing new", async () => {
		await loadFullFont({ family: "Roboto" });
		expect(await loadFullFont({ family: "Roboto" })).toBe(true);

		expect(faces).toHaveLength(4);
	});

	it("with a readable manifest, fails when a pack file does not load, does not try Google, and can be retried", async () => {
		faceLoad = async () => {
			throw new Error("404");
		};
		expect(await loadFullFont({ family: "Roboto" })).toBe(false);
		expect(addedFaces).toEqual([]);
		expect(hasGoogleRequest()).toBe(false);

		faceLoad = async ({ face }) => face;
		expect(await loadFullFont({ family: "Roboto" })).toBe(true);
	});

	it("fails and registers nothing when the browser finds no faces", async () => {
		fontsLoadResult = async () => [];

		expect(await loadFullFont({ family: "Roboto" })).toBe(false);
		expect(addedFaces).toEqual([]);
		expect(hasGoogleRequest()).toBe(false);
	});

	it("still refuses a name that is not in the catalog, even if the pack lists it", async () => {
		expect(await loadFullFont({ family: "Ghost" })).toBe(false);

		expect(faces).toEqual([]);
		expect(hasGoogleRequest()).toBe(false);
	});

	it("uses Google only for a catalog family the pack does not have", async () => {
		expect(await loadFullFont({ family: "Press Start 2P" })).toBe(true);

		expect(faces).toEqual([]);
		expect(links).toHaveLength(1);
		expect(links[0].href).toContain("family=Press+Start+2P:");
	});

	it("uses Google for a weight the pack does not have", async () => {
		await loadFullFont({ family: "Roboto", weights: [100] });

		expect(faces).toEqual([]);
		expect(links[0].href).toContain(":wght@100&");
	});

	it("uses Google when the pack's manifest cannot be read", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		manifestResponse = async () => {
			throw new Error("offline");
		};

		expect(await loadFullFont({ family: "Roboto" })).toBe(true);

		expect(faces).toEqual([]);
		expect(links).toHaveLength(1);
		warn.mockRestore();
	});

	it("loadFonts reports a bundled family that failed, and only that one", async () => {
		faceLoad = async ({ face }) => {
			if (face.family === "Roboto") throw new Error("404");
			return face;
		};

		expect(await loadFonts({ families: ["Roboto", "Lobster", "Mine"] })).toEqual({
			failed: ["Roboto"],
		});
		expect(hasGoogleRequest()).toBe(false);
	});
});
