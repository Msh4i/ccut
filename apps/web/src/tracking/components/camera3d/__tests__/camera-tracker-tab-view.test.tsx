import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CAMERA_TRACKER_NOT_READY_MESSAGE } from "@/tracking/camera3d/session";
import { CAMERA_SOLVE_MESSAGES, type CameraTrackerPhase } from "@/tracking/camera3d/types";
import { buildTrackingTab, TAB_REASONS } from "@/tracking/camera3d/ui/tab-model";
import {
	buildData,
	buildDecoded,
	buildSolve,
	straightCamera,
} from "@/tracking/camera3d/ui/__tests__/fixtures";
import { CameraTrackerTabView } from "../camera-tracker-tab-view";

const noop = () => {};
const idle: CameraTrackerPhase = { phase: "idle" };
const solve = buildSolve({
	cameras: [straightCamera([0, 0, -1000])],
	points: [{ trackId: 0, position: [0, 0, 0] }],
});

function render({
	apiReady = true,
	phase = idle,
	decoded = null,
}: {
	apiReady?: boolean;
	phase?: CameraTrackerPhase;
	decoded?: ReturnType<typeof buildDecoded> | null;
}): string {
	const model = buildTrackingTab({ apiReady, elementId: "v", phase, decoded });
	return renderToStaticMarkup(
		<CameraTrackerTabView
			elementId="v"
			model={model}
			values={model.settings}
			onPrimary={noop}
			onStaleAction={noop}
			onCreateCamera={noop}
			onSettingPreview={noop}
			onSettingCommit={noop}
		/>,
	);
}

function describedReason({ markup, label }: { markup: string; label: string }): string | null {
	const button = new RegExp(`<button[^>]*aria-describedby="([^"]+)"[^>]*>${label}</button>`).exec(markup);
	if (!button) return null;
	const reason = new RegExp(`id="${button[1]}"[^>]*>([^<]+)<`).exec(markup);
	return reason ? reason[1] : null;
}

describe("the Tracking tab (static markup)", () => {
	test("every AE effect control is there, labelled", () => {
		const markup = render({ decoded: buildDecoded({ solve }) });
		for (const label of [
			"Shot Type",
			"Show Track Points",
			"Render Track Points",
			"Track Point Size",
			"Target Size",
			"Create Camera",
			"Solve Method",
			"Method Used",
			"Average Error",
			"Detailed Analysis",
			"Auto-delete Points Across Time",
			"Hide Warning Banner",
		]) {
			expect(markup).toContain(label);
		}
		// selects are named by their label
		expect(markup).toContain('aria-label="Shot Type"');
		expect(markup).toContain('aria-label="Solve Method"');
		// every switch has a label pointing at it
		const switchIds = [...markup.matchAll(/role="switch"[^>]*id="([^"]+)"|id="([^"]+)"[^>]*role="switch"/g)].map((match) => match[1] ?? match[2]);
		expect(switchIds).toHaveLength(4);
		for (const id of switchIds) expect(markup).toContain(`for="${id}"`);
		expect(markup).not.toContain("Horizontal Angle of View");
	});

	test("never tracked: an enabled Track Camera button; the controls are inert and say why", () => {
		const markup = render({});
		expect(markup).toMatch(/<button[^>]*aria-disabled="false"[^>]*>Track Camera<\/button>/);
		expect(markup).toContain('inert=""');
		expect(markup).toContain(TAB_REASONS.notTracked);
		expect(describedReason({ markup, label: "Create Camera" })).toBe(TAB_REASONS.noSolve);
	});

	test("no engine: Track Camera is disabled and linked to the not-ready message", () => {
		const markup = render({ apiReady: false });
		expect(markup).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Track Camera<\/button>/);
		expect(describedReason({ markup, label: "Track Camera" })).toBe(CAMERA_TRACKER_NOT_READY_MESSAGE);
	});

	test("solved: Analyze, the summary, Method Used and Average Error; controls live", () => {
		const markup = render({ decoded: buildDecoded({ solve }) });
		expect(markup).toContain(">Analyze</button>");
		expect(markup).toContain("1 point, 1 frame");
		expect(markup).toContain(">Typical<");
		expect(markup).toContain(">0.38 px<");
		expect(markup).not.toContain('inert=""');
	});

	test("running here: Cancel and a labelled progress bar", () => {
		const markup = render({ phase: { phase: "solving", elementId: "v", progress: 0.3 }, decoded: buildDecoded({ solve }) });
		expect(markup).toContain(">Cancel</button>");
		expect(markup).toContain('role="progressbar"');
		expect(markup).toContain('aria-label="Track Camera progress"');
		expect(markup).toContain("Solving camera (Step 2 of 2) 30%");
	});

	test("failed and stale: the message and the Solve button; Specify Angle shows its field", () => {
		const failure = { reason: "no-texture" as const, message: CAMERA_SOLVE_MESSAGES["no-texture"] };
		const failed = render({ decoded: buildDecoded({ data: buildData({ failure, hasSolve: false }), solve: null }) });
		expect(failed).toContain(CAMERA_SOLVE_MESSAGES["no-texture"]);
		const stale = render({ decoded: buildDecoded({ data: buildData({ stale: "solve", settings: { shotType: "specify-angle" } }), solve }) });
		expect(stale).toContain("Settings changed. Solve again.");
		expect(stale).toContain(">Solve</button>");
		expect(stale).toContain("Horizontal Angle of View");
	});
});
