import type { CameraAnalysis, FeatureTracks } from "../types";

/**
 * A `CameraAnalysis` with a known shape and byte size, for the cache and the
 * controller tests (no real tracks: nothing here is solved).
 */
export function fakeTracks({
	frameCount,
	fps = 30,
	trackCount = 0,
	floats = 0,
}: {
	frameCount: number;
	fps?: number;
	trackCount?: number;
	floats?: number;
}): FeatureTracks {
	return {
		w: 480,
		h: 270,
		frameCount,
		fps,
		trackStart: new Int32Array(trackCount),
		trackLen: new Int32Array(trackCount),
		trackOffset: new Int32Array(trackCount),
		xy: new Float32Array(floats),
		liveOffsets: new Int32Array(frameCount + 1),
		liveIds: new Int32Array(0),
		cuts: [],
		stats: { lostFraction: new Float32Array(frameCount), cutNcc: [] },
	};
}

/** The bytes `fakeTracks` holds in its typed arrays. */
export function fakeTracksBytes({
	frameCount,
	trackCount = 0,
	floats = 0,
}: {
	frameCount: number;
	trackCount?: number;
	floats?: number;
}): number {
	return 4 * 3 * trackCount + 4 * floats + 4 * (frameCount + 1) + 4 * frameCount;
}

export function fakeAnalysis({
	id = "analysis-1",
	hostElementId = "host-1",
	mediaId = "media-1",
	sourceStart = 0,
	rate0 = 1,
	fps = 30,
	frameCount = 30,
	trackCount = 0,
	floats = 0,
	status = "complete",
}: {
	id?: string;
	hostElementId?: string;
	mediaId?: string;
	sourceStart?: number;
	rate0?: number;
	fps?: number;
	frameCount?: number;
	trackCount?: number;
	floats?: number;
	status?: CameraAnalysis["status"];
} = {}): CameraAnalysis {
	return {
		id,
		hostElementId,
		mediaId,
		sourceStart,
		rate0,
		tracks: fakeTracks({ frameCount, fps, trackCount, floats }),
		status,
	};
}
