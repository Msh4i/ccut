import { describe, expect, test } from "bun:test";
import { createFocusModality } from "../focus-modality";

describe("createFocusModality", () => {
	test("starts as keyboard on a fresh page", () => {
		expect(createFocusModality().isKeyboard()).toBe(true);
	});

	test("a pointerdown switches to pointer", () => {
		const modality = createFocusModality();
		modality.onPointerDown();
		expect(modality.isKeyboard()).toBe(false);
	});

	test("Tab and Shift+Tab switch back to keyboard", () => {
		const modality = createFocusModality();
		modality.onPointerDown();
		modality.onKeyDown({ key: "Tab" });
		expect(modality.isKeyboard()).toBe(true);

		modality.onPointerDown();
		// Shift is a modifier flag, the key stays "Tab".
		modality.onKeyDown({ key: "Tab" });
		expect(modality.isKeyboard()).toBe(true);
	});

	test("a second pointerdown after Tab switches to pointer again", () => {
		const modality = createFocusModality();
		modality.onPointerDown();
		modality.onKeyDown({ key: "Tab" });
		modality.onPointerDown();
		expect(modality.isKeyboard()).toBe(false);
	});

	test("keys other than Tab never switch to keyboard", () => {
		const modality = createFocusModality();
		modality.onPointerDown();
		for (const key of [
			" ",
			"Enter",
			"k",
			"Home",
			"ArrowLeft",
			"Escape",
			"Shift",
		]) {
			modality.onKeyDown({ key });
			expect(modality.isKeyboard()).toBe(false);
		}
	});

	test("keys do not change an already keyboard modality", () => {
		const modality = createFocusModality();
		modality.onKeyDown({ key: " " });
		expect(modality.isKeyboard()).toBe(true);
	});

	test("trackers are independent", () => {
		const first = createFocusModality();
		const second = createFocusModality();
		first.onPointerDown();
		expect(first.isKeyboard()).toBe(false);
		expect(second.isKeyboard()).toBe(true);
	});
});
