import { describe, expect, test } from "bun:test";
import { collectStereoInt16 } from "@/media/stem-audio";

type Chunk = Parameters<typeof collectStereoInt16>[0]["chunks"] extends AsyncIterable<infer T> ? T : never;

function chunk({ channels, sampleRate = 44100 }: { channels: number[][]; sampleRate?: number }): Chunk {
	const data = channels.map((channel) => Float32Array.from(channel));
	return {
		numberOfChannels: data.length,
		length: data[0].length,
		sampleRate,
		getChannelData: (channel: number) => data[channel],
	};
}

async function* of(...chunks: Chunk[]) {
	for (const part of chunks) yield part;
}

const collect = ({ chunks, maxSeconds = 900 }: { chunks: AsyncIterable<Chunk>; maxSeconds?: number }) =>
	collectStereoInt16({ chunks, maxSeconds });

describe("collectStereoInt16", () => {
	test("interleaves left and right, keeps the first two channels, doubles a mono source", async () => {
		const stereo = await collect({ chunks: of(chunk({ channels: [[0.5, -0.5], [0.25, -0.25], [1, 1]] })) });
		expect(stereo).toEqual({
			ok: true,
			samples: Int16Array.from([16384, 8192, -16383, -8192]),
			sampleRate: 44100,
			frames: 2,
		});
		const mono = await collect({ chunks: of(chunk({ channels: [[0.5, -0.5]] })) });
		expect(mono.ok && mono.samples).toEqual(Int16Array.from([16384, 16384, -16383, -16383]));
	});

	test("NaN becomes silence and a sample beyond full scale is clamped, never wrapped", async () => {
		const result = await collect({ chunks: of(chunk({ channels: [[Number.NaN, 3, -3], [Number.POSITIVE_INFINITY, 1, -1]] })) });
		expect(result.ok && result.samples).toEqual(Int16Array.from([0, 0, 32767, 32767, -32767, -32767]));
	});

	test("chunks join in order and the frames add up", async () => {
		const result = await collect({ chunks: of(chunk({ channels: [[0.5], [0.5]] }), chunk({ channels: [[-0.5, 0], [-0.5, 0]] })) });
		expect(result.ok && result.frames).toBe(3);
		expect(result.ok && result.samples).toEqual(Int16Array.from([16384, 16384, -16383, -16383, 0, 0]));
	});

	test("a rate the separator does not take, a changing rate, silence of length 0 and a too long clip are refused", async () => {
		expect(await collect({ chunks: of(chunk({ channels: [[0.1]], sampleRate: 12345 })) })).toEqual({ ok: false, reason: "unreadable" });
		expect(await collect({ chunks: of(chunk({ channels: [[0.1]] }), chunk({ channels: [[0.1]], sampleRate: 48000 })) })).toEqual({ ok: false, reason: "unreadable" });
		expect(await collect({ chunks: of() })).toEqual({ ok: false, reason: "unreadable" });
		const second = chunk({ channels: [new Array(44100).fill(0.1)] });
		expect(await collect({ chunks: of(second, second, second), maxSeconds: 2 })).toEqual({ ok: false, reason: "too-long" });
	});
});
