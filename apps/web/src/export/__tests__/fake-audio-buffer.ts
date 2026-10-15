// bun has no Web Audio. This is a complete `AudioBuffer` (every member of the
// DOM interface), so tests can pass it where an `AudioBuffer` is typed without
// casts. Like the real constructor it refuses a zero length: that is what
// makes the "nothing left after the drop" case in audio-slices observable.
export class FakeAudioBuffer implements AudioBuffer {
	readonly sampleRate: number;
	readonly length: number;
	readonly numberOfChannels: number;
	private readonly channels: Float32Array<ArrayBuffer>[];

	constructor({ length, numberOfChannels = 1, sampleRate }: AudioBufferOptions) {
		if (!Number.isInteger(length) || length < 1) {
			throw new RangeError(`AudioBuffer length must be >= 1, got ${length}`);
		}
		this.length = length;
		this.numberOfChannels = numberOfChannels;
		this.sampleRate = sampleRate;
		this.channels = Array.from(
			{ length: numberOfChannels },
			() => new Float32Array(length),
		);
	}

	get duration(): number {
		return this.length / this.sampleRate;
	}

	getChannelData(channel: number): Float32Array<ArrayBuffer> {
		const data = this.channels[channel];
		if (!data) {
			throw new RangeError(`no channel ${channel}`);
		}
		return data;
	}

	// The positional signatures below are fixed by the DOM interface, so they are
	// declared as tuple rests (one parameter, as the repo's object-params rule wants).
	copyFromChannel(
		...[destination, channelNumber, bufferOffset = 0]: Parameters<AudioBuffer["copyFromChannel"]>
	): void {
		// Like the real one: as many samples as fit in `destination`, or as remain.
		destination.set(
			this.getChannelData(channelNumber).subarray(bufferOffset, bufferOffset + destination.length),
		);
	}

	copyToChannel(
		...[source, channelNumber, bufferOffset = 0]: Parameters<AudioBuffer["copyToChannel"]>
	): void {
		this.getChannelData(channelNumber).set(source, bufferOffset);
	}
}

/** A buffer whose channel `c` holds `value(c, i)` at frame `i` (rounded to float32). */
export function createFilledBuffer({
	length,
	numberOfChannels,
	sampleRate,
	value,
}: {
	length: number;
	numberOfChannels: number;
	sampleRate: number;
	value: ({ channel, frame }: { channel: number; frame: number }) => number;
}): FakeAudioBuffer {
	const buffer = new FakeAudioBuffer({ length, numberOfChannels, sampleRate });
	for (let channel = 0; channel < numberOfChannels; channel++) {
		const data = buffer.getChannelData(channel);
		for (let frame = 0; frame < length; frame++) {
			data[frame] = value({ channel, frame });
		}
	}
	return buffer;
}
