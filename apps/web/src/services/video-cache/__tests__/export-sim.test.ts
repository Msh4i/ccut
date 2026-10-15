import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeAudioBuffer } from "@/export/__tests__/fake-audio-buffer";
import { createTimelineAudioBuffer } from "@/media/audio";
import {
	FakeAudioContext,
	FakeOfflineAudioContext,
	ONE_SECOND,
	pcmFile,
	tracksWith,
	videoAsset,
	videoClip,
} from "@/media/__tests__/audio-fixtures";
import { runExportSim } from "../sim/export-sim";

// An export of 75+ clips back to back (the owner's montage: 36 s, 75 clips): what the cache holds
// must follow the clips on screen, not the clips already played (round 5e). Simulated timings.

describe("export of many clips", () => {
	test("one file per clip: media, streams and canvases stay flat as clips pass", async () => {
		const result = await runExportSim({ clipCount: 150, files: 150 });
		const at = (clip: number) => result.samples[clip - 1];
		expect(result.mediaAtEnd).toBeLessThanOrEqual(2);
		expect(result.peak.streams).toBeLessThanOrEqual(3);
		// Canvases of a passed clip's media are destroyed, not left to the garbage collector.
		expect(at(150).liveCanvases).toBeLessThanOrEqual(at(25).liveCanvases + 2);
		expect(result.peak.heldBytes).toBeLessThan(512 * 1024 ** 2);
	}, 60_000);

	test("one file for every clip: streams and canvases are bounded whatever the clip count", async () => {
		const result = await runExportSim({ clipCount: 150, files: 1 });
		expect(result.peak.streams).toBeLessThanOrEqual(3);
		expect(result.samples[149].liveCanvases).toBeLessThanOrEqual(result.samples[24].liveCanvases + 2);
		expect(result.peak.heldBytes).toBeLessThan(768 * 1024 ** 2);
	}, 60_000);
});

// The same montage with "Include audio" on: the export mixes the audio of every
// clip before the first frame (`createTimelineAudioBuffer`, real code here, Web
// Audio faked, the file's PCM read by mediabunny). On the owner's 75-clip
// project a decode per clip took the renderer past its memory limit (round 5e).
describe("export of many clips with audio on", () => {
	const originalOfflineAudioContext = Reflect.get(globalThis, "OfflineAudioContext");
	const originalAudioBuffer = Reflect.get(globalThis, "AudioBuffer");
	beforeEach(() => {
		Reflect.set(globalThis, "window", { AudioContext: FakeAudioContext });
		Reflect.set(globalThis, "OfflineAudioContext", FakeOfflineAudioContext);
		Reflect.set(globalThis, "AudioBuffer", FakeAudioBuffer);
	});
	afterEach(() => {
		Reflect.set(globalThis, "window", undefined);
		Reflect.set(globalThis, "OfflineAudioContext", originalOfflineAudioContext);
		Reflect.set(globalThis, "AudioBuffer", originalAudioBuffer);
	});

	const SOURCE_SECONDS = 8;
	// 8 s stands in for the long source: what matters is how many copies of it exist.
	const source = pcmFile({
		frames: SOURCE_SECONDS * 44100,
		channels: 2,
		value: ({ channel, frame }) => ((frame * 5 + channel * 101) % 2000) - 1000,
		name: "long-take.mp4",
	});

	async function exportAudio({ clipCount }: { clipCount: number }) {
		FakeOfflineAudioContext.created = 0;
		FakeOfflineAudioContext.events = [];
		const clipTicks = Math.round(0.48 * ONE_SECOND);
		const clips = Array.from({ length: clipCount }, (_, clip) =>
			videoClip({
				id: `clip-${clip}`,
				name: `Cut ${clip + 1}`,
				mediaId: "long-take",
				startTicks: clip * clipTicks,
				durationTicks: clipTicks,
				// Each clip shows a different part of the source, as a montage of cuts does.
				trimStartTicks: Math.round(((clip * 0.7) % (SOURCE_SECONDS - 1)) * ONE_SECOND),
			}),
		);
		const { buffer, skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({ video: clips }),
			mediaAssets: [videoAsset({ id: "long-take", file: source })],
			duration: clipCount * clipTicks,
		});
		let rendering = 0;
		let renderingAtOnce = 0;
		for (const event of FakeOfflineAudioContext.events) {
			rendering += event === "render-start" ? 1 : -1;
			renderingAtOnce = Math.max(renderingAtOnce, rendering);
		}
		return {
			mixed: buffer !== null,
			skipped,
			// Every decoded buffer is held by the collected clips until the mix is
			// done (the mix starts once all are collected), so the decodes of one
			// export are all alive at once: this count is the peak of live decoded buffers.
			liveDecodedBuffers: FakeOfflineAudioContext.created,
			renderingAtOnce,
		};
	}

	test("N clips of one long source: one decode, and live decoded buffers do not grow with N", async () => {
		const few = await exportAudio({ clipCount: 3 });
		const many = await exportAudio({ clipCount: 30 });

		for (const run of [few, many]) {
			expect(run.mixed).toBe(true);
			expect(run.skipped).toEqual([]);
		}
		expect(many.liveDecodedBuffers).toBe(1);
		expect(many.liveDecodedBuffers).toBe(few.liveDecodedBuffers);
		expect(many.renderingAtOnce).toBe(1);
	}, 60_000);
});
