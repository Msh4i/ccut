import type { SceneTracks } from "@/timeline";
import type { AudioCapableElement } from "@/timeline/audio-state";
import type { SnapPoint } from "@/timeline/snapping";
import { getBeatTimelineTimes } from "./resolve";

// The four snap consumers rebuild their points on every pointer move; elements
// are immutable, so an unchanged clip reuses its points.
const pointsByElement = new WeakMap<
	AudioCapableElement,
	{ trackId: string; points: SnapPoint[] }
>();

function getElementBeatSnapPoints({
	element,
	trackId,
}: {
	element: AudioCapableElement;
	trackId: string;
}): SnapPoint[] {
	const cached = pointsByElement.get(element);
	if (cached?.trackId === trackId) {
		return cached.points;
	}
	const points = getBeatTimelineTimes({ element }).map(
		(time): SnapPoint => ({
			time,
			type: "beat",
			elementId: element.id,
			trackId,
		}),
	);
	pointsByElement.set(element, { trackId, points });
	return points;
}

export function getBeatSnapPoints({
	tracks,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	excludeElementIds?: Set<string>;
}): SnapPoint[] {
	const snapPoints: SnapPoint[] = [];
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];

	for (const track of orderedTracks) {
		for (const element of track.elements) {
			if (element.type !== "audio" && element.type !== "video") {
				continue;
			}
			if (excludeElementIds?.has(element.id)) {
				continue;
			}
			for (const point of getElementBeatSnapPoints({
				element,
				trackId: track.id,
			})) {
				snapPoints.push(point);
			}
		}
	}

	return snapPoints;
}
