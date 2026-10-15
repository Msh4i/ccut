import { describe, expect, test } from "bun:test";
import { getOrThrow } from "../providers/catalog-utils";
import {
	buildEmojiIndex,
	buildEmojiSearchEntries,
	fluentUnicodeToId,
	idToGlyph,
	isSafeFluentFolderName,
	listFluentFolders,
	mergeCldrAnnotations,
	parseCldrAnnotations,
	parseEmojiIndex,
	pickDefaultFlatSvgPath,
	searchEmojiEntries,
	type EmojiIndex,
	type FluentEmojiRecord,
} from "../providers/emoji-index";

// Built from code points so invisible characters (ZWJ, U+FE0F) cannot drift.
const GRIN = "\u{1F600}";
const YIN_YANG_KEY = "\u262F";
const HEART_KEY = "\u2764";
const PERSON_WHITE_HAIR = "\u{1F9D1}\u200D\u{1F9B3}";
const WALKING_RIGHT = "\u{1F6B6}\u200D\u27A1\uFE0F";

const TR_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<ldml>
	<annotations>
		<annotation cp="&amp;">ve işareti | ampersand</annotation>
		<annotation cp="&amp;" type="tts">ve işareti</annotation>
		<annotation cp="${GRIN}">gülen yüz | gülümseme | yüz</annotation>
		<annotation cp="${GRIN}" type="tts">sırıtan yüz</annotation>
		<annotation cp="${YIN_YANG_KEY}">yin yang | taoizm</annotation>
		<annotation cp="${YIN_YANG_KEY}" type="tts">yin ve yang</annotation>
		<annotation cp="${HEART_KEY}">kalp | aşk | sevgi</annotation>
		<annotation cp="${HEART_KEY}" type="tts">kırmızı kalp</annotation>
	</annotations>
</ldml>`;

const TR_DERIVED_XML = `<ldml>
	<annotations>
		<annotation cp="${PERSON_WHITE_HAIR}">sağlık | yaşlı</annotation>
		<annotation cp="${PERSON_WHITE_HAIR}" type="tts">kişi: beyaz saç</annotation>
		<annotation cp="${GRIN}">türetilmiş yüz</annotation>
	</annotations>
</ldml>`;

function record({
	folder,
	metadata,
}: FluentEmojiRecord): FluentEmojiRecord {
	return { folder, metadata };
}

const FLUENT: FluentEmojiRecord[] = [
	record({ folder: "Red heart", metadata: {
		glyph: `${HEART_KEY}\uFE0F`,
		group: "Smileys & Emotion",
		unicode: "2764 fe0f",
		tts: "red heart",
		cldr: "red heart",
		keywords: ["heart", "red heart"],
	} }),
	record({ folder: "Grinning face", metadata: {
		glyph: GRIN,
		group: "Smileys & Emotion",
		unicode: "1f600",
		tts: "grinning face",
		cldr: "grinning face",
		keywords: ["face", "grin", "grinning face"],
	} }),
	record({ folder: "Yin yang", metadata: {
		glyph: `${YIN_YANG_KEY}\uFE0F`,
		group: "Symbols",
		unicode: "262f fe0f",
		tts: "yin yang",
		cldr: "yin yang",
		keywords: ["religion", "tao", "taoist", "yang", "yin"],
	} }),
	record({ folder: "Person white hair", metadata: {
		glyph: PERSON_WHITE_HAIR,
		group: "People & Body",
		unicode: "1f9d1 200d 1f9b3",
		tts: "person: white hair",
		cldr: "person: white hair",
		keywords: ["adult", "white hair"],
	} }),
	record({ folder: "Walking facing right", metadata: {
		glyph: WALKING_RIGHT,
		group: "People & Body",
		unicode: "1f6b6 200d 27a1 fe0f",
		tts: "",
		cldr: "",
		keywords: [],
	} }),
];

describe("fluentUnicodeToId / idToGlyph", () => {
	test("joins code points with hyphens, lowercase", () => {
		expect(fluentUnicodeToId({ unicode: "1f600" })).toBe("1f600");
		expect(fluentUnicodeToId({ unicode: "1F468 200D 1F4BB" })).toBe(
			"1f468-200d-1f4bb",
		);
		expect(fluentUnicodeToId({ unicode: "2764 fe0f" })).toBe("2764-fe0f");
	});

	test("rejects anything that is not hex code points", () => {
		expect(() => fluentUnicodeToId({ unicode: "" })).toThrow();
		expect(() => fluentUnicodeToId({ unicode: "../etc" })).toThrow();
		expect(() => fluentUnicodeToId({ unicode: "1f600 xyz" })).toThrow();
	});

	test("converts an id back to the emoji glyph", () => {
		expect(idToGlyph({ id: "1f600" })).toBe(GRIN);
		expect(idToGlyph({ id: "1f468-200d-1f4bb" })).toBe("\u{1F468}\u200D\u{1F4BB}");
		expect(idToGlyph({ id: "2764-fe0f" })).toBe("\u2764\uFE0F");
	});
});

describe("parseCldrAnnotations", () => {
	const cldr = parseCldrAnnotations({ xml: TR_XML });

	test("reads keywords split on the pipe separator", () => {
		expect(cldr.keywords.get(GRIN)).toEqual([
			"gülen yüz",
			"gülümseme",
			"yüz",
		]);
	});

	test("reads the tts name separately from keywords", () => {
		expect(cldr.names.get(GRIN)).toBe("sırıtan yüz");
	});

	test("decodes XML entities", () => {
		expect(cldr.names.get("&")).toBe("ve işareti");
		expect(cldr.keywords.get("&")).toEqual(["ve işareti", "ampersand"]);
	});

	test("remembers file order, which is the standard emoji order", () => {
		const order = (key: string) => getOrThrow({ map: cldr.order, key });
		expect(order("&")).toBeLessThan(order(GRIN));
		expect(order(GRIN)).toBeLessThan(order(YIN_YANG_KEY));
		expect(order(YIN_YANG_KEY)).toBeLessThan(order(HEART_KEY));
	});

	test("returns empty maps for input without annotations", () => {
		const empty = parseCldrAnnotations({ xml: "<ldml></ldml>" });
		expect(empty.names.size).toBe(0);
		expect(empty.keywords.size).toBe(0);
		expect(empty.order.size).toBe(0);
	});

	test("ignores blank keywords", () => {
		const parsed = parseCldrAnnotations({
			xml: '<annotation cp="x">a |  | b </annotation>',
		});
		expect(parsed.keywords.get("x")).toEqual(["a", "b"]);
	});
});

describe("mergeCldrAnnotations", () => {
	const base = parseCldrAnnotations({ xml: TR_XML });
	const derived = parseCldrAnnotations({ xml: TR_DERIVED_XML });
	const merged = mergeCldrAnnotations({ base, derived });

	test("base annotations win over derived ones", () => {
		expect(merged.keywords.get(GRIN)).toEqual([
			"gülen yüz",
			"gülümseme",
			"yüz",
		]);
	});

	test("derived annotations fill in what the base file lacks", () => {
		expect(merged.names.get(PERSON_WHITE_HAIR)).toBe("kişi: beyaz saç");
	});

	test("derived-only entries sort after every base entry", () => {
		const derivedOrder = getOrThrow({ map: merged.order, key: PERSON_WHITE_HAIR });
		for (const key of ["&", GRIN, YIN_YANG_KEY, HEART_KEY]) {
			expect(getOrThrow({ map: merged.order, key })).toBeLessThan(derivedOrder);
		}
	});
});

describe("buildEmojiIndex", () => {
	const cldr = mergeCldrAnnotations({
		base: parseCldrAnnotations({ xml: TR_XML }),
		derived: parseCldrAnnotations({ xml: TR_DERIVED_XML }),
	});
	const index = buildEmojiIndex({ fluent: FLUENT, cldr });

	test("uses the unicode id as the item id and sorts by CLDR order inside canonical groups", () => {
		expect(index.groups).toEqual([
			"Smileys & Emotion",
			"People & Body",
			"Symbols",
		]);
		expect(index.items.map((item) => item.id)).toEqual([
			"1f600",
			"2764-fe0f",
			"1f9d1-200d-1f9b3",
			"1f6b6-200d-27a1-fe0f",
			"262f-fe0f",
		]);
	});

	test("points each item at its group by index", () => {
		const byId = new Map(index.items.map((item) => [item.id, item]));
		expect(index.groups[byId.get("1f600")?.g ?? -1]).toBe("Smileys & Emotion");
		expect(index.groups[byId.get("262f-fe0f")?.g ?? -1]).toBe("Symbols");
	});

	test("carries English and Turkish names and keywords", () => {
		const grin = index.items.find((item) => item.id === "1f600");
		expect(grin).toEqual({
			id: "1f600",
			n: "grinning face",
			tr: "sırıtan yüz",
			g: 0,
			k: ["face", "grin"],
			kt: ["gülen yüz", "gülümseme", "yüz"],
		});
	});

	test("matches CLDR annotations despite the U+FE0F variation selector", () => {
		const heart = index.items.find((item) => item.id === "2764-fe0f");
		expect(heart?.tr).toBe("kırmızı kalp");
		const yin = index.items.find((item) => item.id === "262f-fe0f");
		expect(yin?.tr).toBe("yin ve yang");
	});

	test("falls back to the folder name when Fluent has no English name", () => {
		const walking = index.items.find(
			(item) => item.id === "1f6b6-200d-27a1-fe0f",
		);
		expect(walking?.n).toBe("walking facing right");
		expect(walking?.tr).toBeUndefined();
		expect(walking?.k).toEqual([]);
		expect(walking?.kt).toEqual([]);
	});

	test("does not repeat the name inside the keyword lists", () => {
		for (const item of index.items) {
			expect(item.k).not.toContain(item.n);
			if (item.tr) {
				expect(item.kt).not.toContain(item.tr);
			}
		}
	});

	test("is deterministic regardless of the input order", () => {
		const reversed = buildEmojiIndex({
			fluent: [...FLUENT].reverse(),
			cldr,
		});
		expect(JSON.stringify(reversed)).toBe(JSON.stringify(index));
	});

	test("rejects duplicate ids", () => {
		expect(() =>
			buildEmojiIndex({ fluent: [FLUENT[1], FLUENT[1]], cldr }),
		).toThrow(/duplicate/i);
	});

	test("rejects records without a glyph, unicode or group", () => {
		expect(() =>
			buildEmojiIndex({
				fluent: [
					record({ folder: "Broken", metadata: {
						glyph: "",
						group: "Symbols",
						unicode: "1f600",
					} }),
				],
				cldr,
			}),
		).toThrow();
		expect(() =>
			buildEmojiIndex({
				fluent: [
					record({ folder: "Broken", metadata: {
						glyph: GRIN,
						group: "",
						unicode: "1f600",
					} }),
				],
				cldr,
			}),
		).toThrow();
	});

	test("puts unknown groups after the canonical ones, alphabetically", () => {
		const custom = buildEmojiIndex({
			fluent: [
				record({ folder: "Zed", metadata: {
					glyph: GRIN,
					group: "Zeta group",
					unicode: "1f600",
				} }),
				record({ folder: "Alpha", metadata: {
					glyph: "\u{1F603}",
					group: "Alpha group",
					unicode: "1f603",
				} }),
				record({ folder: "Heart", metadata: {
					glyph: `${HEART_KEY}\uFE0F`,
					group: "Symbols",
					unicode: "2764 fe0f",
				} }),
			],
			cldr,
		});
		expect(custom.groups).toEqual(["Symbols", "Alpha group", "Zeta group"]);
	});
});

describe("searchEmojiEntries", () => {
	const cldr = mergeCldrAnnotations({
		base: parseCldrAnnotations({ xml: TR_XML }),
		derived: parseCldrAnnotations({ xml: TR_DERIVED_XML }),
	});
	const index: EmojiIndex = buildEmojiIndex({ fluent: FLUENT, cldr });
	const entries = buildEmojiSearchEntries({ index });

	function ids(query: string): string[] {
		return searchEmojiEntries({ entries, query }).map((item) => item.id);
	}

	test("finds an emoji by its English name or keyword", () => {
		expect(ids("grinning")).toEqual(["1f600"]);
		expect(ids("grin")).toEqual(["1f600"]);
		expect(ids("tao")).toEqual(["262f-fe0f"]);
	});

	test("finds an emoji by its Turkish name or keyword", () => {
		expect(ids("sırıtan")).toEqual(["1f600"]);
		expect(ids("gülümseme")).toEqual(["1f600"]);
		expect(ids("taoizm")).toEqual(["262f-fe0f"]);
	});

	test("matches Turkish case-insensitively including dotted and dotless I", () => {
		expect(ids("SIRITAN")).toEqual(["1f600"]);
		expect(ids("SIRITAN")).toEqual(ids("sırıtan"));
		expect(ids("KIRMIZI")).toEqual(["2764-fe0f"]);
		expect(ids("kırmızı")).toEqual(["2764-fe0f"]);
		expect(ids("KIRMIZI KALP")).toEqual(["2764-fe0f"]);
		expect(ids("YIN VE YANG")).toEqual(["262f-fe0f"]);
	});

	test("folds Turkish diacritics so ASCII input matches", () => {
		expect(ids("gulen")).toEqual(["1f600"]);
		expect(ids("ask")).toEqual(["2764-fe0f"]);
		expect(ids("kirmizi")).toEqual(["2764-fe0f"]);
		expect(ids("gülen")).toEqual(["1f600"]);
	});

	test("requires all words to match", () => {
		expect(ids("kırmızı yüz")).toEqual([]);
		expect(ids("red heart")).toEqual(["2764-fe0f"]);
	});

	test("ranks name matches ahead of keyword matches, whatever the index order", () => {
		const rankingIndex = buildEmojiIndex({
			fluent: [
				record({ folder: "Love letter", metadata: {
					glyph: "\u{1F48C}",
					group: "Objects",
					unicode: "1f48c",
					tts: "love letter",
					keywords: ["heart", "mail"],
				} }),
				record({ folder: "Red heart", metadata: {
					glyph: `${HEART_KEY}\uFE0F`,
					group: "Objects",
					unicode: "2764 fe0f",
					tts: "red heart",
					keywords: [],
				} }),
			],
			cldr: parseCldrAnnotations({ xml: "" }),
		});
		// 1f48c sorts before 2764-fe0f, but "heart" is only a keyword there.
		expect(rankingIndex.items.map((item) => item.id)).toEqual([
			"1f48c",
			"2764-fe0f",
		]);
		const found = searchEmojiEntries({
			entries: buildEmojiSearchEntries({ index: rankingIndex }),
			query: "heart",
		});
		expect(found.map((item) => item.id)).toEqual(["2764-fe0f", "1f48c"]);
	});

	test("returns nothing for blank or unmatched queries", () => {
		expect(ids("")).toEqual([]);
		expect(ids("   ")).toEqual([]);
		expect(ids("zzzzqqq")).toEqual([]);
	});

	test("keeps index order between equally ranked matches", () => {
		const tiedIndex = buildEmojiIndex({
			fluent: [
				record({ folder: "Dog face", metadata: {
					glyph: "\u{1F436}",
					group: "Animals & Nature",
					unicode: "1f436",
					tts: "dog face",
					keywords: [],
				} }),
				record({ folder: "Cat face", metadata: {
					glyph: "\u{1F431}",
					group: "Animals & Nature",
					unicode: "1f431",
					tts: "cat face",
					keywords: [],
				} }),
			],
			cldr: parseCldrAnnotations({ xml: "" }),
		});
		const found = searchEmojiEntries({
			entries: buildEmojiSearchEntries({ index: tiedIndex }),
			query: "face",
		});
		// Both have the exact name word "face": the index order (id order here,
		// no CLDR data) decides, not the order they were passed in.
		expect(found.map((item) => item.id)).toEqual(["1f431", "1f436"]);
	});

	test("survives regex-looking and SQL-looking input", () => {
		expect(ids(".*")).toEqual([]);
		expect(ids("'; DROP TABLE emoji;--")).toEqual([]);
		expect(ids("(((")).toEqual([]);
	});
});

describe("Fluent tree helpers", () => {
	const paths = [
		".github/CODEOWNERS",
		"LICENSE",
		"assets/Grinning face/metadata.json",
		"assets/Grinning face/3D/grinning_face_3d.png",
		"assets/Grinning face/Color/grinning_face_color.svg",
		"assets/Grinning face/Flat/grinning_face_flat.svg",
		"assets/Grinning face/High Contrast/grinning_face_high_contrast.svg",
		"assets/Waving hand/metadata.json",
		"assets/Waving hand/Dark/Flat/waving_hand_flat_dark.svg",
		"assets/Waving hand/Default/Color/waving_hand_color_default.svg",
		"assets/Waving hand/Default/Flat/waving_hand_flat_default.svg",
		"assets/Waving hand/Light/Flat/waving_hand_flat_light.svg",
		"assets/No flat/metadata.json",
		"assets/No flat/Color/no_flat_color.svg",
	];

	test("lists emoji folders once each, sorted", () => {
		expect(listFluentFolders({ paths })).toEqual([
			"Grinning face",
			"No flat",
			"Waving hand",
		]);
	});

	test("picks Flat directly when the emoji has no skin tones", () => {
		expect(pickDefaultFlatSvgPath({ paths, folder: "Grinning face" })).toBe(
			"assets/Grinning face/Flat/grinning_face_flat.svg",
		);
	});

	test("picks the Default skin tone, not another tone or another style", () => {
		expect(pickDefaultFlatSvgPath({ paths, folder: "Waving hand" })).toBe(
			"assets/Waving hand/Default/Flat/waving_hand_flat_default.svg",
		);
	});

	test("returns null when there is no Flat svg", () => {
		expect(pickDefaultFlatSvgPath({ paths, folder: "No flat" })).toBeNull();
		expect(pickDefaultFlatSvgPath({ paths, folder: "Missing" })).toBeNull();
	});
});

describe("parseEmojiIndex", () => {
	const valid = {
		version: 1 as const,
		source: { fluentEmoji: "a".repeat(40), cldr: "b".repeat(40) },
		groups: ["Smileys & Emotion"],
		items: [
			{ id: "1f600", n: "grinning face", tr: "sırıtan yüz", g: 0, k: ["face"], kt: ["yüz"] },
			{ id: "1f6b6-200d-27a1-fe0f", n: "walking facing right", g: 0, k: [], kt: [] },
		],
	};

	test("accepts a well-formed index and returns it unchanged", () => {
		expect(parseEmojiIndex({ value: structuredClone(valid) })).toEqual(valid);
	});

	test("rejects anything that is not an index", () => {
		for (const value of [null, undefined, 5, "x", [], {}, { ...valid, version: 2 }, { ...valid, groups: "x" }, { ...valid, items: {} }]) {
			expect(() => parseEmojiIndex({ value })).toThrow();
		}
	});

	test("rejects malformed items", () => {
		const withItem = (item: unknown) => ({ ...valid, items: [item] });
		const good = valid.items[0];
		for (const item of [
			null,
			{ ...good, id: "../etc/passwd" },
			{ ...good, id: "" },
			{ ...good, n: 5 },
			{ ...good, tr: 5 },
			{ ...good, g: 1 },
			{ ...good, g: -1 },
			{ ...good, g: 0.5 },
			{ ...good, k: "face" },
			{ ...good, kt: [1] },
		]) {
			expect(() => parseEmojiIndex({ value: withItem(item) })).toThrow();
		}
	});
});

describe("Fluent folder names become file and URL paths, so they are checked", () => {
	test("accepts the real names: letters (also ñ), digits, spaces, '-' and '!'", () => {
		for (const name of ["Grinning face", "Piñata", "On! arrow", "Up! button", "Keycap 10", "Flag-like", "A"]) {
			expect(isSafeFluentFolderName({ name })).toBe(true);
		}
	});

	test("rejects dot names, separators, control characters and padding", () => {
		for (const name of [".", "..", "...", ".hidden", "a.b", "a\\b", "a/b", "a\u0000b", "a\nb", "", " lead", "-lead", "../x", "a%2fb", "a:b"]) {
			expect(isSafeFluentFolderName({ name })).toBe(false);
		}
	});

	test("listFluentFolders refuses a tree with an unsafe folder name instead of using it", () => {
		const paths = ["assets/Fine/metadata.json", "assets/../escape/metadata.json"];
		expect(() => listFluentFolders({ paths })).toThrow(/Unsafe Fluent folder name/);
		expect(() => listFluentFolders({ paths: ["assets/a\\b/metadata.json"] })).toThrow(/Unsafe Fluent folder name/);
	});
});
