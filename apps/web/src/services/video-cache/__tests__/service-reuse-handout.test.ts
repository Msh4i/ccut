import { describe, expect, test } from "bun:test";
import { VideoCache } from "../service";
import { createFakeVideo, settle } from "./fake-video";

// Review finding S1 (claude/playback-streams 9118160): a clip asked again at the
// same time reused its previous answer without marking its canvas as handed out
// or its stream as busy; another clip then took that stream over, the canvas
// went back to the free list and was redrawn with a third clip's frame while the
// first layer still uploaded it. 4K frames at the fallback budget, so the frame
// LRU keeps nothing and every canvas goes through the free list.
describe("a reused answer keeps its canvas", () => {
	for (const playedAlone of [8, 12]) {
		test(`after another clip played alone for ${playedAlone} draws`, async () => {
			const fps = 30;
			const video = createFakeVideo({
				fps,
				frameCount: 3000,
				frameBytes: { decoded: 3840 * 2160 * 1.5, drawn: 3840 * 2160 * 4 },
			});
			let now = 0;
			const cache = new VideoCache({ openSource: async () => video.source, now: () => now });
			const file = new File([], "m1");
			const ask = ({ key, index }: { key: string; index: number }) =>
				cache.getFrameAt({ mediaId: "m1", file, time: video.timeOf(index), streamKey: key });

			now += 33;
			await Promise.all([ask({ key: "a", index: 300 }), ask({ key: "b", index: 900 })]);
			await settle();
			for (let k = 1; k <= playedAlone; k++) {
				now += 33;
				await ask({ key: "b", index: 900 + k });
				await settle();
			}
			now += 33;
			const [a, , , b] = await Promise.all([
				ask({ key: "a", index: 300 }),
				ask({ key: "c", index: 302 }),
				ask({ key: "d", index: 2000 }),
				ask({ key: "b", index: 900 + playedAlone + 1 }),
			]);

			expect(a).not.toBeNull();
			expect(b).not.toBeNull();
			expect(Math.round((a?.timestamp ?? -1) * fps)).toBe(300);
			// The canvas A's layer uploads still holds A's frame, and is not B's.
			expect(a?.canvas.frame).toBe(300);
			expect(a?.canvas).not.toBe(b?.canvas);
		});
	}
});
