import { describe, expect, test } from "bun:test";
import {
	readSvgViewBox,
	validateSvgAsset,
	withSvgSize,
} from "../providers/svg-asset";

const GOOD_SVG =
	'<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path d="M0 0h32v32H0z" fill="url(#paint0)"/>\n<defs><linearGradient id="paint0"><stop stop-color="#fff"/></linearGradient></defs>\n</svg>\n';

describe("validateSvgAsset", () => {
	test("accepts a normal SVG with a viewBox and an internal gradient", () => {
		expect(() => validateSvgAsset({ svg: GOOD_SVG, label: "ok" })).not.toThrow();
	});

	test("requires the svg namespace, or <img> will not render it", () => {
		expect(() =>
			validateSvgAsset({
				svg: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>',
				label: "no-xmlns",
			}),
		).toThrow(/xmlns/);
	});

	test("requires a viewBox with positive size", () => {
		expect(() =>
			validateSvgAsset({
				svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
				label: "no-viewbox",
			}),
		).toThrow(/viewBox/);
		expect(() =>
			validateSvgAsset({
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10"><path d="M0 0"/></svg>',
				label: "zero",
			}),
		).toThrow(/viewBox/);
	});

	test("rejects non-SVG and truncated content", () => {
		expect(() =>
			validateSvgAsset({ svg: "<html>404</html>", label: "html" }),
		).toThrow();
		expect(() => validateSvgAsset({ svg: "", label: "empty" })).toThrow();
		expect(() =>
			validateSvgAsset({
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path',
				label: "cut",
			}),
		).toThrow();
	});

	test("rejects active content and external references", () => {
		const wrap = (inner: string) =>
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${inner}</svg>`;
		for (const inner of [
			"<script>alert(1)</script>",
			'<foreignObject><div/></foreignObject>',
			'<path onload="x()" d="M0 0"/>',
			'<image href="https://example.com/a.png"/>',
			'<use xlink:href="http://example.com/a.svg#x"/>',
			'<path style="fill:url(https://example.com/a)" d="M0 0"/>',
			'<a href="javascript:alert(1)"/>',
			"<style>@import url(x.css)</style>",
		]) {
			expect(() =>
				validateSvgAsset({ svg: wrap(inner), label: inner }),
			).toThrow();
		}
	});
});

describe("readSvgViewBox", () => {
	test("reads the four numbers", () => {
		expect(readSvgViewBox({ svg: GOOD_SVG })).toEqual({
			minX: 0,
			minY: 0,
			width: 32,
			height: 32,
		});
	});

	test("accepts commas, decimals and negative origins", () => {
		expect(
			readSvgViewBox({
				svg: '<svg viewBox="-1.5,2 10.25 20" xmlns="http://www.w3.org/2000/svg"></svg>',
			}),
		).toEqual({ minX: -1.5, minY: 2, width: 10.25, height: 20 });
	});

	test("returns null when missing or malformed", () => {
		expect(readSvgViewBox({ svg: "<svg></svg>" })).toBeNull();
		expect(readSvgViewBox({ svg: '<svg viewBox="0 0 a b"></svg>' })).toBeNull();
	});
});

describe("withSvgSize", () => {
	test("rewrites width and height on the root element only", () => {
		const resized = withSvgSize({ svg: GOOD_SVG, size: 512 });
		expect(resized.startsWith('<svg width="512" height="512" viewBox="0 0 32 32"')).toBe(
			true,
		);
		expect(resized.slice(resized.indexOf("\n"))).toBe(
			GOOD_SVG.slice(GOOD_SVG.indexOf("\n")),
		);
	});

	test("adds width and height when the root has none", () => {
		const resized = withSvgSize({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M0 0"/></svg>',
			size: 512,
		});
		expect(resized.startsWith('<svg width="512" height="512" xmlns=')).toBe(true);
		expect(resized).toContain('viewBox="0 0 256 256"');
	});

	test("does not touch stroke-width or nested element sizes", () => {
		const resized = withSvgSize({
			svg: '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5" stroke-width="2"/></svg>',
			size: 512,
		});
		expect(resized).toContain('<rect width="5" height="5" stroke-width="2"/>');
		expect(resized.match(/width="512"/g)?.length).toBe(1);
	});

	test("is idempotent", () => {
		const once = withSvgSize({ svg: GOOD_SVG, size: 512 });
		expect(withSvgSize({ svg: once, size: 512 })).toBe(once);
	});

	test("rejects a non-positive size and non-svg input", () => {
		expect(() => withSvgSize({ svg: GOOD_SVG, size: 0 })).toThrow();
		expect(() => withSvgSize({ svg: GOOD_SVG, size: Number.NaN })).toThrow();
		expect(() => withSvgSize({ svg: "<html/>", size: 512 })).toThrow();
	});
});

describe("validateSvgAsset checks the structure, not just a few bad words", () => {
	const wrap = (inner: string) =>
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${inner}</svg>`;
	const check = (svg: string) => validateSvgAsset({ svg, label: "t" });

	test("accepts the kinds of elements the shipped sets use", () => {
		expect(() =>
			check(
				wrap(
					'<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="4" height="4"/></clipPath></defs>' +
						'<g clip-path="url(#c)" fill="url(#a)"><path d="M0 0h4v4z"/><circle cx="4" cy="4" r="2"/><ellipse cx="1" cy="1" rx="1" ry="2"/></g><use xlink:href="#c"/>',
				),
			),
		).not.toThrow();
	});

	test("accepts comments and whitespace between elements", () => {
		expect(() => check(wrap("<!-- a note -->\n  <path d=\"M0 0\"/>\n"))).not.toThrow();
	});

	test("rejects elements outside the allowed set, even harmless-looking ones", () => {
		for (const inner of [
			"<style>.a{fill:red}</style>",
			"<text>hi</text>",
			'<image width="1" height="1"/>',
			'<a><path d="M0 0"/></a>',
			'<animate attributeName="x" to="1"/>',
			'<set attributeName="x" to="1"/>',
			"<iframe/>",
		]) {
			// iframe is caught earlier, by the active-content check: still a refusal.
			expect(() => check(wrap(inner))).toThrow(/element|active content/i);
		}
	});

	test("rejects markup that is not well formed", () => {
		for (const svg of [
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g><path d="M0 0"/></svg>', // g never closed
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g></svg></g>', // wrong order
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d=M0/></svg>', // unquoted attribute
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0"></svg>', // path not closed
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0" < /></svg>', // stray <
		]) {
			expect(() => check(svg)).toThrow();
		}
	});

	test("rejects entity tricks, CDATA, processing instructions and stray text", () => {
		for (const svg of [
			'<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">&a;</svg>',
			wrap("<![CDATA[ <script>x</script> ]]>"),
			wrap('<?xml-stylesheet href="x.css"?>'),
			wrap("some loose text"),
			wrap("&lt;&gt;"),
		]) {
			expect(() => check(svg)).toThrow();
		}
	});

	test("rejects a custom entity used in an attribute, accepts the five standard ones", () => {
		expect(() => check(wrap('<path d="M0 0" fill="&a;"/>'))).toThrow(/entity/i);
		expect(() => check(wrap('<path d="M0 0" fill="&lol;&lol;"/>'))).toThrow(/entity/i);
		expect(() => check(wrap('<path d="M0 0" data-x="&amp; &lt; &gt; &quot; &apos;"/>'))).not.toThrow();
		// Numeric references are refused outright: they can spell "url(" past every other check.
		expect(() => check(wrap('<path d="M0 0" data-x="&#65;"/>'))).toThrow(/character reference/i);
	});

	test("says why CDATA and processing instructions are refused", () => {
		expect(() => check(wrap("<![CDATA[ x ]]>"))).toThrow(/DOCTYPE, CDATA or processing instruction/);
		expect(() => check(wrap('<?xml version="1.0"?>'))).toThrow(/DOCTYPE, CDATA or processing instruction/);
	});

	test("a nesting bomb is refused rather than walked", () => {
		expect(() => check(wrap("<g>".repeat(5_000) + "</g>".repeat(5_000)))).toThrow(/deep/i);
	});
});

describe("validateSvgAsset in attribute values (the validator is a supply-chain check, not only a parser)", () => {
	const wrap = (inner: string) =>
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${inner}</svg>`;
	const check = (svg: string) => validateSvgAsset({ svg, label: "t" });

	test("refuses character references anywhere: they can spell what the other checks look for", () => {
		expect(() => check(wrap('<path d="M0 0" fill="u&#114;l(http://evil.example/x)"/>'))).toThrow(/character reference/i);
		expect(() => check(wrap('<path d="M0 0" fill="&#x75;rl(http://evil.example/x)"/>'))).toThrow(/character reference/i);
	});

	test("refuses backslashes anywhere: CSS escapes (\\75rl) spell url", () => {
		expect(() => check(wrap('<path d="M0 0" style="fill:\\75rl(//evil.example/x)"/>'))).toThrow(/backslash/i);
	});

	test("refuses a style attribute that is not plain name:value pairs", () => {
		// What only the style rule catches (these would pass every other check):
		for (const style of [
			"width:expression(alert(1))",
			"fill:url(#a)",
			"fill:red !important;x:y/**/",
		]) {
			expect(() => check(wrap(`<path d="M0 0" style="${style}"/>`))).toThrow(
				/style attribute that is not plain name:value pairs/,
			);
		}
		// What an earlier check already refuses: still a refusal, with its own reason.
		for (const [style, reason] of [
			["fill:url(//evil.example/x)", /external url\(\)/],
			["background:red;behavior:url(x.htc)", /external url\(\)/],
			["fill: red; }</style><script>", /active content/],
			["@import 'x'", /@import/],
		] as const) {
			expect(() => check(wrap(`<path d="M0 0" style="${style}"/>`))).toThrow(reason);
		}
	});

	test("accepts the style values the shipped flags use", () => {
		for (const style of [
			"-inkscape-stroke:none",
			"marker:none",
			"line-height:normal;text-indent:0;text-align:start;text-decoration-line:none;text-transform:none;marker:none",
			"line-height:125%;text-align:center",
			"-inkscape-font-specification:&quot;Ubuntu Bold&quot;",
			"fill:#ff0000;stroke-width:1.5",
		]) {
			expect(() => check(wrap(`<path d="M0 0" style="${style}"/>`))).not.toThrow();
		}
	});

	test("refuses a <use> bomb: 41 groups that each use the one before, 2^40 elements in about 2 KB", () => {
		let defs = '<g id="a0"><path d="M0 0"/></g>';
		for (let level = 1; level <= 40; level++) {
			defs += `<g id="a${level}"><use href="#a${level - 1}"/><use href="#a${level - 1}"/></g>`;
		}
		const bomb = wrap(`<defs>${defs}</defs><use href="#a40"/>`);
		expect(bomb.length).toBeLessThan(4_000);
		expect(() => check(bomb)).toThrow(/expands to too many/i);
	});

	test("refuses a use that points at itself, directly or around a loop", () => {
		expect(() => check(wrap('<g id="a"><use href="#a"/></g>'))).toThrow(/loop|itself|cycle/i);
		expect(() => check(wrap('<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>'))).toThrow(/loop|itself|cycle/i);
	});

	test("accepts ordinary reuse: a shape used a few times, and a use of a use", () => {
		expect(() => check(wrap('<defs><path id="p" d="M0 0h4v4z"/></defs><use href="#p"/><use href="#p" x="2"/>'))).not.toThrow();
		expect(() => check(wrap('<defs><path id="p" d="M0 0h4v4z"/><g id="g"><use href="#p"/></g></defs><use href="#g"/><use href="#g" x="2"/>'))).not.toThrow();
	});

	test("refuses a file with an absurd number of elements", () => {
		expect(() => check(wrap('<path d="M0 0"/>'.repeat(6_000)))).toThrow(/too many elements/i);
	});

	test("a reference to an id that is not there is not an expansion: it draws nothing", () => {
		expect(() => check(wrap('<use href="#missing"/>'))).not.toThrow();
	});
});
