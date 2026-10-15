"use client";

import { useEffect } from "react";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import type { ImageElement, VideoElement } from "@/timeline";
import { registerMatteSource, unregisterMatteSource } from "../matte/matte-registry";
import { BrushMatteSource } from "./brush-source";
import { normalizeCutout } from "./types";

function cutoutClips({ editor }: { editor: EditorCore }): Array<VideoElement | ImageElement> {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return [];
	const found: Array<VideoElement | ImageElement> = [];
	for (const track of [tracks.main, ...tracks.overlay]) {
		for (const element of track.elements) {
			if ((element.type === "video" || element.type === "image") && element.cutout) found.push(element);
		}
	}
	return found;
}

/**
 * Keeps the renderer's matte registry equal to the clips' `cutout` fields: a source per clip,
 * replaced whenever the field changes, removed when it goes. The stored field is checked first
 * (stored data is untrusted); it is never rewritten here.
 */
export function BrushHost() {
	const editor = useEditor();

	useEffect(() => {
		const registered = new Map<string, unknown>();
		const sync = () => {
			const clips = cutoutClips({ editor });
			const present = new Set<string>();
			for (const element of clips) {
				present.add(element.id);
				if (registered.get(element.id) === element.cutout) continue;
				registered.set(element.id, element.cutout);
				const asset = editor.media.getAssets().find((candidate) => candidate.id === element.mediaId);
				const cutout = normalizeCutout({ value: element.cutout });
				if (!cutout || !asset?.width || !asset.height) {
					unregisterMatteSource({ elementId: element.id, kind: "brush" });
					continue;
				}
				registerMatteSource({
					elementId: element.id,
					kind: "brush",
					source: new BrushMatteSource({ cutout, sourceWidth: asset.width, sourceHeight: asset.height, elementId: element.id }),
				});
			}
			for (const id of [...registered.keys()]) {
				if (present.has(id)) continue;
				registered.delete(id);
				unregisterMatteSource({ elementId: id, kind: "brush" });
			}
		};
		sync();
		return editor.timeline.subscribe(sync);
	}, [editor]);

	return null;
}
