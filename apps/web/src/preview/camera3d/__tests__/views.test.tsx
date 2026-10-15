import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CAMERA_TRACKER_BANNERS } from "@/tracking/camera3d/types";
import type { BannerModel } from "@/tracking/camera3d/ui/banner-model";
import { CameraTrackerBanner } from "../camera-tracker-banner";
import { CameraPointsView } from "../camera-points-view";
import type { PointsDrawing } from "../points-drawing";

const noop = () => {};

function banner(model: BannerModel | null): string {
	return renderToStaticMarkup(<CameraTrackerBanner banner={model} onCancel={noop} onAction={noop} />);
}

function liveRegion(markup: string): string | null {
	return /<p role="status" aria-live="polite"[^>]*>([^<]*)<\/p>/.exec(markup)?.[1] ?? null;
}

describe("the banner (static markup)", () => {
	test("the live region is always there, empty when there is nothing to say", () => {
		expect(liveRegion(banner(null))).toBe("");
	});

	test("analyzing: the phase in the live region (no percent), a labelled progress bar, a named Cancel", () => {
		const markup = banner({ kind: "analyzing", text: CAMERA_TRACKER_BANNERS.analyzing, percent: 42, elementId: "v" });
		expect(liveRegion(markup)).toBe(CAMERA_TRACKER_BANNERS.analyzing);
		expect(markup).toContain('role="progressbar"');
		expect(markup).toContain('aria-valuenow="42"');
		expect(markup).toContain(">42%<");
		expect(markup).toMatch(/<button[^>]*aria-label="Cancel Track Camera"[^>]*>Cancel<\/button>/);
	});

	test("the live region text does not change with the percent", () => {
		const at = (percent: number) => liveRegion(banner({ kind: "solving", text: CAMERA_TRACKER_BANNERS.solving, percent, elementId: "v" }));
		expect(at(10)).toBe(at(90));
	});

	test("stale: the action button; failed: the message only", () => {
		const stale = banner({ kind: "stale", text: CAMERA_TRACKER_BANNERS.stale, actionLabel: "Solve", action: "resolve" });
		expect(stale).toContain(">Solve</button>");
		expect(stale).not.toContain("progressbar");
		const failed = banner({ kind: "failed", text: "Not enough detail in this clip to track the camera." });
		expect(liveRegion(failed)).toBe("Not enough detail in this clip to track the camera.");
		expect(failed).not.toContain("<button");
	});
});

describe("the track points layer (static markup)", () => {
	const drawing: PointsDrawing = {
		markers: [
			{ trackId: 1, x: 10, y: 20, size: 10, hue: 120, selected: false, dim: false },
			{ trackId: 2, x: 30, y: 40, size: 8, hue: 200, selected: true, dim: true },
		],
		triangle: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
		rings: [
			[{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }],
			[{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 1, y: 4 }],
		],
		marquee: { x: 1, y: 2, width: 3, height: 4 },
		lasso: null,
	};

	test("decorative and transparent to the pointer", () => {
		const markup = renderToStaticMarkup(<CameraPointsView drawing={drawing} />);
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain("pointer-events-none");
	});

	test("one '+' per marker (sized, coloured), a ring for the selected one, the triangle, the target rings, the marquee", () => {
		const markup = renderToStaticMarkup(<CameraPointsView drawing={drawing} />);
		expect(markup).toContain('d="M5 20H15M10 15V25"');
		expect(markup).toContain("hsl(120.0 85% 62%)");
		expect((markup.match(/<circle/g) ?? []).length).toBe(1);
		expect(markup).toContain('opacity="0.45"');
		expect(markup).toContain('points="0.0,0.0 10.0,0.0 0.0,10.0"');
		expect((markup.match(/fill="#e5322d"/g) ?? []).length).toBe(1);
		expect((markup.match(/fill="#ffffff"/g) ?? []).length).toBe(2);
		expect(markup).toContain('<rect x="1" y="2" width="3" height="4"');
	});
});
