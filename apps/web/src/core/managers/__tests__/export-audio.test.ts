import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ExportOptions } from "@/export";
import { RendererManager } from "@/core/managers/renderer-manager";
import {
	FakeAudioContext,
	ONE_SECOND,
	audioAsset,
	toneBuffer,
	tracksWith,
	uploadAudio,
} from "@/media/__tests__/audio-fixtures";
import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";

// What exportProject does with the audio of the project: clips whose audio
// cannot be read stop the export with a message that names them, instead of
// being silent in the file. It ends in an error because bun has no canvas to
// encode with: the point is which error, and how far it got.

type Progress = number[];

function managerFor({ tracks, mediaAssets }: { tracks: SceneTracks; mediaAssets: MediaAsset[] }) {
	// Object.create returns any: the fake only has what exportProject reads.
	const editor = Object.assign(Object.create(null), {
		scenes: { getActiveScene: () => ({ tracks }) },
		media: { getAssets: () => mediaAssets },
		project: {
			getActive: () => ({
				metadata: { name: "Audio test" },
				settings: {
					fps: { numerator: 30, denominator: 1 },
					canvasSize: { width: 64, height: 64 },
					background: { type: "color", color: "#000000" },
				},
			}),
		},
		timeline: { getTotalDuration: () => 2 * ONE_SECOND },
	});
	return new RendererManager(editor);
}

let decodes = 0;
beforeEach(() => {
	decodes = 0;
	FakeAudioContext.decode = async (data) => {
		decodes++;
		if (data.byteLength === 7) throw new Error("Unable to decode audio data");
		return toneBuffer({ seconds: 1 });
	};
	Reflect.set(globalThis, "window", { AudioContext: FakeAudioContext });
});
afterEach(() => {
	Reflect.set(globalThis, "window", undefined);
});

const mp4: ExportOptions = { format: "mp4", quality: "high", includeAudio: true };

describe("RendererManager.exportProject, audio that cannot be read", () => {
	test("a clip that cannot be decoded ends the export with AUDIO_UNREADABLE naming it, after the mix and before any encoding", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
		const progress: Progress = [];
		try {
			const manager = managerFor({
				tracks: tracksWith({
					audio: [
						uploadAudio({ id: "good", name: "Good", mediaId: "good-media" }),
						uploadAudio({ id: "bad", name: "Broken song", mediaId: "bad-media" }),
					],
				}),
				mediaAssets: [audioAsset({ id: "good-media" }), audioAsset({ id: "bad-media", bytes: 7 })],
			});

			const result = await manager.exportProject({
				options: mp4,
				onProgress: ({ progress: value }) => progress.push(value),
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('Audio of "Broken song" could not be read');
			expect(result.error).toContain("Details: AUDIO_UNREADABLE, Broken song: Unable to decode audio data");
			expect(result.buffer).toBeUndefined();
			// The mix stage (0.05) was reached; no encoding progress followed.
			expect(progress).toEqual([0.05]);
		} finally {
			consoleError.mockRestore();
			consoleWarn.mockRestore();
		}
	});

	test("a project whose only audio is unreadable is stopped too, not exported without sound", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const manager = managerFor({
				tracks: tracksWith({ audio: [uploadAudio({ id: "bad", name: "Only song", mediaId: "bad-media" })] }),
				mediaAssets: [audioAsset({ id: "bad-media", bytes: 7 })],
			});

			const result = await manager.exportProject({ options: { ...mp4, format: "webm" } });

			expect(result.success).toBe(false);
			expect(result.error).toContain('Audio of "Only song" could not be read');
		} finally {
			consoleError.mockRestore();
			consoleWarn.mockRestore();
		}
	});

	test("with Include audio off the clip is not even read, and the export is not stopped for it", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		try {
			const manager = managerFor({
				tracks: tracksWith({ audio: [uploadAudio({ id: "bad", name: "Broken song", mediaId: "bad-media" })] }),
				mediaAssets: [audioAsset({ id: "bad-media", bytes: 7 })],
			});

			const result = await manager.exportProject({ options: { ...mp4, includeAudio: false } });

			expect(decodes).toBe(0);
			expect(result.error ?? "").not.toContain("could not be read");
		} finally {
			consoleError.mockRestore();
		}
	});

	test("readable audio goes on past the audio checks (it then ends where bun has no canvas, but not on audio)", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		try {
			const manager = managerFor({
				tracks: tracksWith({ audio: [uploadAudio({ id: "good", name: "Good", mediaId: "good-media" })] }),
				mediaAssets: [audioAsset({ id: "good-media" })],
			});

			const result = await manager.exportProject({ options: mp4 });

			expect(decodes).toBe(1);
			expect(result.error ?? "").not.toMatch(/AUDIO_|AAC_|could not be read|AAC audio encoder/);
		} finally {
			consoleError.mockRestore();
		}
	}, 30_000);
});

describe("RendererManager.exportProject, asking about audio that cannot be read", () => {
	const brokenProject = () =>
		managerFor({
			tracks: tracksWith({
				audio: [
					uploadAudio({ id: "good", name: "Good", mediaId: "good-media" }),
					uploadAudio({ id: "bad", name: "Broken song", mediaId: "bad-media" }),
				],
			}),
			mediaAssets: [audioAsset({ id: "good-media" }), audioAsset({ id: "bad-media", bytes: 7 })],
		});

	test("asked after the mix with the clip's name; 'Cancel' is a cancel, nothing encoded", async () => {
		const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
		const questions: unknown[] = [];
		const phases: string[] = [];
		try {
			const result = await brokenProject().exportProject({
				options: mp4,
				onPhase: (update) => phases.push(update.phase),
				confirmUnreadableAudio: async (question) => {
					questions.push(question);
					return false;
				},
			});

			expect(result).toEqual({ success: false, cancelled: true });
			expect(questions).toEqual([{ skipped: [{ name: "Broken song", reason: "Unable to decode audio data" }], allUnreadable: false }]);
			expect(phases).toEqual(["preparing"]);
		} finally {
			consoleWarn.mockRestore();
		}
	});

	test("'Export anyway' goes on with the readable audio (then ends where bun has no canvas, not on audio)", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await brokenProject().exportProject({ options: mp4, confirmUnreadableAudio: async () => true });

			expect(result.success).toBe(false);
			expect(result.error ?? "").not.toMatch(/AUDIO_|could not be read/);
		} finally {
			consoleError.mockRestore();
			consoleWarn.mockRestore();
		}
	}, 30_000);

	test("only unreadable audio: asked with allUnreadable; readable audio is never asked about", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
		const questions: { allUnreadable: boolean }[] = [];
		try {
			const onlyBroken = managerFor({
				tracks: tracksWith({ audio: [uploadAudio({ id: "bad", name: "Only song", mediaId: "bad-media" })] }),
				mediaAssets: [audioAsset({ id: "bad-media", bytes: 7 })],
			});
			await onlyBroken.exportProject({
				options: { ...mp4, format: "webm" },
				confirmUnreadableAudio: async (question) => {
					questions.push(question);
					return false;
				},
			});
			expect(questions.map((question) => question.allUnreadable)).toEqual([true]);

			const fine = managerFor({
				tracks: tracksWith({ audio: [uploadAudio({ id: "good", name: "Good", mediaId: "good-media" })] }),
				mediaAssets: [audioAsset({ id: "good-media" })],
			});
			await fine.exportProject({
				options: mp4,
				confirmUnreadableAudio: async (question) => {
					questions.push(question);
					return false;
				},
			});
			expect(questions).toHaveLength(1);
		} finally {
			consoleError.mockRestore();
			consoleWarn.mockRestore();
		}
	}, 30_000);
});
