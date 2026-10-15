import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaDragOverlay } from "../drag-overlay";
import { ImportMenuButton } from "../import-menu-button";
import {
	LinkImportFinishedView,
	LinkImportFormView,
	LinkImportNoticeView,
	LinkImportRunningView,
} from "../link-import-dialog";

// The "Import from link" UI as static markup, driven by the same pure state the dialog uses.

const noop = () => {};
const request = { url: "https://www.youtube.com/watch?v=x", mode: "video" as const, quality: "best" as const };
const countButtons = (markup: string) => (markup.match(/<button/g) ?? []).length;

describe("ImportMenuButton", () => {
	test("without the desktop bridge: exactly the old plain Import button", () => {
		const markup = renderToStaticMarkup(<ImportMenuButton disabled={false} onImportFile={noop} onImportFromLink={null} />);
		expect(countButtons(markup)).toBe(1);
		expect(markup).toContain("Import</button>");
		expect(markup).not.toContain("More ways to import");
		expect(markup).not.toContain("rounded-r-none");
	});

	test("with the bridge: a split button, the chevron labelled; both disabled while processing", () => {
		const markup = renderToStaticMarkup(<ImportMenuButton disabled={false} onImportFile={noop} onImportFromLink={noop} />);
		expect(countButtons(markup)).toBe(2);
		expect(markup).toContain('aria-label="More ways to import"');
		const busy = renderToStaticMarkup(<ImportMenuButton disabled onImportFile={noop} onImportFromLink={noop} />);
		expect(busy.match(/\sdisabled=""/g)).toHaveLength(2);
	});
});

describe("MediaDragOverlay (empty state)", () => {
	test("web build: the one drop/click area as before", () => {
		const markup = renderToStaticMarkup(<MediaDragOverlay isVisible onClick={noop} />);
		expect(countButtons(markup)).toBe(1);
		expect(markup).not.toContain("Import from link");
	});

	test("desktop: a separate 'Import from link' button next to it (a menu cannot sit inside the area, which is itself a button)", () => {
		const markup = renderToStaticMarkup(<MediaDragOverlay isVisible onClick={noop} onImportFromLink={noop} />);
		expect(countButtons(markup)).toBe(2);
		expect(markup).toContain("Import from link</button>");
		expect(markup).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/); // no button inside a button
	});
});

describe("LinkImportFormView", () => {
	const form = (overrides = {}) =>
		renderToStaticMarkup(
			<LinkImportFormView url="" mode="video" quality="best" error={null} onUrlChange={noop} onModeChange={noop} onQualityChange={noop} onSubmit={noop} onClose={noop} {...overrides} />,
		);

	test("a link field, Video / Audio only, the quality; Import disabled while the field is empty", () => {
		const markup = form();
		expect(markup).toContain('type="url"');
		expect(markup).toContain("Video");
		expect(markup).toContain("Audio only");
		expect(markup).toContain("Quality");
		expect(markup).toMatch(/<button[^>]*\sdisabled=""[^>]*>Import<\/button>/);
		expect(form({ url: "https://youtu.be/x" })).toMatch(/<button(?![^>]*\sdisabled="")[^>]*>Import<\/button>/);
	});

	test("it says plainly how the quality is reached: YouTube as two streams combined (H.264, up to 1080p), TikTok as one file", () => {
		const text = form();
		expect(text).toContain("YouTube videos are downloaded as separate H.264 video and AAC audio and combined into one MP4");
		expect(text).toContain("up to 1080p");
		expect(text).toContain("TikTok videos come as one file");
		expect(text).toContain("the resolution you get is shown at the end");
		expect(text).not.toContain("360p");
	});

	test("a refused link shows its message; audio only has no quality choice", () => {
		expect(form({ error: "playlist-refused" })).toContain("Playlist links are not supported");
		expect(form({ mode: "audio" })).not.toContain("Quality");
	});
});

describe("LinkImportNoticeView", () => {
	test("the one-time rights notice, with Back and a clear continue button", () => {
		const markup = renderToStaticMarkup(<LinkImportNoticeView onAcknowledge={noop} onBack={noop} />);
		expect(markup).toContain("Only download content you have the right to use");
		expect(markup).toContain("platform");
		expect(markup).toContain(">Back</button>");
		expect(markup).toContain(">I understand, continue</button>");
	});
});

describe("LinkImportRunningView", () => {
	test("status line and a progress bar with its value; Cancel enabled", () => {
		const markup = renderToStaticMarkup(
			<LinkImportRunningView
				state={{ step: "running", request, job: { phase: "downloading", progress: { downloadedBytes: 50, totalBytes: 100, speed: null, eta: null } }, cancelling: false, retried: false }}
				onCancel={noop}
			/>,
		);
		expect(markup).toContain("Downloading: 50% of 100 B");
		expect(markup).toContain('aria-valuenow="50"');
		expect(markup).toMatch(/<button(?![^>]*\sdisabled="")[^>]*>Cancel<\/button>/);
	});

	test("screen readers: a polite status region with the stage only; the visible line with the percent is hidden from them", () => {
		const at = (percentBytes: number) =>
			renderToStaticMarkup(
				<LinkImportRunningView
					state={{ step: "running", request, job: { phase: "downloading", progress: { downloadedBytes: percentBytes, totalBytes: 100, speed: null, eta: null } }, cancelling: false, retried: false }}
					onCancel={noop}
				/>,
			);
		const region = (markup: string) => markup.match(/<p[^>]*role="status"[^>]*>([^<]*)<\/p>/);
		const first = region(at(10));
		expect(first?.[0]).toContain('aria-live="polite"');
		expect(first?.[1]).toBe("Downloading…");
		expect(region(at(90))?.[1]).toBe(first?.[1]); // a progress tick does not change what is announced
		expect(at(10)).toMatch(/<p[^>]*aria-hidden="true"[^>]*>Downloading: 10% of 100 B<\/p>/);
		const stopping = renderToStaticMarkup(
			<LinkImportRunningView state={{ step: "running", request, job: { phase: "starting" }, cancelling: true, retried: false }} onCancel={noop} />,
		);
		expect(region(stopping)?.[1]).toBe("Stopping…");
	});

	test("while combining video and audio: its own line and percentage, Cancel enabled", () => {
		const markup = renderToStaticMarkup(
			<LinkImportRunningView state={{ step: "running", request, job: { phase: "processing", fraction: 0.25 }, cancelling: false, retried: false }} onCancel={noop} />,
		);
		expect(markup).toContain("Combining video and audio: 25%");
		expect(markup).toContain('aria-valuenow="25"');
		expect(markup).toMatch(/<button(?![^>]*\sdisabled="")[^>]*>Cancel<\/button>/);
	});

	test("after Cancel: 'Cancelling…', disabled; while adding to the project: no working Cancel", () => {
		const cancelling = renderToStaticMarkup(
			<LinkImportRunningView state={{ step: "running", request, job: { phase: "starting" }, cancelling: true, retried: false }} onCancel={noop} />,
		);
		expect(cancelling).toMatch(/<button[^>]*\sdisabled=""[^>]*>Cancelling…<\/button>/);
		const importing = renderToStaticMarkup(
			<LinkImportRunningView state={{ step: "running", request, job: { phase: "importing", fileName: "a.mp4" }, cancelling: false, retried: false }} onCancel={noop} />,
		);
		expect(importing).toMatch(/<button[^>]*\sdisabled=""[^>]*>Cancel<\/button>/);
	});
});

describe("LinkImportFinishedView", () => {
	test("done: what was added and at which resolution; Import another / Close", () => {
		const markup = renderToStaticMarkup(
			<LinkImportFinishedView outcome={{ kind: "done", fileName: "Clip.mp4", mode: "video", quality: "720", width: 640, height: 360, combined: false, combineTried: true }} onBack={noop} onClose={noop} />,
		);
		expect(markup).toContain("Added “Clip.mp4” (640×360).");
		expect(markup).toContain("Ccut could not combine separate video and audio for this link, so the best single file was used: 360p");
		expect(markup).toContain(">Import another</button>");
		expect(markup).toContain(">Close</button>");
		expect(markup).toMatch(/role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/);
		expect(markup).not.toContain('role="alert"');
	});

	test("an error is an alert (assertive); a cancellation is a polite status", () => {
		const error = renderToStaticMarkup(<LinkImportFinishedView outcome={{ kind: "error", code: "timeout" }} onBack={noop} onClose={noop} />);
		expect(error).toContain('role="alert"');
		expect(error).toContain('aria-live="assertive"');
		const cancelled = renderToStaticMarkup(<LinkImportFinishedView outcome={{ kind: "cancelled" }} onBack={noop} onClose={noop} />);
		expect(cancelled).toContain('role="status"');
		expect(cancelled).not.toContain('role="alert"');
	});

	test("error: the message (title text is escaped, never markup) and Try again", () => {
		const markup = renderToStaticMarkup(<LinkImportFinishedView outcome={{ kind: "error", code: "rate-limited" }} onBack={noop} onClose={noop} />);
		expect(markup).toContain("429");
		expect(markup).toContain(">Try again</button>");
		const hostile = renderToStaticMarkup(
			<LinkImportFinishedView outcome={{ kind: "done", fileName: "<img src=x onerror=alert(1)>.mp4", mode: "video", quality: "best", width: null, height: null, combined: false, combineTried: false }} onBack={noop} onClose={noop} />,
		);
		expect(hostile).not.toContain("<img");
		expect(hostile).toContain("&lt;img");
	});
});

describe("wiring (source)", () => {
	const assets = readFileSync(join(import.meta.dir, "..", "views", "assets.tsx"), "utf8");
	const dialog = readFileSync(join(import.meta.dir, "..", "link-import-dialog.tsx"), "utf8");

	test("the dialog exists only where the bridge does; the Import button and the empty state get the link entry from the same place", () => {
		expect(assets).toContain("useLinkImportBridge()");
		expect(assets).toMatch(/\{linkBridge && \(\s*<LinkImportDialog/);
		expect(assets).toContain("<ImportMenuButton");
		expect(assets).toContain("onImportFromLink={openLinkImport ?? undefined}");
	});

	test("the downloaded File goes through the same pipeline as the file picker (processFiles), and success means an asset holds that File", () => {
		expect(assets).toMatch(/await processFiles\(\{ files: \[file\] \}\);\s*return editor\.media\s*\.getAssets\(\)\s*\.some\(\(asset\) => asset\.file === file\)/);
	});

	test("the dialog stops a running import when it is closed or unmounted", () => {
		expect(dialog).toContain("controllerRef.current?.abort()");
		expect(dialog).toMatch(/useEffect\(\s*\(\) =>\s*\(\) => \{\s*controllerRef\.current\?\.abort\(\);/);
	});
});
