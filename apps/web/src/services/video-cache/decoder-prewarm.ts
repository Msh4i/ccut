import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny";

/**
 * The first use of the video decoder (GPU/utility process, VA-API) took ~4.3 s on the owner's
 * machine: the first 10-11 `MojoVideoDecoder::Decode` calls of the first Space all returned
 * together after that long. This decodes the first key frame of a video once, with the very
 * decoder configuration the playback uses (mediabunny's `getDecoderConfig()`, no
 * `hardwareAcceleration` preference = "no-preference"), and throws the picture away, so the
 * first Space finds a warm decoder. Never rejects: a failed warm-up changes nothing.
 */
export async function warmDecoderWithFile({ file }: { file: File }): Promise<void> {
	if (typeof VideoDecoder === "undefined") return;
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	let decoder: VideoDecoder | null = null;
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) return;
		const config = await track.getDecoderConfig();
		if (!config || !(await VideoDecoder.isConfigSupported(config)).supported) return;
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		if (!packet) return;
		decoder = new VideoDecoder({ output: (frame) => frame.close(), error: () => {} });
		decoder.configure(config);
		decoder.decode(packet.toEncodedVideoChunk());
		await decoder.flush();
	} catch {
		// nothing to undo
	} finally {
		if (decoder && decoder.state !== "closed") decoder.close();
		input.dispose();
	}
}

/**
 * Warms the decoder for each distinct video asset, one after the other (the first one pays the
 * cold start, the rest are quick), and tells the UI while it is busy.
 */
export class DecoderPrewarmer {
	private readonly requested = new Map<string, Promise<void>>();
	private chain: Promise<void> = Promise.resolve();
	private pending = 0;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly warmOne: ({ file }: { file: File }) => Promise<void>) {}

	/** Starts (once per asset) and resolves when this asset's decoder is warm. */
	request({ assetId, file }: { assetId: string; file: File }): Promise<void> {
		const known = this.requested.get(assetId);
		if (known) return known;
		this.pending += 1;
		this.notify();
		const run = this.chain.then(() => this.warmOne({ file })).catch(() => {});
		this.chain = run;
		const done = run.finally(() => {
			this.pending -= 1;
			this.notify();
		});
		this.requested.set(assetId, done);
		return done;
	}

	/** Resolves when everything requested so far is warm. */
	idle(): Promise<void> {
		return this.chain.then(() => undefined);
	}

	isWarming(): boolean {
		return this.pending > 0;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify() {
		for (const listener of this.listeners) listener();
	}
}

export const decoderPrewarmer = new DecoderPrewarmer(warmDecoderWithFile);
