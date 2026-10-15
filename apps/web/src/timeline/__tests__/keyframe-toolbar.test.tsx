import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { KeyframeToolbarButtons } from "@/timeline/components/keyframe-toolbar-group";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { getKeyframeToolbarState } from "@/timeline/keyframe-toolbar-state";
import {
	planPlayheadKeyframes,
	type KeyframeTarget,
} from "@/timeline/playhead-keyframes";
import type { ScalarAnimationKey } from "@/animation/types";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const SECOND = TICKS_PER_SECOND;

function target({
	type,
	id,
	startSeconds = 0,
	keyAtSeconds,
}: {
	type: "video" | "image" | "audio";
	id: string;
	startSeconds?: number;
	keyAtSeconds?: number;
}): KeyframeTarget {
	const built = buildElementFromMedia({
		mediaId: "m",
		mediaType: type,
		name: id,
		duration: mediaTime({ ticks: 10 * SECOND }),
		startTime: mediaTime({ ticks: startSeconds * SECOND }),
	});
	const path = type === "audio" ? "volume" : "opacity";
	const key: ScalarAnimationKey | null =
		keyAtSeconds === undefined
			? null
			: {
					id: `${id}-key`,
					time: mediaTime({ ticks: keyAtSeconds * SECOND }),
					value: type === "audio" ? 0 : 1,
					segmentToNext: "linear",
					tangentMode: "flat",
				};
	return {
		trackId: `${id}-track`,
		element: { id, ...built, animations: key ? { [path]: { keys: [key] } } : undefined },
	};
}

const at = (seconds: number) => seconds * SECOND;

function markup({ targets, playhead }: { targets: KeyframeTarget[]; playhead: number }) {
	return renderToStaticMarkup(
		<TooltipProvider>
			<KeyframeToolbarButtons
				state={getKeyframeToolbarState({ targets, playhead })}
				shortcuts={{ previous: "alt+left", toggle: "alt+k", next: "alt+right" }}
				onPrevious={() => {}}
				onToggle={() => {}}
				onNext={() => {}}
			/>
		</TooltipProvider>,
	);
}

function buttons(html: string) {
	return [...html.matchAll(/<button[^>]*>/g)].map(([tag]) => ({
		label: /aria-label="([^"]*)"/.exec(tag)?.[1],
		disabled: /disabled=""/.test(tag),
		pressed: /aria-pressed="true"/.test(tag),
	}));
}

describe("keyframe buttons in the toolbar", () => {
	test("no clip selected: all three are disabled", () => {
		const state = getKeyframeToolbarState({ targets: [], playhead: 0 });
		expect(state.toggle).toEqual({ enabled: false, reason: "Select a clip first", isKeyed: false });
		expect(buttons(markup({ targets: [], playhead: 0 })).every((b) => b.disabled)).toBe(true);
	});

	test("the playhead outside the selected clip disables the diamond and says why", () => {
		const targets = [target({ type: "image", id: "i", startSeconds: 20 })];
		const state = getKeyframeToolbarState({ targets, playhead: at(1) });
		expect(state.toggle.enabled).toBe(false);
		expect(state.toggle.reason).toBe("Move the playhead onto the selected clip");
	});

	test("on a clip with no key the diamond is enabled and empty; with a key right there it is filled", () => {
		const plain = markup({ targets: [target({ type: "image", id: "i" })], playhead: at(2) });
		const [prev, diamond] = buttons(plain);
		expect(diamond).toEqual({ label: "Add or remove keyframe at the playhead", disabled: false, pressed: false });
		expect(prev.disabled).toBe(true);
		const keyed = markup({ targets: [target({ type: "image", id: "i", keyAtSeconds: 2 })], playhead: at(2) });
		expect(buttons(keyed)[1].pressed).toBe(true);
	});

	test("previous / next are enabled only with a keyframe on that side", () => {
		const targets = [target({ type: "video", id: "v", keyAtSeconds: 4 })];
		expect(buttons(markup({ targets, playhead: at(2) })).map((b) => b.disabled)).toEqual([true, false, false]);
		expect(buttons(markup({ targets, playhead: at(6) })).map((b) => b.disabled)).toEqual([false, false, true]);
	});

	test("every clip type can be keyed at the playhead; audio keys its volume", () => {
		for (const type of ["video", "image", "audio"] as const) {
			const plan = planPlayheadKeyframes({ targets: [target({ type, id: type })], playhead: at(1) });
			if (plan?.kind !== "add") throw new Error(`${type}: expected add`);
			expect(plan.keyframes.map((k) => k.propertyPath)).toEqual(type === "audio" ? ["volume"] : [
				"transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY", "transform.rotate", "opacity",
			]);
		}
	});
});

describe("several selected clips, one plan", () => {
	test("adds to every clip the playhead is inside, in one plan, and skips the others", () => {
		const targets = [
			target({ type: "image", id: "a" }),
			target({ type: "audio", id: "b" }),
			target({ type: "video", id: "far", startSeconds: 30 }),
		];
		const plan = planPlayheadKeyframes({ targets, playhead: at(2) });
		if (plan?.kind !== "add") throw new Error("expected add");
		expect([...new Set(plan.keyframes.map((k) => k.elementId))]).toEqual(["a", "b"]);
		expect(plan.keyframes.every((k) => k.time === at(2))).toBe(true);
	});

	test("with some clips keyed and some not it adds to the unkeyed ones only", () => {
		const plan = planPlayheadKeyframes({
			targets: [target({ type: "image", id: "keyed", keyAtSeconds: 2 }), target({ type: "image", id: "free" })],
			playhead: at(2),
		});
		if (plan?.kind !== "add") throw new Error("expected add");
		expect([...new Set(plan.keyframes.map((k) => k.elementId))]).toEqual(["free"]);
	});

	test("with every clip keyed it removes the keys of all of them", () => {
		const targets = [target({ type: "image", id: "a", keyAtSeconds: 2 }), target({ type: "audio", id: "b", keyAtSeconds: 2 })];
		const plan = planPlayheadKeyframes({ targets, playhead: at(2) });
		if (plan?.kind !== "remove") throw new Error("expected remove");
		expect(plan.keyframes.map((k) => [k.elementId, k.propertyPath, k.keyframeId])).toEqual([
			["a", "opacity", "a-key"],
			["b", "volume", "b-key"],
		]);
		expect(getKeyframeToolbarState({ targets, playhead: at(2) }).toggle.isKeyed).toBe(true);
	});

	test("nothing to act on gives no plan", () => {
		expect(planPlayheadKeyframes({ targets: [], playhead: 0 })).toBeNull();
	});
});
