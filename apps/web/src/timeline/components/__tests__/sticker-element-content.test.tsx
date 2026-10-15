import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StickerElementContent } from "../sticker-element-content";

const element = { name: "Fire", stickerId: "emoji:1f525" };

describe("StickerElementContent (the thumbnail and name on the timeline)", () => {
	test("shows the sticker's image and name", () => {
		const html = renderToStaticMarkup(<StickerElementContent element={element} />);
		expect(html).toContain('src="/emoji/fluent-flat/1f525.svg"');
		expect(html).toContain("Fire");
		expect(html).not.toContain("Missing sticker");
	});

	test("an id that cannot be resolved renders a placeholder instead of throwing", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		for (const stickerId of ["unknown:thing", "garbage", "logos:/../api/health", ""]) {
			const html = renderToStaticMarkup(<StickerElementContent element={{ name: "Broken", stickerId }} />);
			expect(html).toContain('aria-label="Missing sticker"');
			expect(html).toContain("Broken"); // the element can still be selected, found and deleted by its name
			expect(html).not.toContain("<img");
		}
		warn.mockRestore();
	});
});

describe("StickerElementContent with a damaged element (a saved project is not typed)", () => {
	const BAD_IDS: [string, unknown][] = [
		["number", 123],
		["null", null],
		["undefined", undefined],
		["object", {}],
		["array", []],
		["boolean", true],
		["bigint", BigInt(1)],
		["symbol", Symbol("x")],
		["function", () => 1],
	];

	for (const [kind, stickerId] of BAD_IDS) {
		test(`a ${kind} as the sticker id renders the placeholder, it does not take the editor down`, () => {
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			const html = renderToStaticMarkup(<StickerElementContent element={{ name: "Damaged", stickerId }} />);
			expect(html).toContain('aria-label="Missing sticker"');
			expect(html).toContain("Damaged");
			warn.mockRestore();
		});
	}

	test("a name that is not a string cannot break the render either", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		for (const name of [undefined, null, 5, {}, ["a"], Symbol("n")]) {
			const html = renderToStaticMarkup(<StickerElementContent element={{ name, stickerId: "emoji:1f525" }} />);
			expect(html).toContain('src="/emoji/fluent-flat/1f525.svg"');
		}
		warn.mockRestore();
	});

	test("the image is decorative: the name beside it is read once, not twice", () => {
		const html = renderToStaticMarkup(<StickerElementContent element={{ name: "Fire", stickerId: "emoji:1f525" }} />);
		expect(html).toContain('alt=""');
		expect(html.match(/Fire/g)).toHaveLength(1);
	});
});
