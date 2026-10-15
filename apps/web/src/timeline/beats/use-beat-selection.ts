"use client";

import { useCallback, useEffect } from "react";
import type { EditorCore } from "@/core";
import { registerCanceller } from "@/editor/cancel-interaction";
import { useEditor } from "@/editor/use-editor";
import { normalizeBeats } from "./normalize";
import { getVisibleSourceBeats } from "./resolve";
import {
	clearBeatSelection,
	editPickedBeats,
	useBeatSelectionStore,
	type BeatSelection,
} from "./selection";

/** The clip a selection belongs to, when it still exists and can carry beats. */
function getClip({
	editor,
	selection,
}: {
	editor: EditorCore;
	selection: BeatSelection;
}) {
	const element = editor.timeline.getElementsWithTracks({
		elements: [{ trackId: selection.trackId, elementId: selection.elementId }],
	})[0]?.element;
	return element && (element.type === "audio" || element.type === "video")
		? element
		: undefined;
}

/**
 * What the toolbar needs to act on the beats picked on a clip. The count only
 * includes beats that are still on screen: the clip may have been trimmed since.
 */
export function useBeatSelection() {
	const editor = useEditor();
	const selection = useBeatSelectionStore((store) => store.selection);
	const count = useEditor((current) => {
		const clip = selection && getClip({ editor: current, selection });
		return clip
			? getVisibleSourceBeats({ element: clip }).filter((beat) =>
					selection.ticks.has(beat),
				).length
			: 0;
	});

	useEffect(() => {
		if (selection && count === 0) clearBeatSelection();
	}, [selection, count]);

	// Esc drops the picks first and only then the clip selection (see cancel-interaction).
	useEffect(
		() => (count > 0 ? registerCanceller({ fn: clearBeatSelection }) : undefined),
		[count],
	);

	const apply = useCallback(
		({ keep }: { keep: boolean }) => {
			const current = useBeatSelectionStore.getState().selection;
			const clip = current && getClip({ editor, selection: current });
			const beats = clip && normalizeBeats({ raw: clip.beats });
			const edit =
				current && clip && beats
					? editPickedBeats({
							beats,
							visible: getVisibleSourceBeats({ element: clip }),
							ticks: current.ticks,
							keep,
						})
					: null;
			if (current && edit) {
				editor.timeline.updateElements({
					updates: [
						{
							trackId: current.trackId,
							elementId: current.elementId,
							patch: { beats: edit.beats },
						},
					],
				});
			}
			clearBeatSelection();
		},
		[editor],
	);

	return {
		count,
		keep: () => apply({ keep: true }),
		remove: () => apply({ keep: false }),
	};
}
