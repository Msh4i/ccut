import { describe, expect, test } from "bun:test";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { TICKS_PER_SECOND } from "@/wasm";
import { prerollRequestFor, videoClipsOf } from "../preroll-scene";

const clip = ({ id, start, seconds, trim }: { id: string | undefined; start: number; seconds: number; trim: number }) =>
	new VideoNode({
		mediaId: `media-${id}`,
		elementId: id,
		url: "",
		file: new File([], `${id}.mp4`),
		duration: seconds * TICKS_PER_SECOND,
		timeOffset: start * TICKS_PER_SECOND,
		trimStart: trim * TICKS_PER_SECOND,
		trimEnd: 0,
		transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
	});

describe("pre-roll from the scene tree", () => {
	test("the clips are read from the tree in seconds; the next ones are asked ahead, the playing one is kept", () => {
		const root = new RootNode({ duration: 10 * TICKS_PER_SECOND });
		root.add(clip({ id: "a", start: 0, seconds: 1, trim: 8.8 }));
		root.add(clip({ id: "b", start: 1, seconds: 1, trim: 11.3 }));
		root.add(clip({ id: "c", start: 2, seconds: 1, trim: 14.3 }));
		root.add(clip({ id: undefined, start: 3, seconds: 1, trim: 1 })); // no element id: no stream owner, not pre-rolled
		const clips = videoClipsOf({ root });
		expect(clips.map((c) => [c.key, c.start, c.sourceStart])).toEqual([["a", 0, 8.8], ["b", 1, 11.3], ["c", 2, 14.3]]);
		const playing = prerollRequestFor({ clips, timeSeconds: 0.5, playing: true });
		expect(playing.clips.map((c) => [c.key, c.time])).toEqual([["b", 11.3], ["c", 14.3]]);
		expect(playing.keep).toEqual(["a"]);
		// at rest only the next clip
		expect(prerollRequestFor({ clips, timeSeconds: 0.5, playing: false }).clips.map((c) => c.key)).toEqual(["b"]);
	});
});
