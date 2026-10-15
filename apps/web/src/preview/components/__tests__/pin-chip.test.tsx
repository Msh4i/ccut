import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ELEMENT, STATES, viewOf } from "@/tracking/components/__tests__/pin-view-fixtures";
import { ANALYSING_ANNOUNCEMENT, CANCELLED_ANNOUNCEMENT, type PinView } from "@/tracking/camera/pin-view";
import { PinChipView } from "../pin-chip-view";

const noop = () => {};

function render({ view }: { view: PinView }): string {
	return renderToStaticMarkup(
		<PinChipView view={view} onStick={noop} onCancel={noop} onUnstick={noop} onModeChange={noop} onNoticeAction={noop} />,
	);
}

const html = (name: string) => render({ view: STATES[name] });

function renderCompact({ view }: { view: PinView }): string {
	return renderToStaticMarkup(
		<PinChipView compact view={view} onStick={noop} onCancel={noop} onUnstick={noop} onModeChange={noop} onNoticeAction={noop} />,
	);
}

const compactHtml = (name: string) => renderCompact({ view: STATES[name] });

describe("the preview chip, in every state (static markup)", () => {
	test("state 1, idle: one enabled button", () => {
		const markup = html("idle");
		expect(ELEMENT.type).toBe("text");
		expect(markup).toContain("Stick to scene");
		expect(markup).toContain('aria-disabled="false"');
		expect(markup).not.toContain("Unstick");
		expect(markup).not.toContain("Cancel");
	});

	test("no video: the reason, and a button that cannot be pressed is not offered", () => {
		const markup = html("no video");
		expect(markup).toContain("There is no video under this clip.");
		expect(markup).not.toContain("Stick to scene");
	});

	test("state 2, analysing: the bar, the percentage and Cancel", () => {
		const markup = html("analysing");
		expect(markup).toContain('role="progressbar"');
		expect(markup).toContain("Analysing... 62%");
		expect(markup).toContain(">Cancel</button>");
		expect(markup).not.toContain("Stick to scene");
	});

	test("state 3, stuck: Stuck, Unstick, and the Follow choice naming the mode", () => {
		const markup = html("stuck");
		expect(markup).toContain(">Stuck</span>");
		expect(markup).toContain(">Unstick</button>");
		expect(markup).toContain('aria-label="Follow"');
		expect(markup).toContain("Follow:");
		expect(markup).toContain("Scene");
		expect(html("stuck, object")).toContain("Moving object");
	});

	test("stale: Stick to scene again and Unstick", () => {
		const markup = html("stale");
		expect(markup).toContain("Stick to scene");
		expect(markup).toContain(">Unstick</button>");
		expect(markup).toContain("The clip changed after sticking. Stick again.");
	});

	test("state 4, every notice is drawn word for word", () => {
		const expected: Record<string, string> = {
			"no texture": "Not enough detail in this clip to follow the scene.",
			"no motion": "No camera movement in this clip, nothing to stick to.",
			cut: "Scene cut at 0:05.2, stuck until there.",
			"low quality": "Video quality is low, the stick may drift.",
			lost: "Lost track of the scene part of the way, stuck until there.",
			object: "This spot moves differently from the scene: following the object.",
			"not ready": "Stick to scene is not ready in this build.",
		};
		for (const [name, text] of Object.entries(expected)) {
			const markup = html(name);
			// The notices region is the last thing in the chip.
			expect(markup.slice(markup.lastIndexOf('role="status"'))).toContain(text);
		}
	});

	test("the object notice offers Use scene", () => {
		expect(html("object")).toContain(">Use scene</button>");
		expect(html("low quality")).not.toContain("Use scene");
	});

	test("notices sit in a live region that is always mounted", () => {
		for (const name of Object.keys(STATES)) {
			expect(html(name)).toContain('role="status"');
		}
	});
});

describe("the preview chip during a run (T4 review)", () => {
	test("the percentage is not a live region: it is drawn, not announced ten times a second", () => {
		const markup = html("analysing");
		expect(markup).toContain("Analysing... 62%");
		expect(markup).not.toMatch(/role="status"[^>]*>Analysing\.\.\. 62%/);
		// the start is announced once, without the number
		expect(markup).toMatch(/role="status"[^>]*>Analysing\.\.\.</);
	});

	test("while another clip is analysed, Follow and Use scene cannot start a second run", () => {
		const markup = html("object, another clip running");
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Use scene<\/button>/);
		expect(markup).toMatch(/<button[^>]*aria-label="Follow"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="Follow"/);
		const idle = html("object");
		expect(idle).not.toMatch(/disabled=""[^>]*>Use scene/);
		expect(idle).not.toMatch(/<button[^>]*aria-label="Follow"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="Follow"/);
	});
});

describe("the compact chip (no room that keeps clear of the transform handles): one button, every state", () => {
	test("it is one button and nothing else you can press, whatever the state", () => {
		for (const name of Object.keys(STATES)) {
			const markup = compactHtml(name);
			expect(markup.match(/<button/g)?.length).toBe(1);
			expect(markup).not.toContain("Use scene");
			expect(markup).not.toContain("Follow");
		}
	});

	test("idle: Stick to scene; stuck: Unstick; analysing: Cancel; stale: Stick again", () => {
		expect(compactHtml("idle")).toContain('aria-label="Stick to scene"');
		expect(compactHtml("stuck")).toContain('aria-label="Unstick"');
		expect(compactHtml("analysing")).toContain('aria-label="Cancel"');
		expect(compactHtml("stale")).toContain(`aria-label="${STATES.stale.stickLabel}"`);
		expect(compactHtml("idle")).toContain('aria-disabled="false"');
	});

	test("a clip with no video under it offers a button that cannot be pressed, and says why", () => {
		const markup = compactHtml("no video");
		expect(markup).toContain('aria-disabled="true"');
		expect(markup).toContain("There is no video under this clip.");
	});

	test("the state and the notices are in the tooltip, and the live region is still mounted", () => {
		expect(compactHtml("low quality")).toContain("Video quality is low, the stick may drift.");
		expect(compactHtml("stuck")).toContain(STATES.stuck.stuck?.label ?? "never");
		expect(compactHtml("analysing")).toContain("Analysing... 62%");
		for (const name of Object.keys(STATES)) expect(compactHtml(name)).toContain('role="status"');
	});

	test("it is a small fixed box", () => {
		expect(compactHtml("idle")).toMatch(/style="width:32px;height:32px"/);
	});
});

/** The text of every live region (`role="status"`) in the markup: regions of the compact chip hold only paragraphs. */
function liveRegionTexts({ markup }: { markup: string }): string[] {
	return [...markup.matchAll(/<div[^>]*role="status"[^>]*>([\s\S]*?)<\/div>/g)].map((match) =>
		match[1].replace(/<[^>]*>/g, "\n").replace(/&#x27;/g, "'"),
	);
}

function titleOf({ markup }: { markup: string }): string {
	const match = /title="([^"]*)"/.exec(markup);
	if (!match) throw new Error("the compact button has no title");
	return match[1];
}

describe("the compact chip says what the stick came to (M3 of the review: it ended with no visible or announced result)", () => {
	const withNotices = Object.keys(STATES).filter((name) => STATES[name].notices.length > 0);
	const without = Object.keys(STATES).filter((name) => STATES[name].notices.length === 0);

	test("the fixtures cover both: states with notices (every kind) and states without", () => {
		expect(withNotices).toEqual(expect.arrayContaining(["no texture", "no motion", "cut", "low quality", "lost", "object", "not ready", "stale"]));
		expect(without).toEqual(expect.arrayContaining(["idle", "analysing", "stuck"]));
	});

	test("every notice's TEXT is inside a polite live region that nobody sees (sr-only), not only in the tooltip", () => {
		for (const name of withNotices) {
			const markup = compactHtml(name);
			expect(markup).toMatch(/<div[^>]*role="status"[^>]*aria-live="polite"[^>]*class="sr-only"/);
			const regions = liveRegionTexts({ markup });
			expect(regions.length).toBeGreaterThan(0);
			for (const notice of STATES[name].notices) {
				expect(notice.text.length).toBeGreaterThan(0);
				expect(regions.some((text) => text.includes(notice.text))).toBe(true);
			}
		}
	});

	test("a notice that is not there is not announced: no states without notices mention one", () => {
		for (const name of without) {
			const regions = liveRegionTexts({ markup: compactHtml(name) });
			expect(regions.join("\n")).not.toContain("Video quality is low");
			expect(regions.join("\n")).not.toContain("Not enough detail");
		}
	});

	test("the run's announcement is still read: the start (Analysing...) and a cancel", () => {
		const analysing = liveRegionTexts({ markup: compactHtml("analysing") }).join("\n");
		expect(ANALYSING_ANNOUNCEMENT.length).toBeGreaterThan(0);
		expect(analysing).toContain(ANALYSING_ANNOUNCEMENT);
		// the percentage is drawn in the tooltip but never announced
		expect(analysing).not.toContain("62%");
		const cancelled = viewOf({ outcomes: { [ELEMENT.id]: { status: "cancelled", elementId: ELEMENT.id } } });
		expect(cancelled.announcement).toBe(CANCELLED_ANNOUNCEMENT);
		expect(liveRegionTexts({ markup: renderCompact({ view: cancelled }) }).join("\n")).toContain(CANCELLED_ANNOUNCEMENT);
	});

	test("the live region stays mounted when there is nothing to say, so the first notice is announced", () => {
		for (const name of without) {
			expect(compactHtml(name)).toMatch(/<div[^>]*role="status"[^>]*class="sr-only"/);
		}
	});

	test("a small warning dot sits on the button while notices exist, and only then", () => {
		for (const name of withNotices) expect(compactHtml(name)).toContain("data-notice-dot");
		for (const name of without) expect(compactHtml(name)).not.toContain("data-notice-dot");
		// the dot is part of the one button, drawn without a name of its own, and never takes a press
		const dotted = compactHtml("low quality");
		expect(dotted.match(/<button/g)?.length).toBe(1);
		expect(dotted).toMatch(/<button[^>]*>[\s\S]*<span[^>]*aria-hidden="true"[^>]*data-notice-dot[^>]*pointer-events-none/);
	});

	test("the tooltip lists the parts on their own lines: no '..' when a notice already ends with a period", () => {
		expect(titleOf({ markup: compactHtml("no texture") })).toBe("Stick to scene\nNot enough detail in this clip to follow the scene.");
		expect(titleOf({ markup: compactHtml("no video" ) })).toBe("Stick to scene\nThere is no video under this clip.");
		for (const name of Object.keys(STATES)) {
			// "..." (Analysing...) is a word's own ellipsis; two dots in a row are a join gone wrong
			expect(titleOf({ markup: compactHtml(name) })).not.toMatch(/(^|[^.])\.\.([^.]|$)/);
		}
		// more than one part: the label, the state and every notice, none lost
		const title = titleOf({ markup: compactHtml("stale") });
		expect(title.split("\n")).toEqual(["Stick to scene", ...STATES.stale.notices.map((notice) => notice.text)]);
	});
});
