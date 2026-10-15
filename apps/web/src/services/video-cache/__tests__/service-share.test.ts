import { describe, expect, test } from "bun:test";
import { type StreamLimits, VideoCache } from "../service";
import { type FakeCanvas, createFakeVideo, settle } from "./fake-video";

// More clips of one file on screen than the file may have streams: a clip
// without a stream of its own borrows one (its request queues behind the
// owner's), so every clip gets its own frame, never another clip's.

type FakeVideo = ReturnType<typeof createFakeVideo>;

const FPS = 30;
/** 1.7 s between two clips, as in the simulator's N-clip scenario. */
const SPACING = 51;
const FILE = new File([], "m1");
const DECODED_4K = 3840 * 2160 * 1.5;
const DRAWN_4K = 3840 * 2160 * 4;

function setup({
	video,
	streams,
}: {
	video: FakeVideo;
	streams?: Partial<StreamLimits>;
}) {
	const clock = { now: 0 };
	const cache = new VideoCache<FakeCanvas>({
		openSource: async () => video.source,
		now: () => clock.now,
		streams,
	});
	const ask = ({ index, key, scale }: { index: number; key: string; scale?: number }) =>
		cache.getFrameAt({
			mediaId: "m1",
			file: FILE,
			time: video.timeOf(index),
			streamKey: key,
			...(scale !== undefined && { scale }),
		});
	return { cache, clock, ask };
}

function frameIndex(frame: { timestamp: number } | null): number | null {
	return frame ? Math.round(frame.timestamp * FPS) : null;
}

/** Index clip `clip` (0-based) shows in draw `draw`. */
function indexOfClip({ clip, draw }: { clip: number; draw: number }): number {
	return 300 + clip * SPACING + draw;
}

/** Decoders opened at the times of one clip's first `draws` draws. */
function openedFor({ video, clip, draws }: { video: FakeVideo; clip: number; draws: number }): number {
	const from = video.timeOf(indexOfClip({ clip, draw: 0 })) - 1e-9;
	const to = video.timeOf(indexOfClip({ clip, draw: draws }));
	return video.log.opened.filter((time) => time >= from && time < to).length;
}

describe("VideoCache: more clips of one file than streams", () => {
	test("five clips: every answer is its own clip's frame in every draw, on 4 streams; the owners keep their decoders", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 2000 });
		const { cache, clock, ask } = setup({ video, streams: { maxPerMedia: 4 } });
		const keys = ["c1", "c2", "c3", "c4", "c5"];
		for (let draw = 0; draw < 10; draw++) {
			clock.now += 1000 / FPS;
			const answers = await Promise.all(
				keys.map((key, clip) => ask({ index: indexOfClip({ clip, draw }), key })),
			);
			for (let clip = 0; clip < keys.length; clip++) {
				const expected = indexOfClip({ clip, draw });
				expect({ clip, draw, shown: frameIndex(answers[clip]) }).toEqual({ clip, draw, shown: expected });
				expect({ clip, draw, canvas: answers[clip]?.canvas.frame }).toEqual({ clip, draw, canvas: expected });
			}
			await settle();
		}
		expect(cache.getStats().streams).toBe(4);
		// c2..c4 own their streams for the whole run: one decoder start each.
		for (const clip of [1, 2, 3]) expect(openedFor({ video, clip, draws: 10 })).toBe(1);
		expect(cache.getCounters().borrows).toBeGreaterThanOrEqual(10);
	});

	test("an owner that played 10 small frames while a borrower drew on its stream pauses on its own frame", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 2000 });
		const { clock, ask } = setup({ video, streams: { maxPerMedia: 1 } });
		for (let step = 0; step < 10; step++) {
			clock.now += 1000 / FPS;
			await ask({ index: 10 + step, key: "owner", scale: 0.25 });
			await ask({ index: 900 + step, key: "borrower", scale: 0.25 });
			await settle();
		}
		clock.now += 1000;
		const paused = await ask({ index: 19, key: "owner", scale: 1 });
		expect(frameIndex(paused)).toBe(19);
		expect(paused?.canvas.frame).toBe(19);
		expect(paused?.canvas.scale).toBe(1);
	});

	test("a borrowed request never overtakes the owner's request on that stream", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 2000, decode: "manual" });
		const { ask } = setup({ video, streams: { maxPerMedia: 1 } });
		video.release(1000);
		await ask({ index: 300, key: "owner" });
		await settle();
		const owner = ask({ index: 310, key: "owner" });
		const borrower = ask({ index: 600, key: "borrower" });
		video.release(1000);
		expect(frameIndex(await owner)).toBe(310);
		expect(frameIndex(await borrower)).toBe(600);
	});

	test("a request its own clip overtook never answers with the frame another clip left on the canvas", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 2000, decode: "manual" });
		const { ask } = setup({ video, streams: { maxPerMedia: 1 } });
		video.release(1000);
		await Promise.all([ask({ index: 300, key: "owner" }), ask({ index: 600, key: "borrower" })]);
		await settle();
		// The canvas shows the borrower's frame 600 now. The owner scrubs: its
		// first request is overtaken before it runs.
		const overtaken = ask({ index: 320, key: "owner" });
		const latest = ask({ index: 330, key: "owner" });
		video.release(1000);
		expect(frameIndex(await overtaken)).toBe(320);
		expect(frameIndex(await latest)).toBe(330);
	});

	test("a clip asking its time again after other clips drew on its stream gets its frame, not a canvas drawn over since", async () => {
		const video = createFakeVideo({
			fps: FPS,
			frameCount: 2000,
			frameBytes: { decoded: DECODED_4K, drawn: DRAWN_4K },
		});
		const { ask } = setup({ video, streams: { maxPerMedia: 1 } });
		const first = await ask({ index: 300, key: "owner" });
		expect(first?.canvas.frame).toBe(300);
		await settle();
		// Another clip plays on the same stream long enough for the owner's
		// canvas to be free again and drawn over.
		for (let step = 0; step < 12; step++) {
			await ask({ index: 600 + step, key: "other" });
			await settle();
		}
		const again = await ask({ index: 300, key: "owner" });
		expect(frameIndex(again)).toBe(300);
		expect(again?.canvas.frame).toBe(300);
	});

	test("twelve clips: every answer's canvas still holds its frame when the draw's last answer settles", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 3000 });
		const { cache, clock, ask } = setup({ video });
		for (let draw = 0; draw < 10; draw++) {
			clock.now += 1000 / FPS;
			const answers = await Promise.all(
				Array.from({ length: 12 }, (_, clip) => ask({ index: indexOfClip({ clip, draw }), key: `c${clip + 1}` })),
			);
			const held = answers.map((answer) => answer?.canvas.frame ?? null);
			expect(held).toEqual(Array.from({ length: 12 }, (_, clip) => indexOfClip({ clip, draw })));
			await settle();
		}
		// At full size the 256 MB budget fits 3 streams beside the 13 free canvases of 12 clips.
		expect(cache.getStats().streams).toBe(3);
	});

	test("the canvas quarantine follows the clips drawn per render, not the streams: five clips on one stream", async () => {
		// 4K frames leave no room for kept frames: every frame a stream stops
		// showing goes straight back to the free canvases.
		const video = createFakeVideo({
			fps: FPS,
			frameCount: 2000,
			frameBytes: { decoded: DECODED_4K, drawn: DRAWN_4K },
		});
		const { clock, ask } = setup({ video, streams: { maxPerMedia: 1 } });
		for (let draw = 0; draw < 6; draw++) {
			clock.now += 1000 / FPS;
			const answers = await Promise.all(
				Array.from({ length: 5 }, (_, clip) => ask({ index: indexOfClip({ clip, draw }), key: `c${clip + 1}` })),
			);
			const held = answers.map((answer) => answer?.canvas.frame ?? null);
			expect({ draw, held }).toEqual({
				draw,
				held: Array.from({ length: 5 }, (_, clip) => indexOfClip({ clip, draw })),
			});
			await settle();
		}
	});
});

describe("VideoCache: a clip's own stream before the drawn-frame cache", () => {
	test("clips 1.7 s apart at preview size: each plays on its own decoder, not on frames another clip drew", async () => {
		// The frame clip 1 needs was drawn by clip 2 1.7 s earlier; answering
		// it from there left clip 1's decoder behind, restarting it later.
		const video = createFakeVideo({ fps: FPS, frameCount: 3000 });
		const { cache, clock, ask } = setup({ video });
		for (let draw = 0; draw < 150; draw++) {
			clock.now += 1000 / FPS;
			const answers = await Promise.all(
				[0, 1, 2].map((clip) => ask({ index: indexOfClip({ clip, draw }), key: `c${clip + 1}`, scale: 0.25 })),
			);
			expect(answers.map(frameIndex)).toEqual([0, 1, 2].map((clip) => indexOfClip({ clip, draw })));
			await settle();
		}
		expect(cache.getCounters().restarts).toBe(3);
	});

	test("a time the own stream cannot reach without a restart still comes from the drawn-frame cache", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 3000 });
		const { cache, clock, ask } = setup({ video });
		for (let draw = 0; draw < 20; draw++) {
			clock.now += 1000 / FPS;
			await ask({ index: 300 + draw, key: "c1", scale: 0.25 });
			await settle();
		}
		const restarts = cache.getCounters().restarts;
		const hits = cache.getCounters().lruHits;
		// Scrubbing back over what it just played.
		expect(frameIndex(await ask({ index: 305, key: "c1", scale: 0.25 }))).toBe(305);
		expect(cache.getCounters().restarts).toBe(restarts);
		expect(cache.getCounters().lruHits).toBe(hits + 1);
	});
});

describe("VideoCache: clips of one file at more sizes than streams", () => {
	test("five clips of one 4K file at five sizes reuse their canvases (no new canvas per draw)", async () => {
		const BUCKETS = [1, Math.SQRT1_2, 0.5, Math.SQRT1_2 / 2, 0.25];
		const video = createFakeVideo({
			fps: FPS,
			frameCount: 20000,
			frameBytes: { decoded: DECODED_4K, drawn: DRAWN_4K },
		});
		const { clock, ask } = setup({ video });
		for (let draw = 0; draw < 50; draw++) {
			clock.now += 1000 / FPS;
			const answers = await Promise.all(
				BUCKETS.map((scale, clip) =>
					ask({ index: clip * 1500 + draw, key: `c${clip + 1}`, scale }),
				),
			);
			expect(answers.map(frameIndex)).toEqual(BUCKETS.map((_, clip) => clip * 1500 + draw));
			await settle();
		}
		// 250 frames drawn; the reviewer's probe made one canvas per draw (248).
		expect(video.log.drawn.length).toBe(250);
		expect(video.log.canvases).toBeLessThanOrEqual(40);
	});
});
