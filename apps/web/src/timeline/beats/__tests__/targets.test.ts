import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type {
	AudioTrack,
	ImageElement,
	LibraryAudioElement,
	TextElement,
	TimelineElement,
	UploadAudioElement,
	VideoElement,
} from "@/timeline";
import { summarizeBeatRun } from "@/timeline/beats/run-summary";
import { getBeatSelection, isOneSource } from "@/timeline/beats/targets";
import { mediaTime } from "@/wasm";

const base = {
	name: "Clip",
	startTime: mediaTime({ ticks: 0 }),
	duration: mediaTime({ ticks: 120000 }),
	trimStart: mediaTime({ ticks: 0 }),
	trimEnd: mediaTime({ ticks: 0 }),
	params: {},
};

function uploadAudio(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		...base,
		id: "a1",
		type: "audio",
		sourceType: "upload",
		mediaId: "m-audio",
		...overrides,
	};
}

function libraryAudio(): LibraryAudioElement {
	return {
		...base,
		id: "l1",
		type: "audio",
		sourceType: "library",
		sourceUrl: "https://example.test/a.mp3",
	};
}

function video(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		...base,
		id: "v1",
		type: "video",
		mediaId: "m-video",
		...overrides,
	};
}

function asset({
	id,
	type = "video",
	hasAudio,
}: {
	id: string;
	type?: MediaAsset["type"];
	hasAudio?: boolean;
}): MediaAsset {
	return { id, name: id, type, hasAudio, file: new File([], id) };
}

const track: AudioTrack = {
	id: "t1",
	name: "T",
	type: "audio",
	elements: [],
	muted: false,
};

function select(...elements: TimelineElement[]) {
	return elements.map((element) => ({ track, element }));
}

function getBeatTargets(args: Parameters<typeof getBeatSelection>[0]) {
	return getBeatSelection(args).targets;
}

describe("getBeatTargets", () => {
	test("keeps audio clips and videos with their source audio on", () => {
		const targets = getBeatTargets({
			selected: select(uploadAudio(), video()),
			mediaAssets: [asset({ id: "m-audio", type: "audio" }), asset({ id: "m-video" })],
		});
		expect(targets.map((target) => target.element.id)).toEqual(["a1", "v1"]);
		expect(targets[0].trackId).toBe("t1");
	});

	test("drops a video whose audio was separated: the extracted clip owns the beats", () => {
		const targets = getBeatTargets({
			selected: select(video({ isSourceAudioEnabled: false })),
			mediaAssets: [asset({ id: "m-video" })],
		});
		expect(targets).toEqual([]);
	});

	test("drops a video that has no audio track", () => {
		const targets = getBeatTargets({
			selected: select(video()),
			mediaAssets: [asset({ id: "m-video", hasAudio: false })],
		});
		expect(targets).toEqual([]);
	});

	test("drops clips that cannot carry audio", () => {
		const image: ImageElement = {
			...base,
			id: "i1",
			type: "image",
			mediaId: "m-img",
		};
		const text: TextElement = { ...base, id: "x1", type: "text" };
		expect(
			getBeatTargets({ selected: select(image, text), mediaAssets: [] }),
		).toEqual([]);
	});

	test("resolves the media asset of an uploaded clip and none for a library sound", () => {
		const audioAsset = asset({ id: "m-audio", type: "audio" });
		const targets = getBeatTargets({
			selected: select(uploadAudio(), libraryAudio()),
			mediaAssets: [audioAsset],
		});
		expect(targets[0].mediaAsset).toBe(audioAsset);
		expect(targets[1].mediaAsset).toBeNull();
	});

	test("keeps an uploaded clip whose asset is gone so the run can report it", () => {
		const targets = getBeatTargets({
			selected: select(uploadAudio()),
			mediaAssets: [],
		});
		expect(targets.length).toBe(1);
		expect(targets[0].mediaAsset).toBeNull();
	});

	test("gives clips of the same source the same source key", () => {
		const targets = getBeatTargets({
			selected: select(
				uploadAudio({ id: "a1" }),
				uploadAudio({ id: "a2" }),
				uploadAudio({ id: "a3", mediaId: "other" }),
				libraryAudio(),
			),
			mediaAssets: [],
		});
		expect(targets[0].sourceKey).toBe(targets[1].sourceKey);
		expect(targets[0].sourceKey).not.toBe(targets[2].sourceKey);
		expect(targets[0].sourceKey).toBe("media:m-audio");
		expect(targets[3].sourceKey).toBe("library:https://example.test/a.mp3");
	});

	test("an audio clip and a video of different media never share a key", () => {
		const targets = getBeatTargets({
			selected: select(uploadAudio(), video()),
			mediaAssets: [asset({ id: "m-video" })],
		});
		expect(targets[0].sourceKey).not.toBe(targets[1].sourceKey);
	});
});

describe("isOneSource (a stem file is one media's audio)", () => {
	const targetsOf = (...elements: TimelineElement[]) =>
		getBeatTargets({
			selected: select(...elements),
			mediaAssets: [
				asset({ id: "m-audio", type: "audio" }),
				asset({ id: "m-video" }),
				asset({ id: "m-other", type: "audio" }),
			],
		});

	test("two clips of one media share one stem, clips of two media do not", () => {
		expect(isOneSource({ targets: targetsOf(uploadAudio(), uploadAudio({ id: "a2" })) })).toBe(true);
		expect(
			isOneSource({ targets: targetsOf(uploadAudio(), uploadAudio({ id: "a2", mediaId: "m-other" })) }),
		).toBe(false);
		expect(isOneSource({ targets: [] })).toBe(false);
	});
});

describe("getBeatSelection state", () => {
	const beat = [mediaTime({ ticks: 1 })];
	const assets = [asset({ id: "m-audio", type: "audio" }), asset({ id: "m-video" })];
	const stateOf = (...elements: TimelineElement[]) =>
		getBeatSelection({ selected: select(...elements), mediaAssets: assets }).state;

	test("nothing selected: no clip", () => {
		expect(getBeatSelection({ selected: [], mediaAssets: assets }).state).toBe(
			"no-clip",
		);
	});

	test("only clips that cannot carry audio: no clip", () => {
		const image: ImageElement = { ...base, id: "i1", type: "image", mediaId: "m" };
		expect(stateOf(image)).toBe("no-clip");
	});

	test("is ready while at least one eligible clip has no beats", () => {
		expect(stateOf(uploadAudio())).toBe("ready");
		expect(stateOf(uploadAudio({ beats: beat }), uploadAudio({ id: "a2" }))).toBe(
			"ready",
		);
	});

	test("is active once every eligible clip has beats", () => {
		expect(
			stateOf(uploadAudio({ beats: beat }), uploadAudio({ id: "a2", beats: beat })),
		).toBe("active");
	});

	test("a video with separated audio says to pick the extracted clip", () => {
		expect(stateOf(video({ isSourceAudioEnabled: false }))).toBe("separated-audio");
	});

	test("a video without an audio track says it has no audio", () => {
		const noAudio = getBeatSelection({
			selected: select(video()),
			mediaAssets: [asset({ id: "m-video", hasAudio: false })],
		});
		expect(noAudio.state).toBe("no-audio");
	});

	test("separated audio is the more useful reason when both apply", () => {
		const both = getBeatSelection({
			selected: select(video({ id: "v1" }), video({ id: "v2", isSourceAudioEnabled: false })),
			mediaAssets: [asset({ id: "m-video", hasAudio: false })],
		});
		expect(both.state).toBe("separated-audio");
	});

	test("an eligible clip next to an ineligible one still works", () => {
		expect(
			stateOf(uploadAudio(), video({ isSourceAudioEnabled: false })),
		).toBe("ready");
	});
});

describe("summarizeBeatRun", () => {
	test("one source: beat count and rounded tempo", () => {
		expect(
			summarizeBeatRun({
				sources: [{ ok: true, beatCount: 478, bpm: 127.6, clipCount: 1 }],
			}),
		).toEqual({ type: "success", message: "Found 478 beats (≈128 BPM)" });
	});

	test("hits have no tempo, so the message does not invent one", () => {
		expect(
			summarizeBeatRun({
				sources: [{ ok: true, beatCount: 162, clipCount: 1 }],
			}),
		).toEqual({ type: "success", message: "Found 162 hits" });
	});

	test("one source shared by several clips still reports its beats", () => {
		expect(
			summarizeBeatRun({
				sources: [{ ok: true, beatCount: 40, bpm: 120, clipCount: 3 }],
			}),
		).toEqual({ type: "success", message: "Found 40 beats (≈120 BPM)" });
	});

	test("several sources: counts clips", () => {
		expect(
			summarizeBeatRun({
				sources: [
					{ ok: true, beatCount: 40, bpm: 120, clipCount: 2 },
					{ ok: true, beatCount: 90, bpm: 100, clipCount: 1 },
				],
			}),
		).toEqual({ type: "success", message: "Found beats in 3 clips" });
	});

	test("partial success is a warning that says how many clips got beats", () => {
		expect(
			summarizeBeatRun({
				sources: [
					{ ok: true, beatCount: 40, bpm: 120, clipCount: 2 },
					{ ok: false, reason: "no-beat", clipCount: 1 },
				],
			}),
		).toEqual({ type: "warning", message: "Found beats in 2 of 3 clips" });
	});

	test.each([
		["no-beat", "No clear beat found"],
		["silent", "No audio signal"],
		["too-short", "Audio is too short to find a beat"],
		["unreadable", "Couldn't read audio"],
		["too-long", "Audio longer than 30 min"],
		["failed", "Beat detection failed"],
		["too-large", "Audio file too large"],
	] as const)("a failed source says why: %s", (reason, message) => {
		expect(
			summarizeBeatRun({ sources: [{ ok: false, reason, clipCount: 1 }] }),
		).toEqual({ type: "error", message });
	});

	test("when every source fails, the first failure is reported", () => {
		expect(
			summarizeBeatRun({
				sources: [
					{ ok: false, reason: "silent", clipCount: 1 },
					{ ok: false, reason: "no-beat", clipCount: 1 },
				],
			}),
		).toEqual({ type: "error", message: "No audio signal" });
	});
});
