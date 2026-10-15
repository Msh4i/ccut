import { TICKS_PER_SECOND } from "@/wasm";
import type { AnyBaseNode } from "../renderer/nodes/base-node";
import { VideoNode } from "../renderer/nodes/video-node";
import { type UpcomingClip, planPreroll } from "./preroll-plan";

export type SceneVideoClip = UpcomingClip & { file: File; end: number };

/** Every video clip of the scene tree that has an element id (its stream's owner key), in seconds. */
export function videoClipsOf({ root }: { root: AnyBaseNode }): SceneVideoClip[] {
	const found: SceneVideoClip[] = [];
	const visit = (node: AnyBaseNode) => {
		if (node instanceof VideoNode && node.params.elementId) {
			const start = node.params.timeOffset / TICKS_PER_SECOND;
			found.push({
				key: node.params.elementId,
				mediaId: node.params.mediaId,
				file: node.params.file,
				start,
				end: start + node.params.duration / TICKS_PER_SECOND,
				sourceStart: node.params.trimStart / TICKS_PER_SECOND,
			});
		}
		for (const child of node.children) visit(child);
	};
	visit(root);
	return found;
}

/**
 * What to pre-roll for the playhead at `timeSeconds`: the clips about to start (while playing the
 * next few boundaries, at rest only the next one) and the clips on the playhead now (kept).
 */
export function prerollRequestFor({
	clips,
	timeSeconds,
	playing,
}: {
	clips: readonly SceneVideoClip[];
	timeSeconds: number;
	playing: boolean;
}) {
	const upcoming = planPreroll({ clips, time: timeSeconds, ...(playing ? {} : { maxClips: 1 }) });
	const files = new Map(clips.map((clip) => [clip.key, clip.file]));
	return {
		clips: upcoming.flatMap((clip) => {
			const file = files.get(clip.key);
			return file ? [{ mediaId: clip.mediaId, file, key: clip.key, time: clip.sourceStart }] : [];
		}),
		keep: clips.filter((clip) => clip.start <= timeSeconds && timeSeconds < clip.end).map((clip) => clip.key),
	};
}
