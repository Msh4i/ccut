import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExportState } from "@/export";
import { IDLE_EXPORT_STATE, exportJobView } from "@/export/job-view";
import { ExportDoneView, ExportRunningView } from "../export-button";

// The export window's running and finished views as the user gets them (static markup),
// driven by the same pure view the window uses.

const noop = () => {};

function runningMarkup(overrides: Partial<ExportState> = {}): string {
	const view = exportJobView({ state: { ...IDLE_EXPORT_STATE, isExporting: true, phase: "encoding", framesDone: 5, frameCount: 10, ...overrides } });
	if (view.view !== "running") throw new Error(`expected the running view, got ${view.view}`);
	return renderToStaticMarkup(<ExportRunningView view={view} onCancel={noop} />);
}

describe("ExportRunningView", () => {
	test("while it can be stopped: an enabled Cancel button", () => {
		const markup = runningMarkup();
		expect(markup).toContain(">Cancel</button>");
		expect(markup).not.toMatch(/\sdisabled(=|>|\s)/); // the class "disabled:opacity-50" is not the attribute
		expect(markup).toContain("Encoding frame 5 of 10");
	});

	test("after Cancel was pressed: a disabled 'Cancelling…' button and a status that says the export is stopping", () => {
		const markup = runningMarkup({ cancelling: true, phase: "preparing", framesDone: 0, frameCount: 0 });
		expect(markup).toMatch(/<button[^>]*\sdisabled=""[^>]*>Cancelling…<\/button>/);
		expect(markup).not.toContain(">Cancel</button>");
		expect(markup).toContain("Stopping the export…");
	});

	test("while the file is being finished there is no Cancel button at all (it would not cancel)", () => {
		const markup = runningMarkup({ phase: "finalizing" });
		expect(markup).not.toContain("<button");
		expect(markup).not.toContain("Cancel");
		expect(markup).toContain("Finishing the file…");
	});

	test("with the save dialog still open it says so", () => {
		const markup = runningMarkup({ phase: null, framesDone: 0, frameCount: 0 });
		expect(markup).toContain("Waiting for the save location…");
		expect(markup).not.toContain("Preparing fonts");
	});
});

describe("ExportDoneView", () => {
	const doneView = (state: Partial<ExportState>) => {
		const view = exportJobView({ state: { ...IDLE_EXPORT_STATE, result: { success: true, file: { displayName: "clip.mp4", bytes: 1500, revealToken: "t" } }, ...state } });
		if (view.view !== "done") throw new Error(`expected the done view, got ${view.view}`);
		return view;
	};

	test("Show in folder and Done; no message by default", () => {
		const markup = renderToStaticMarkup(<ExportDoneView view={doneView({})} revealMessage={null} onReveal={noop} onDone={noop} />);
		expect(markup).toContain("Saved clip.mp4");
		expect(markup).toContain("Show in folder");
		expect(markup).toContain(">Done</button>");
		expect(markup).not.toContain("Could not open the folder");
	});

	test("when Show in folder had nothing to show, the message is on the screen", () => {
		const markup = renderToStaticMarkup(
			<ExportDoneView view={doneView({})} revealMessage={'Could not open the folder for "clip.mp4" any more.'} onReveal={noop} onDone={noop} />,
		);
		expect(markup).toContain('Could not open the folder for &quot;clip.mp4&quot; any more.');
	});

	test("a browser download has no Show in folder", () => {
		const view = doneView({ result: { success: true, buffer: new ArrayBuffer(10) } });
		const markup = renderToStaticMarkup(<ExportDoneView view={view} revealMessage={null} onReveal={noop} onDone={noop} />);
		expect(markup).not.toContain("Show in folder");
	});
});

describe("ExportDialog wiring (source)", () => {
	const source = readFileSync(join(import.meta.dir, "..", "export-button.tsx"), "utf8");

	test("closing the dialog returns focus to the Export button: the handler is given to the content, and the button ref is the one it reads", () => {
		expect(source).toMatch(/onCloseAutoFocus=\{createCloseAutoFocusHandler\(\{\s*target: getReturnFocusTarget,?\s*\}\)\}/);
		expect(source).toMatch(/<button\s+ref=\{buttonRef\}/);
		expect(source).toMatch(/getReturnFocusTarget=\{\(\) => buttonRef\.current\}/);
	});

	test("Show in folder reports a failed reveal through revealOutcomeMessage, and the message is cleared on a new export and on close", () => {
		expect(source).toMatch(/revealOutcomeMessage\(\{\s*revealed,/);
		expect(source).toMatch(/onReveal=\{handleReveal\}/);
		expect(source.match(/setRevealMessage\(null\)/g)?.length).toBe(2);
	});

	test("the running view's Cancel goes to the project manager", () => {
		expect(source).toMatch(/onCancel=\{\(\) => editor\.project\.cancelExport\(\)\}/);
	});
});
