import { describe, expect, test } from "bun:test";
import type { VideoElement } from "@/timeline";
import { buildSeparatedAudioElement } from "@/timeline/audio-separation";
import { mediaTime } from "@/wasm";

function video(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "v1",
		type: "video",
		mediaId: "media-1",
		name: "Clip",
		startTime: mediaTime({ ticks: 240000 }),
		duration: mediaTime({ ticks: 600000 }),
		trimStart: mediaTime({ ticks: 120000 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { volume: -3, muted: false },
		...overrides,
	};
}

describe("buildSeparatedAudioElement", () => {
	test("carries the detected beats over to the extracted audio clip", () => {
		const beats = [mediaTime({ ticks: 120000 }), mediaTime({ ticks: 180000 })];
		const audio = buildSeparatedAudioElement({
			sourceElement: video({ beats }),
		});
		expect(audio.beats).toEqual(beats);
	});

	test("has no beats when the video was never analysed", () => {
		const audio = buildSeparatedAudioElement({ sourceElement: video() });
		expect(audio.beats).toBeUndefined();
	});

	test("keeps the same source window so the source-time beats stay aligned", () => {
		const audio = buildSeparatedAudioElement({
			sourceElement: video({ beats: [mediaTime({ ticks: 120000 })] }),
		});
		expect(audio.trimStart).toBe(mediaTime({ ticks: 120000 }));
		expect(audio.startTime).toBe(mediaTime({ ticks: 240000 }));
		expect(audio.duration).toBe(mediaTime({ ticks: 600000 }));
	});
});
