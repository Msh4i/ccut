import { describe, expect, test } from "bun:test";
import { createCloseAutoFocusHandler } from "../focus-return";

function fakeEvent() {
	const calls = { preventDefault: 0 };
	const event = new Event("focusScope.autoFocusOnUnmount", { cancelable: true });
	event.preventDefault = () => {
		calls.preventDefault += 1;
	};
	return { event, calls };
}

describe("createCloseAutoFocusHandler", () => {
	test("cancels the default (which would focus a trigger that is not there) and focuses the button instead", () => {
		const focused: string[] = [];
		const handler = createCloseAutoFocusHandler({ target: () => ({ focus: () => focused.push("export button") }) });
		const { event, calls } = fakeEvent();
		handler(event);
		expect(calls.preventDefault).toBe(1);
		expect(focused).toEqual(["export button"]);
	});

	test("the target is looked up when the dialog closes, not when the handler is made (the button may mount later)", () => {
		let button: { focus: () => void } | null = null;
		const handler = createCloseAutoFocusHandler({ target: () => button });
		const focused: string[] = [];
		button = { focus: () => focused.push("late") };
		handler(fakeEvent().event);
		expect(focused).toEqual(["late"]);
	});

	test("with no button (it is gone), it still cancels the default and does not throw", () => {
		const handler = createCloseAutoFocusHandler({ target: () => null });
		const { event, calls } = fakeEvent();
		expect(() => handler(event)).not.toThrow();
		expect(calls.preventDefault).toBe(1);
	});
});
