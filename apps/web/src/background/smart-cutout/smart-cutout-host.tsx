"use client";

import { useEffect } from "react";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import type { VideoElement } from "@/timeline";
import { hasMatteSource, SMART_CUTOUT_ENABLED_KEY } from "../matte/matte-registry";
import { restoreCutout } from "./service";

function cutoutClips({ editor }: { editor: EditorCore }): VideoElement[] {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return [];
	const found: VideoElement[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements) {
			if (element.type === "video" && element.params[SMART_CUTOUT_ENABLED_KEY] === true) found.push(element);
		}
	}
	return found;
}

/**
 * After a project opens, its clips with the smart cutout switched on get their mattes back from
 * IndexedDB (they are not in the project file). A clip whose trim changed since the run finds
 * nothing and shows the whole picture until the cutout is run again.
 */
export function SmartCutoutHost() {
	const editor = useEditor();

	useEffect(() => {
		const inFlight = new Set<string>();
		const restore = () => {
			for (const element of cutoutClips({ editor })) {
				const asset = editor.media.getAssets().find((candidate) => candidate.id === element.mediaId);
				const marker = `${element.id}:${String(element.trimStart)}:${String(element.trimEnd)}`;
				if (!asset || inFlight.has(marker) || hasMatteSource({ elementId: element.id, kind: "ai" })) continue;
				inFlight.add(marker);
				void restoreCutout({ element, asset });
			}
		};
		restore();
		return editor.timeline.subscribe(restore);
	}, [editor]);

	return null;
}
