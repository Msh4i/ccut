"use client";

import { useEffect } from "react";
import type { EditorCore } from "@/core";
import type { VideoElement } from "@/timeline";
import { useEditor } from "@/editor/use-editor";
import { decoderPrewarmer } from "@/services/video-cache/decoder-prewarm";
import { videoCache } from "@/services/video-cache/service";
import { mediaTimeToSeconds } from "@/wasm";

/**
 * Warms the video decoder for every video asset the project uses (at project open and whenever a
 * video is added to the timeline) and gives `PlaybackManager` its start gate: after Space the
 * clock starts when the first decoded frames at the playhead are there (never later than the
 * cap in playback-start.ts), so the playhead does not freeze and then race.
 */
function videoElementsOf({ editor }: { editor: EditorCore }): VideoElement[] {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return [];
	const found: VideoElement[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements) {
			if (element.type === "video") found.push(element);
		}
	}
	return found;
}

export function PlaybackWarmupHost() {
	const editor = useEditor();

	useEffect(() => {
		const warmUsed = () => {
			const assets = new Map(editor.media.getAssets().map((asset) => [asset.id, asset]));
			for (const element of videoElementsOf({ editor })) {
				const asset = assets.get(element.mediaId);
				if (asset?.file) void decoderPrewarmer.request({ assetId: asset.id, file: asset.file });
			}
		};
		warmUsed();
		return editor.timeline.subscribe(warmUsed);
	}, [editor]);

	useEffect(() => {
		editor.playback.setStartGate(async () => {
			const time = mediaTimeToSeconds({ time: editor.playback.getCurrentTime() });
			const assets = new Map(editor.media.getAssets().map((asset) => [asset.id, asset]));
			const lease = videoCache.beginRender();
			try {
				await Promise.all(
					videoElementsOf({ editor }).flatMap((element) => {
						const asset = assets.get(element.mediaId);
						const start = mediaTimeToSeconds({ time: element.startTime });
						const end = start + mediaTimeToSeconds({ time: element.duration });
						if (!asset?.file || time < start || time >= end) return [];
						return [
							videoCache.getFrameAt({
								mediaId: asset.id,
								file: asset.file,
								time: mediaTimeToSeconds({ time: element.trimStart }) + (time - start),
								streamKey: element.id,
								lease,
							}),
						];
					}),
				);
			} finally {
				videoCache.endRender({ lease });
			}
		});
		return () => editor.playback.setStartGate(null);
	}, [editor]);

	return null;
}
