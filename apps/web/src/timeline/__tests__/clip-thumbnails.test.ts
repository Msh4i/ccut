import { describe, expect, test } from "bun:test";
import { createClipThumbnailCache } from "@/timeline/clip-thumbnails";

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a File stand-in: the cache only passes it on
const file = { name: "a.mp4" } as unknown as File;
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a File stand-in
const other = { name: "b.mp4" } as unknown as File;

describe("clip thumbnail cache", () => {
	test("the same source second of the same asset is decoded once", async () => {
		const calls: number[] = [];
		const get = createClipThumbnailCache({
			decode: async ({ seconds }) => {
				calls.push(seconds);
				return `url@${seconds}`;
			},
		});
		const [a, b, c] = await Promise.all([
			get({ assetId: "x", file, seconds: 8.8 }),
			get({ assetId: "x", file, seconds: 8.81 }),
			get({ assetId: "x", file, seconds: 11.3 }),
		]);
		expect([a, b, c]).toEqual(["url@8.8", "url@8.8", "url@11.3"]);
		expect(calls).toEqual([8.8, 11.3]);
	});

	test("different assets with the same second do not share a picture", async () => {
		const get = createClipThumbnailCache({
			decode: async ({ file: f }) => `url of ${f.name}`,
		});
		expect(await get({ assetId: "x", file, seconds: 1 })).toBe("url of a.mp4");
		expect(await get({ assetId: "y", file: other, seconds: 1 })).toBe(
			"url of b.mp4",
		);
	});

	test("decodes run one at a time, in request order", async () => {
		let running = 0;
		let overlap = 0;
		const order: number[] = [];
		const get = createClipThumbnailCache({
			decode: async ({ seconds }) => {
				running++;
				overlap = Math.max(overlap, running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(seconds);
				running--;
				return "ok";
			},
		});
		await Promise.all(
			[1, 2, 3].map((seconds) => get({ assetId: "x", file, seconds })),
		);
		expect(overlap).toBe(1);
		expect(order).toEqual([1, 2, 3]);
	});

	test("a failed decode gives null, does not stop the next one and is not retried", async () => {
		let attempts = 0;
		const get = createClipThumbnailCache({
			decode: async ({ seconds }) => {
				if (seconds === 1) {
					attempts++;
					throw new Error("unreadable");
				}
				return "fine";
			},
		});
		expect(await get({ assetId: "x", file, seconds: 1 })).toBeNull();
		expect(await get({ assetId: "x", file, seconds: 2 })).toBe("fine");
		expect(await get({ assetId: "x", file, seconds: 1 })).toBeNull();
		expect(attempts).toBe(1);
	});
});
