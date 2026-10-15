import { type MemorySource, VideoCache } from "../service";
import { type SimCanvas, createDecoderStats, createModelSource } from "./decoder-model";
import { VirtualClock } from "./virtual-clock";

/**
 * An export of `clipCount` clips back to back on a virtual clock: the render
 * loop of `SceneExporter` asks the frame of the one clip under the playhead,
 * with the clip's element id as stream key, full size, one frame after the
 * other, and never goes back. After every clip the sim samples what the cache
 * and the model of the decoders hold; a clip that has passed must not keep any.
 * Timings are assumptions, nothing here is measured in the app.
 */
export type ExportSimOptions = {
	clipCount: number;
	/** Seconds each clip is on the timeline. */
	clipSeconds?: number;
	projectFps?: number;
	/** Clips of the same file (1) or one file per clip (clipCount). */
	files?: number;
	/** Milliseconds one exported frame takes (render + encode), on the virtual clock. */
	frameMs?: number;
	/** The cap the export asks of the kept-frame cache. */
	holdCapBytes?: number;
	/** The export tells the cache it only moves forward (what `RendererManager.exportProject` does). */
	forwardOnly?: boolean;
};

export type ExportSimSample = {
	clip: number;
	streams: number;
	liveRuns: number;
	liveCanvases: number;
	heldBytes: number;
	usedBytes: number;
};

export type ExportSimResult = {
	samples: ExportSimSample[];
	/** Media entries the cache still holds at the end of the export. */
	mediaAtEnd: number;
	peak: { streams: number; liveRuns: number; liveCanvases: number; heldBytes: number; usedBytes: number };
	frames: number;
	finalHeldBytes: number;
};

const GiB = 1024 ** 3;

const ROOMY: MemorySource = {
	readMemory: async () => ({
		totalBytes: 15.3 * GiB,
		availableBytes: 6 * GiB,
		swapTotalBytes: 8 * GiB,
		swapFreeBytes: 8 * GiB,
		appBytes: 1.2 * GiB,
	}),
	mode: () => "high",
	deviceMemoryGiB: () => null,
};

export async function runExportSim({
	clipCount,
	clipSeconds = 0.48,
	projectFps = 30,
	files = 1,
	frameMs = 60,
	holdCapBytes = 512 * 1024 ** 2,
	forwardOnly = true,
}: ExportSimOptions): Promise<ExportSimResult> {
	const clock = new VirtualClock();
	const stats = createDecoderStats();
	const videoFps = 30;
	const cache = new VideoCache<SimCanvas>({
		openSource: async () =>
			createModelSource({
				clock,
				params: {
					fps: videoFps,
					frameCount: 60 * videoFps,
					keyframeInterval: videoFps,
					decodeMs: 6,
					startupMs: 20,
					maxQueued: 8,
				},
				stats,
				lanes: null,
			}),
		now: () => clock.now,
		memory: ROOMY,
	});
	for (let tick = 0; tick < 26; tick++) await cache.tickMemory();
	const release = cache.holdBudgetAtMost({ capBytes: holdCapBytes, forwardOnly });

	const samples: ExportSimSample[] = [];
	const peak = { streams: 0, liveRuns: 0, liveCanvases: 0, heldBytes: 0, usedBytes: 0 };
	let frames = 0;
	const framesPerClip = Math.round(clipSeconds * projectFps);
	let done = false;
	const loop = (async () => {
		for (let clip = 0; clip < clipCount; clip++) {
			const mediaId = `m${(clip % files) + 1}`;
			const file = new File([], mediaId);
			// Each clip shows a different part of the source, as a montage of cuts does.
			const sourceStart = 2 + ((clip * 7.3) % 40);
			for (let frame = 0; frame < framesPerClip; frame++) {
				const lease = cache.beginRender();
				await cache.getFrameAt({
					mediaId,
					file,
					time: sourceStart + frame / projectFps,
					streamKey: `clip-${clip}`,
					lease,
				});
				await clock.sleep(frameMs);
				cache.endRender({ lease });
				frames += 1;
				const memory = cache.getMemoryStats();
				peak.streams = Math.max(peak.streams, memory.streams);
				peak.usedBytes = Math.max(peak.usedBytes, memory.usedBytes);
				peak.liveRuns = Math.max(peak.liveRuns, stats.liveRuns);
				peak.liveCanvases = Math.max(peak.liveCanvases, stats.liveCanvases);
				peak.heldBytes = Math.max(peak.heldBytes, stats.heldBytes);
			}
			const memory = cache.getMemoryStats();
			samples.push({
				clip: clip + 1,
				streams: memory.streams,
				liveRuns: stats.liveRuns,
				liveCanvases: stats.liveCanvases,
				heldBytes: stats.heldBytes,
				usedBytes: memory.usedBytes,
			});
		}
		done = true;
	})();
	await clock.runUntil({
		time: 10 * 60 * 1000,
		maxEvents: 5_000_000,
		observe: () => {},
	}).catch(() => {});
	await loop;
	release();
	const finalHeldBytes = stats.heldBytes;
	const mediaAtEnd = cache.getStats().media;
	cache.clearAll();
	if (!done) throw new Error("export sim did not finish");
	return { samples, mediaAtEnd, peak, frames, finalHeldBytes };
}
