import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CameraPinSectionView } from "../camera-pin-section-view";
import { ELEMENT, STATES } from "./pin-view-fixtures";
import type { PinView } from "@/tracking/camera/pin-view";

const noop = () => {};

function render({ view }: { view: PinView }): string {
	return renderToStaticMarkup(
		<CameraPinSectionView
			elementId={ELEMENT.id}
			view={view}
			onStick={noop}
			onCancel={noop}
			onUnstick={noop}
			onModeChange={noop}
			onNoticeAction={noop}
		/>,
	);
}

const html = (name: string) => render({ view: STATES[name] });

describe("the Tracking tab section, in every state (static markup)", () => {
	test("always explains itself and has a title", () => {
		for (const name of Object.keys(STATES)) {
			const markup = html(name);
			expect(markup).toContain("Stick to scene");
			expect(markup).toContain("Follows the video under this clip");
		}
	});

	test("idle: an enabled Stick button, no Unstick, no progress", () => {
		const markup = html("idle");
		expect(markup).toContain(">Stick to scene</button>");
		expect(markup).toContain('aria-disabled="false"');
		expect(markup).not.toContain("Unstick");
		expect(markup).not.toContain("Analysing");
		expect(markup).not.toContain("progressbar");
	});

	test("no video: the button is aria-disabled and the reason is linked to it", () => {
		const markup = html("no video");
		expect(markup).toContain('aria-disabled="true"');
		expect(markup).toContain("There is no video under this clip.");
		expect(markup).toMatch(/aria-describedby="([^"]+)"/);
		const id = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
		expect(markup).toContain(`id="${id}"`);
	});

	test("analysing: a progress bar, the percentage, Cancel reachable, no Stick button", () => {
		const markup = html("analysing");
		expect(markup).toContain('role="progressbar"');
		expect(markup).toContain('aria-label="Analysis progress"');
		expect(markup).toContain(">Analysing... 62%<");
		expect(markup).toContain(">Cancel</button>");
		expect(markup).not.toContain(">Stick to scene</button>");
	});

	test("stuck: the range and mode, Follow as a labelled radio group with Scene selected, Unstick", () => {
		const markup = html("stuck");
		expect(markup).toMatch(/role="status"[^>]*>Stuck 0:00\.0 - 0:08\.4 \(Scene\)</);
		expect(markup).toContain('role="radiogroup"');
		expect(markup).toMatch(/aria-labelledby="[^"]+"/);
		expect(markup).toContain(">Follow</label>");
		expect(markup).toContain(">Scene</label>");
		expect(markup).toContain(">Moving object</label>");
		expect(markup).toMatch(/value="scene"[^>]*aria-checked="true"|aria-checked="true"[^>]*value="scene"/);
		expect(markup).toMatch(/value="object"[^>]*aria-checked="false"|aria-checked="false"[^>]*value="object"/);
		expect(markup).toContain(">Unstick</button>");
		expect(markup).not.toContain(">Stick to scene</button>");
	});

	test("stuck on a moving object selects Moving object", () => {
		const markup = html("stuck, object");
		expect(markup).toContain("(Moving object)");
		expect(markup).toMatch(/value="object"[^>]*aria-checked="true"|aria-checked="true"[^>]*value="object"/);
	});

	test("stale: Stick again and Unstick are both there, with the notice", () => {
		const markup = html("stale");
		expect(markup).toContain(">Stick to scene</button>");
		expect(markup).toContain(">Unstick</button>");
		expect(markup).toContain("The clip changed after sticking. Stick again.");
		expect(markup).not.toContain("radiogroup");
	});

	test("each notice is drawn word for word inside a live region", () => {
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
			expect(markup).toContain(text);
			// The notices region is the last thing in the section.
			expect(markup.slice(markup.lastIndexOf('role="status"'))).toContain(text);
		}
	});

	test("the object notice carries a Use scene button; no other notice does", () => {
		expect(html("object")).toContain(">Use scene</button>");
		for (const name of Object.keys(STATES)) {
			if (!name.startsWith("object")) expect(html(name)).not.toContain("Use scene");
		}
	});

	test("the live region exists even with nothing to say (it must be mounted before it speaks)", () => {
		expect(html("idle")).toContain('role="status"');
	});
});

describe("the section during a run (T4 review)", () => {
	test("the percentage is not a live region; the start is announced once", () => {
		const markup = html("analysing");
		expect(markup).toContain("Analysing... 62%");
		expect(markup).not.toMatch(/role="status"[^>]*>Analysing\.\.\. 62%/);
		expect(markup).toMatch(/role="status"[^>]*>Analysing\.\.\.</);
	});

	test("while another clip is analysed, the Follow choice and Use scene are disabled", () => {
		const markup = html("object, another clip running");
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Use scene<\/button>/);
		expect(markup).toMatch(/role="radiogroup"[^>]*data-disabled=""|data-disabled=""[^>]*role="radiogroup"/);
		const idle = html("object");
		expect(idle).not.toMatch(/disabled=""[^>]*>Use scene/);
		expect(idle).not.toContain("data-disabled");
	});
});
