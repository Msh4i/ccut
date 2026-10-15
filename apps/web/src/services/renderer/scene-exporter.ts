import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { aacMaxPacketCount } from "@/export/audio-slices";
import { createBufferSink, type ExportSink, type SinkResult } from "@/export/sink";
import { CanvasRenderer } from "./canvas-renderer";
import { createAudioFeeder, prepareAudioTrack } from "./audio-track";
import { cancelOutputQuietly } from "./output-cancel";
import type { ExportMemoryGuard } from "@/export/renderer-memory-guard";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	/** Where the file goes; by default in memory (today's behaviour). */
	sink?: ExportSink;
	/** Cancels the export, like `cancel()`. */
	signal?: AbortSignal;
	/** Asked before every frame; throws to stop the export (the renderer's memory limit). */
	memoryGuard?: ExportMemoryGuard;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	/** After each encoded frame. */
	frames: [framesDone: number, frameCount: number];
	/** All frames and audio are in; finalize, check and commit follow. */
	finalizing: [];
	complete: [result: SinkResult];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private sink: ExportSink;
	private signal?: AbortSignal;
	private memoryGuard?: ExportMemoryGuard;

	private cancelRequested = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		sink,
		signal,
		memoryGuard,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
			// A source that cannot be loaded stops the export instead of being skipped.
			strictSources: true,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.sink = sink ?? createBufferSink();
		this.signal = signal;
		this.memoryGuard = memoryGuard;
	}

	cancel(): void {
		this.cancelRequested = true;
	}

	private get isCancelled(): boolean {
		return this.cancelRequested || !!this.signal?.aborted;
	}

	/**
	 * Renders and encodes the scene into the sink. Resolves with what the sink
	 * committed, or null when cancelled. On cancel or any failure the Output is
	 * cancelled and the sink aborted (a desktop part file is deleted), and the
	 * error reaches the caller unchanged. The sink is committed only after
	 * `finalize()` succeeded.
	 */
	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<SinkResult | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		let audioTrack: Awaited<ReturnType<typeof prepareAudioTrack>> | null = null;
		try {
			// Before the Output exists: if MP4 audio cannot start (AAC_UNAVAILABLE) the
			// export stops here, with nothing opened but the sink.
			audioTrack =
				this.shouldIncludeAudio && this.audioBuffer
					? await prepareAudioTrack({
							format: this.format,
							quality: this.quality,
							audioBuffer: this.audioBuffer,
						})
					: null;
		} catch (error) {
			await this.sink.abort();
			throw error;
		}

		const outputFormat =
			this.format === "webm"
				? new WebMOutputFormat()
				: new Mp4OutputFormat({ fastStart: this.sink.fastStart });

		const output = new Output({
			format: outputFormat,
			target: this.sink.target,
		});

		const videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
		});

		// "reserve" sizes the moov from these counts before the first packet:
		// exactly one packet per frame, and the AAC bound (export-v2 R3).
		output.addVideoTrack(videoSource, {
			frameRate: fpsFloat,
			maximumPacketCount: frameCount,
		});

		let audioSource: AudioBufferSource | null = null;
		if (audioTrack) {
			audioSource = new AudioBufferSource({
				codec: audioTrack.codec,
				bitrate: audioTrack.bitrate,
			});
			output.addAudioTrack(
				audioSource,
				audioTrack.codec === "aac"
					? {
							maximumPacketCount: aacMaxPacketCount({
								samples: audioTrack.buffer.length - audioTrack.startSample,
							}),
						}
					: {},
			);
		}

		// From start() to the commit, any failure cancels the Output (so the encoders
		// are released), aborts the sink and then reaches the caller unchanged.
		let finalizing = false;
		try {
			await output.start();

			const feeder =
				audioSource && audioTrack
					? createAudioFeeder({
							source: audioSource,
							buffer: audioTrack.buffer,
							startSample: audioTrack.startSample,
							isCancelled: () => this.isCancelled,
						})
					: null;

			for (let i = 0; i < frameCount; i++) {
				const timeTicks = i * ticksPerFrame;
				const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
				// Audio up to this frame's time first: the two tracks go to the muxer
				// interleaved, at most one audio slice apart.
				if (this.isCancelled || (await feeder?.feedUntil({ seconds: timeSeconds })) === "cancelled") {
					return await this.reportCancelled({ output });
				}

				await this.memoryGuard?.({ index: i, frameCount, seconds: timeSeconds, totalSeconds: frameCount / fpsFloat });
				await this.renderer.render({ node: rootNode, time: timeTicks });
				await videoSource.add(timeSeconds, 1 / fpsFloat);

				this.emit("progress", i / frameCount);
				this.emit("frames", i + 1, frameCount);
			}

			if (this.isCancelled || (await feeder?.feedRest()) === "cancelled") {
				return await this.reportCancelled({ output });
			}

			this.emit("finalizing");
			audioSource?.close();
			videoSource.close();
			finalizing = true;
			await output.finalize();
			const result = await this.sink.commit();
			this.emit("progress", 1);
			this.emit("complete", result);
			return result;
		} catch (error) {
			// Once finalize() has started the Output closes itself; cancelling then only warns.
			if (!finalizing) {
				await cancelOutputQuietly({ output });
			}
			await this.sink.abort();
			throw error;
		}
	}

	private async reportCancelled({ output }: { output: Output }): Promise<null> {
		await cancelOutputQuietly({ output });
		await this.sink.abort();
		this.emit("cancelled");
		return null;
	}
}
