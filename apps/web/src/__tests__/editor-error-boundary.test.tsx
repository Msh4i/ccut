import { describe, expect, mock, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

describe("the editor's error page", () => {
	test("tells the user what happened and offers a way out", async () => {
		const { default: EditorError } = await import("@/app/editor/[project_id]/error");
		const error = Object.assign(new Error("boom"), { digest: "abc" });
		const html = renderToStaticMarkup(<EditorError error={error} reset={mock(() => {})} />);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Something went wrong");
		expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
		expect(html).toMatch(/<a[^>]*href="\/projects"[^>]*>Back to projects<\/a>/);
		expect(html).not.toContain("boom"); // internals are for the console, not the user
	});

	test("the heading can take focus, so a keyboard or screen reader user lands on the message", async () => {
		const { default: EditorError } = await import("@/app/editor/[project_id]/error");
		const html = renderToStaticMarkup(<EditorError error={new Error("x")} reset={mock(() => {})} />);
		expect(html).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Something went wrong<\/h1>/);
	});

	test("the page moves focus to the heading when it appears", async () => {
		const { focusErrorHeading } = await import("@/app/editor/[project_id]/error");
		const focus = mock((_options: FocusOptions) => {});
		focusErrorHeading({ heading: { focus } });
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		expect(() => focusErrorHeading({ heading: null })).not.toThrow();
	});

	test("logs the error it caught", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const { reportEditorError } = await import("@/app/editor/[project_id]/error");
		const error = new Error("render failed");
		reportEditorError({ error });
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(consoleError.mock.calls[0]?.[1]).toBe(error);
		consoleError.mockRestore();
	});
});
