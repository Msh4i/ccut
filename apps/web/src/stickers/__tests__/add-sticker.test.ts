import { describe, expect, spyOn, test } from "bun:test";
import { addSticker } from "../add-sticker";
import { createSingleFlight } from "../single-flight";
import type { StickerItem } from "../types";
import { mediaTime } from "@/wasm";

function tile({ id, provider, name }: { id: string; provider: string; name: string }): StickerItem {
	return { id, provider, name, previewUrl: `/${id}.svg`, metadata: {} };
}

function fakeEditor({ at = 4000 }: { at?: number } = {}) {
	const inserted: { placement: unknown; element: Record<string, unknown> }[] = [];
	return {
		inserted,
		editor: {
			playback: { getCurrentTime: () => mediaTime({ ticks: at }) },
			timeline: {
				insertElement: (args: { placement: unknown; element: Record<string, unknown> }) => void inserted.push(args),
			},
		},
	};
}

describe("addSticker", () => {
	const fire = tile({ id: "emoji:1f525", provider: "emoji", name: "Fire" });

	test("inserts one sticker element at the playhead, sized from the loaded image", async () => {
		const { editor, inserted } = fakeEditor({ at: 4000 });
		const recent: string[] = [];
		await addSticker({
			item: fire,
			shapePreset: null,
			editor,
			addToRecent: ({ stickerId }) => recent.push(stickerId),
			resolveIntrinsicSize: async () => ({ width: 512, height: 256 }),
		});
		expect(inserted).toHaveLength(1);
		expect(inserted[0].placement).toEqual({ mode: "auto" });
		expect(inserted[0].element).toMatchObject({
			type: "sticker",
			name: "Fire",
			stickerId: "emoji:1f525",
			intrinsicWidth: 512,
			intrinsicHeight: 256,
			startTime: mediaTime({ ticks: 4000 }),
		});
		expect(recent).toEqual(["emoji:1f525"]);
	});

	test("a shape becomes a graphic element and needs no image", async () => {
		const { editor, inserted } = fakeEditor();
		let looked = 0;
		await addSticker({
			item: tile({ id: "shapes:circle", provider: "shapes", name: "Circle" }),
			shapePreset: { definitionId: "ellipse", name: "Circle" },
			editor,
			addToRecent: () => {},
			resolveIntrinsicSize: async () => {
				looked++;
				return { width: 1, height: 1 };
			},
		});
		expect(looked).toBe(0);
		expect(inserted[0].element).toMatchObject({ type: "graphic", definitionId: "ellipse", name: "Circle" });
	});

	test("a sticker that cannot be loaded inserts nothing, remembers nothing, and rejects", async () => {
		const { editor, inserted } = fakeEditor();
		const recent: string[] = [];
		await expect(
			addSticker({
				item: tile({ id: "emoji:zzz", provider: "emoji", name: "Zzz" }),
				shapePreset: null,
				editor,
				addToRecent: ({ stickerId }) => recent.push(stickerId),
				resolveIntrinsicSize: async () => {
					throw new Error('Sticker "emoji:zzz" could not be loaded');
				},
			}),
		).rejects.toThrow(/could not be loaded/);
		expect(inserted).toHaveLength(0);
		expect(recent).toEqual([]);
	});

	test("pressing the add button twice while the image loads adds one element, not two", async () => {
		const { editor, inserted } = fakeEditor();
		const flight = createSingleFlight();
		let release: () => void = () => {};
		const slowSize = () =>
			new Promise<{ width: number; height: number }>((done) => {
				release = () => done({ width: 64, height: 64 });
			});
		const trigger = () =>
			flight.run(() =>
				addSticker({ item: fire, shapePreset: null, editor, addToRecent: () => {}, resolveIntrinsicSize: slowSize }),
			);
		const first = trigger();
		const second = trigger();
		release();
		await Promise.all([first, second]);
		expect(inserted).toHaveLength(1);

		// and it works again afterwards
		const third = trigger();
		release();
		await third;
		expect(inserted).toHaveLength(2);
	});

	test("a failure in the recents list does not make the add fail: the element is in, a retry would add it twice", async () => {
		const { editor, inserted } = fakeEditor();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			addSticker({
				item: fire,
				shapePreset: null,
				editor,
				addToRecent: () => {
					throw new Error("recents are damaged");
				},
				resolveIntrinsicSize: async () => ({ width: 64, height: 64 }),
			}),
		).resolves.toBeUndefined();
		expect(inserted).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	test("the warning about the recents list stays short for a huge sticker id", async () => {
		const { editor } = fakeEditor();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		await addSticker({
			item: tile({ id: `emoji:${"x".repeat(10_000)}`, provider: "emoji", name: "Huge" }),
			shapePreset: null,
			editor,
			addToRecent: () => {
				throw new Error("recents are damaged");
			},
			resolveIntrinsicSize: async () => ({ width: 64, height: 64 }),
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0]).length).toBeLessThan(400);
		warn.mockRestore();
	});
});
