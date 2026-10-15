import { describe, expect, test } from "bun:test";
import { decideExit } from "../exit-flow";

describe("decideExit", () => {
	test("leaves right away when the project was saved", () => {
		expect(decideExit({ saved: true, answer: null })).toBe("exit");
	});

	test("a saved project never asks, whatever the answer says", () => {
		expect(decideExit({ saved: true, answer: "stay" })).toBe("exit");
		expect(decideExit({ saved: true, answer: "leave" })).toBe("exit");
	});

	test("asks the user when the final save failed and nobody answered yet", () => {
		expect(decideExit({ saved: false, answer: null })).toBe("ask");
	});

	test("leaves only when the user explicitly chose to lose the changes", () => {
		expect(decideExit({ saved: false, answer: "leave" })).toBe("exit");
	});

	test("stays in the project when the user keeps editing, or dismisses the question", () => {
		// Escape, a click outside and the close button all answer "stay".
		expect(decideExit({ saved: false, answer: "stay" })).toBe("stay");
	});
});
