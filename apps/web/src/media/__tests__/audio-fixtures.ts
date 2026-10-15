import { FakeAudioBuffer } from "@/export/__tests__/fake-audio-buffer";
import type { MediaAsset } from "@/media/types";
import type {
	AudioTrack,
	LibraryAudioElement,
	SceneTracks,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime } from "@/wasm";

// Shared by the tests of the export's audio: a Web Audio stand-in and timeline
// builders, so that the real mixing code can run in bun.

export class FakeAudioContext {
	static decode: (data: ArrayBuffer) => Promise<FakeAudioBuffer> = async () => {
		throw new Error("decode not configured");
	};
	readonly sampleRate: number;
	constructor(options?: { sampleRate?: number }) {
		this.sampleRate = options?.sampleRate ?? 44100;
	}
	// The positional signature is the Web Audio one, declared as a tuple rest.
	createBuffer(...[numberOfChannels, length, sampleRate]: Parameters<AudioContext["createBuffer"]>) {
		return new FakeAudioBuffer({ numberOfChannels, length, sampleRate });
	}
	// Like the real one, it takes the bytes over: the caller's buffer is detached.
	decodeAudioData(data: ArrayBuffer) {
		return FakeAudioContext.decode(data.transfer());
	}
}

/**
 * The resampler of a video's audio: copies its source into a buffer of the
 * asked length (the tests decode at the export rate, so a copy is exact) and
 * counts how many it made, which is how many times a video's audio was decoded
 * (in tests without a pitch-preserving retime, which makes its own). `events`
 * logs when each rendering starts and ends.
 */
export class FakeOfflineAudioContext {
	static created = 0;
	static events: string[] = [];
	readonly destination = {};
	private readonly numberOfChannels: number;
	private readonly length: number;
	private readonly sampleRate: number;
	private source: { buffer: AudioBuffer | null } | null = null;
	constructor(...[numberOfChannels, length, sampleRate]: ConstructorParameters<typeof OfflineAudioContext>) {
		FakeOfflineAudioContext.created += 1;
		this.numberOfChannels = numberOfChannels;
		this.length = length;
		this.sampleRate = sampleRate;
	}
	createBufferSource() {
		const node = { buffer: null, connect: () => {}, start: () => {} };
		this.source = node;
		return node;
	}
	async startRendering(): Promise<FakeAudioBuffer> {
		FakeOfflineAudioContext.events.push("render-start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		FakeOfflineAudioContext.events.push("render-end");
		const output = new FakeAudioBuffer({
			numberOfChannels: this.numberOfChannels,
			length: this.length,
			sampleRate: this.sampleRate,
		});
		const input = this.source?.buffer;
		if (!input) throw new Error("no source");
		if (input.sampleRate !== this.sampleRate) throw new Error("the fake resampler only copies");
		for (let channel = 0; channel < this.numberOfChannels; channel++) {
			output.copyToChannel(input.getChannelData(channel).subarray(0, this.length), channel);
		}
		return output;
	}
}

/**
 * A real 16-bit PCM WAV file that mediabunny reads like a video's audio track.
 * Sample `frame` of channel `channel` is `value({ channel, frame })`, an integer.
 */
export function pcmFile({
	frames,
	channels,
	value,
	name = "clip.mp4",
}: {
	frames: number;
	channels: number;
	value: ({ channel, frame }: { channel: number; frame: number }) => number;
	name?: string;
}): File {
	const blockAlign = channels * 2;
	const header = new DataView(new ArrayBuffer(44 + frames * blockAlign));
	const text = ({ offset, chars }: { offset: number; chars: string }) => {
		for (let index = 0; index < chars.length; index++) header.setUint8(offset + index, chars.charCodeAt(index));
	};
	text({ offset: 0, chars: "RIFF" });
	header.setUint32(4, 36 + frames * blockAlign, true);
	text({ offset: 8, chars: "WAVE" });
	text({ offset: 12, chars: "fmt " });
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, channels, true);
	header.setUint32(24, 44100, true);
	header.setUint32(28, 44100 * blockAlign, true);
	header.setUint16(32, blockAlign, true);
	header.setUint16(34, 16, true);
	text({ offset: 36, chars: "data" });
	header.setUint32(40, frames * blockAlign, true);
	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			header.setInt16(44 + frame * blockAlign + channel * 2, value({ channel, frame }), true);
		}
	}
	return new File([header.buffer], name, { type: "video/mp4" });
}

export function toneBuffer({ seconds, value = 0.25 }: { seconds: number; value?: number }) {
	const buffer = new FakeAudioBuffer({ length: Math.round(seconds * 44100), numberOfChannels: 2, sampleRate: 44100 });
	for (let channel = 0; channel < 2; channel++) buffer.getChannelData(channel).fill(value);
	return buffer;
}

export const ONE_SECOND = 120000;

export function uploadAudio({ id, name, mediaId }: { id: string; name: string; mediaId: string }): UploadAudioElement {
	return {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId,
		name,
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: ONE_SECOND }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

export function libraryAudio({
	id,
	name,
	buffer,
	sourceUrl = `https://example.test/${id}.mp3`,
}: {
	id: string;
	name: string;
	buffer?: AudioBuffer;
	sourceUrl?: string;
}): LibraryAudioElement {
	return {
		id,
		type: "audio",
		sourceType: "library",
		sourceUrl,
		name,
		buffer,
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: ONE_SECOND }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

export function videoClip({
	id,
	name,
	mediaId,
	startTicks = 0,
	durationTicks = ONE_SECOND,
	trimStartTicks = 0,
}: {
	id: string;
	name: string;
	mediaId: string;
	startTicks?: number;
	durationTicks?: number;
	trimStartTicks?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		mediaId,
		name,
		startTime: mediaTime({ ticks: startTicks }),
		duration: mediaTime({ ticks: durationTicks }),
		trimStart: mediaTime({ ticks: trimStartTicks }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

export function audioAsset({ id, bytes = 16 }: { id: string; bytes?: number }): MediaAsset {
	return { id, name: `${id}.mp3`, type: "audio", file: new File([new Uint8Array(bytes)], `${id}.mp3`, { type: "audio/mpeg" }) };
}

export function videoAsset({ id, file, hasAudio }: { id: string; file: File; hasAudio?: boolean }): MediaAsset {
	return { id, name: file.name, type: "video", file, hasAudio };
}

export function tracksWith({
	audio = [],
	video = [],
}: {
	audio?: (UploadAudioElement | LibraryAudioElement)[];
	video?: VideoElement[];
}): SceneTracks {
	const main: VideoTrack = { id: "main", name: "Main", type: "video", elements: video, muted: false, hidden: false };
	const audioTrack: AudioTrack = { id: "a1", name: "Audio", type: "audio", elements: audio, muted: false };
	return { overlay: [], main, audio: [audioTrack] };
}
