import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SplitElementsCommand } from "@/commands/timeline/element/split-elements";
import { EditorCore } from "@/core";
import type { PresetAnimations } from "@/animation/presets";
import type {
	AudioElement,
	SceneTracks,
	TextElement,
	VideoElement,
} from "@/timeline";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

const IN: PresetAnimations["in"] = {
	id: "slide-left",
	duration: mediaTime({ ticks: 3 }),
};
const OUT: PresetAnimations["out"] = {
	id: "zoom",
	duration: mediaTime({ ticks: 2 }),
};

const baseFields = {
	startTime: ZERO_MEDIA_TIME,
	duration: mediaTime({ ticks: 10 }),
	trimStart: ZERO_MEDIA_TIME,
	trimEnd: ZERO_MEDIA_TIME,
	params: {},
};

function video(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		...baseFields,
		id: "video-1",
		type: "video",
		name: "Video",
		mediaId: "media-1",
		...overrides,
	};
}

function text(overrides: Partial<TextElement> = {}): TextElement {
	return {
		...baseFields,
		id: "text-1",
		type: "text",
		name: "Text",
		...overrides,
	};
}

function audio(): AudioElement {
	return {
		...baseFields,
		id: "audio-1",
		type: "audio",
		name: "Audio",
		sourceType: "upload",
		mediaId: "media-2",
	};
}

function buildTracks({
	main,
	overlayText,
	audioElement,
}: {
	main: VideoElement;
	overlayText?: TextElement;
	audioElement?: AudioElement;
}): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [main],
		},
		overlay: overlayText
			? [
					{
						id: "text-track",
						name: "Text",
						type: "text",
						hidden: false,
						elements: [overlayText],
					},
				]
			: [],
		audio: audioElement
			? [
					{
						id: "audio-track",
						name: "Audio",
						type: "audio",
						muted: false,
						elements: [audioElement],
					},
				]
			: [],
	};
}

const restores: Array<() => void> = [];

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

// The command reaches the editor through the singleton, so stand in for the
// two things it uses instead of booting every manager. Every `updateTracks`
// call is recorded: the first is the split, a later one is the undo.
function runSplit({
	tracks,
	elements,
	retainSide,
}: {
	tracks: SceneTracks;
	elements: { trackId: string; elementId: string }[];
	retainSide?: "both" | "left" | "right";
}) {
	const calls: SceneTracks[] = [];
	const editor: EditorCore = Object.create(EditorCore.prototype);
	Object.assign(editor, {
		scenes: { getActiveScene: () => ({ tracks }) },
		timeline: {
			updateTracks: (next: SceneTracks) => {
				calls.push(next);
			},
		},
	});
	const spy = spyOn(EditorCore, "getInstance").mockReturnValue(editor);
	restores.push(() => spy.mockRestore());

	const command = new SplitElementsCommand({
		elements,
		splitTime: mediaTime({ ticks: 5 }),
		retainSide,
	});
	command.execute();
	const [updated] = calls;
	if (!updated) throw new Error("split did not update the tracks");
	return { updated, calls, command };
}

describe("splitting a clip with In/Out presets", () => {
	test("the left half keeps In and the right half keeps Out", () => {
		const { updated } = runSplit({
			tracks: buildTracks({
				main: video({ presetAnimations: { in: IN, out: OUT } }),
			}),
			elements: [{ trackId: "main", elementId: "video-1" }],
		});
		const [left, right] = updated.main.elements;

		expect(updated.main.elements).toHaveLength(2);
		expect(left.name).toBe("Video (left)");
		expect(right.name).toBe("Video (right)");
		expect(left.presetAnimations).toEqual({ in: IN });
		expect(right.presetAnimations).toEqual({ out: OUT });
	});

	test("a half with nothing to keep loses the field instead of keeping a copy", () => {
		const { updated } = runSplit({
			tracks: buildTracks({ main: video({ presetAnimations: { in: IN } }) }),
			elements: [{ trackId: "main", elementId: "video-1" }],
		});
		const [left, right] = updated.main.elements;
		expect(left.presetAnimations).toEqual({ in: IN });
		expect(right.presetAnimations).toBeUndefined();
	});

	test("keeping only the left side keeps In and drops Out", () => {
		const { updated } = runSplit({
			tracks: buildTracks({
				main: video({ presetAnimations: { in: IN, out: OUT } }),
			}),
			elements: [{ trackId: "main", elementId: "video-1" }],
			retainSide: "left",
		});
		expect(updated.main.elements).toHaveLength(1);
		expect(updated.main.elements[0].presetAnimations).toEqual({ in: IN });
	});

	test("keeping only the right side keeps Out and drops In", () => {
		const { updated } = runSplit({
			tracks: buildTracks({
				main: video({ presetAnimations: { in: IN, out: OUT } }),
			}),
			elements: [{ trackId: "main", elementId: "video-1" }],
			retainSide: "right",
		});
		expect(updated.main.elements).toHaveLength(1);
		expect(updated.main.elements[0].presetAnimations).toEqual({ out: OUT });
	});

	test("works for text clips too", () => {
		const { updated } = runSplit({
			tracks: buildTracks({
				main: video(),
				overlayText: text({ presetAnimations: { in: IN, out: OUT } }),
			}),
			elements: [{ trackId: "text-track", elementId: "text-1" }],
		});
		const track = updated.overlay[0];
		if (track.type !== "text") throw new Error("expected the text track");
		const [left, right] = track.elements;
		expect(track.elements).toHaveLength(2);
		expect(left.presetAnimations).toEqual({ in: IN });
		expect(right.presetAnimations).toEqual({ out: OUT });
	});

	test("clips without presets, and audio clips, do not gain a presetAnimations key", () => {
		const { updated } = runSplit({
			tracks: buildTracks({ main: video(), audioElement: audio() }),
			elements: [
				{ trackId: "main", elementId: "video-1" },
				{ trackId: "audio-track", elementId: "audio-1" },
			],
		});
		const halves = [...updated.main.elements, ...updated.audio[0].elements];
		expect(halves).toHaveLength(4);
		for (const half of halves) {
			expect("presetAnimations" in half).toBe(false);
		}
	});

	test("undo restores the original clip with both animations", () => {
		const original = buildTracks({
			main: video({ presetAnimations: { in: IN, out: OUT } }),
		});
		const { command, calls } = runSplit({
			tracks: original,
			elements: [{ trackId: "main", elementId: "video-1" }],
		});
		command.undo();

		expect(calls).toHaveLength(2);
		expect(calls[1]).toBe(original);
		expect(original.main.elements[0].presetAnimations).toEqual({
			in: IN,
			out: OUT,
		});
	});
});

describe("the two halves of a split agree about the cut", () => {
	// A video's picture and its sound, and a sound clip, play from the same fields
	// (trimStart, duration, retime), so the right half must start exactly where
	// the left half's source ends: within one tick, at any speed.
	for (const rate of [1, 0.5, 2, 1.7]) {
		test(`source time is continuous across the cut at rate ${rate}`, () => {
			const retime = { rate };
			const main = video({ trimStart: mediaTime({ ticks: 40 }), duration: mediaTime({ ticks: 10 }), retime });
			const sound: AudioElement = { ...audio(), trimStart: mediaTime({ ticks: 40 }), duration: mediaTime({ ticks: 10 }), retime };
			const { updated } = runSplit({
				tracks: buildTracks({ main, audioElement: sound }),
				elements: [
					{ trackId: "main", elementId: main.id },
					{ trackId: "audio-track", elementId: sound.id },
				],
			});
			const halves = [
				[...updated.main.elements.filter((e) => e.type === "video")],
				[...updated.audio.flatMap((track) => track.elements)],
			];
			for (const elements of halves) {
				const [left, right] = elements;
				if (!left || !right) throw new Error("expected two halves");
				const leftEnd = left.trimStart + left.duration * rate;
				expect(Math.abs(leftEnd - right.trimStart)).toBeLessThanOrEqual(1);
				expect(Number(right.startTime)).toBe(left.startTime + left.duration);
				expect(Number(right.duration) + left.duration).toBe(10);
			}
		});
	}
});
