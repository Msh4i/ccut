import type { InsertElementParams } from "@/commands/timeline/element/insert-element";
import {
	buildGraphicElement,
	buildStickerElement,
} from "@/timeline/element-utils";
import type { MediaTime } from "@/wasm";
import { describeError, describeId } from "./describe-id";
import { resolveStickerIntrinsicSize } from "./index";
import type { StickerItem } from "./types";

/** The part of a shape sticker that becomes a graphic element. */
export interface ShapePreset {
	definitionId: string;
	name: string;
	params?: Parameters<typeof buildGraphicElement>[0]["params"];
}

/** The part of the editor that adding a sticker uses. */
export interface StickerEditor {
	playback: { getCurrentTime: () => MediaTime };
	timeline: { insertElement: (params: InsertElementParams) => void };
}

/**
 * Puts a sticker on the timeline at the playhead. A sticker is checked and
 * measured first (`resolveStickerIntrinsicSize` rejects when its image cannot
 * be loaded), so a broken one is never added as an element that renders as
 * nothing; the caller shows the failure. It enters "recently used" only after
 * it was inserted.
 */
export async function addSticker({
	item,
	shapePreset,
	editor,
	addToRecent,
	resolveIntrinsicSize = resolveStickerIntrinsicSize,
}: {
	item: StickerItem;
	shapePreset: ShapePreset | null;
	editor: StickerEditor;
	addToRecent: ({ stickerId }: { stickerId: string }) => void;
	resolveIntrinsicSize?: ({
		stickerId,
	}: {
		stickerId: string;
	}) => Promise<{ width: number; height: number }>;
}): Promise<void> {
	const currentTime = editor.playback.getCurrentTime();

	let element: InsertElementParams["element"];
	if (shapePreset) {
		element = buildGraphicElement({
			definitionId: shapePreset.definitionId,
			name: shapePreset.name,
			startTime: currentTime,
			params: shapePreset.params,
		});
	} else {
		const { width, height } = await resolveIntrinsicSize({
			stickerId: item.id,
		});
		element = buildStickerElement({
			stickerId: item.id,
			name: item.name,
			startTime: currentTime,
			intrinsicWidth: width,
			intrinsicHeight: height,
		});
	}

	editor.timeline.insertElement({ placement: { mode: "auto" }, element });
	// The element is on the timeline now: the recents list failing must not make
	// the add look failed (the user would retry and add it twice).
	try {
		addToRecent({ stickerId: item.id });
	} catch (error) {
		console.warn(
			`Could not remember "${describeId({ value: item.id })}" as recently used: ${describeError({ error })}`,
		);
	}
}
