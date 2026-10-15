import { describe, expect, test } from "bun:test";
import { isExternalTextureCurrent } from "../texture-cache";

// Video frames reach the compositor in a small pool of canvases that the decoder
// redraws with the next frames (video frame cache, three canvases). The same
// canvas object therefore comes back holding different pixels. Treating "same
// object" as "same pixels" left the preview on an old frame whenever a seek
// landed the new frame in the canvas the compositor had cached (play, pause,
// press Home; or the preview after a cancelled export).

// Only the object identity of a source matters to the rule.
const canvas = {};
const otherCanvas = {};

const cached = { source: canvas, width: 1280, height: 720, version: 1.067 };

describe("isExternalTextureCurrent", () => {
	test("nothing cached: upload", () => {
		expect(isExternalTextureCurrent({ previous: undefined, next: cached })).toBe(false);
	});

	test("same object, same size, same version: the upload is skipped", () => {
		expect(isExternalTextureCurrent({ previous: cached, next: { ...cached } })).toBe(true);
	});

	test("same object redrawn with another frame (new version): upload", () => {
		expect(isExternalTextureCurrent({ previous: cached, next: { ...cached, version: 0 } })).toBe(false);
	});

	test("another object: upload", () => {
		expect(isExternalTextureCurrent({ previous: cached, next: { ...cached, source: otherCanvas } })).toBe(false);
	});

	test("another size: upload", () => {
		expect(isExternalTextureCurrent({ previous: cached, next: { ...cached, width: 640 } })).toBe(false);
		expect(isExternalTextureCurrent({ previous: cached, next: { ...cached, height: 360 } })).toBe(false);
	});

	test("sources that never change carry no version and are cached by object as before", () => {
		const image = { source: canvas, width: 64, height: 64, version: undefined };
		expect(isExternalTextureCurrent({ previous: image, next: { ...image } })).toBe(true);
		expect(isExternalTextureCurrent({ previous: image, next: { ...image, source: otherCanvas } })).toBe(false);
	});

	test("a versioned source never matches the same object cached without a version", () => {
		expect(isExternalTextureCurrent({ previous: { ...cached, version: undefined }, next: cached })).toBe(false);
	});
});
