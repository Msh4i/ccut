import type { FeatureTracks } from "@/tracking/camera/types";
import { unpackSolve, unpackTracks } from "../codec";
import type { CameraSolve, CameraTrackerData, PackedSolve, PackedTracks } from "../types";

/** The packed arrays of one stored record, decoded. */
export interface DecodedParts {
	tracks: FeatureTracks | null;
	solve: CameraSolve | null;
	deleted: ReadonlySet<number>;
}

/**
 * Decoding is done once per stored packed object, whoever asks (load
 * validation, the engine, the renderer): the editor's state is immutable, so
 * a part that did not change is the same object (an edit of the settings
 * keeps the packed tracks and solve) and a changed one is a new object (a
 * command wrote it). Load validation fills this in, so the first look at a
 * clip after opening a project costs nothing.
 */
const tracksCache = new WeakMap<PackedTracks, FeatureTracks | null>();
const solveCache = new WeakMap<PackedSolve, CameraSolve | null>();
const deletedCache = new WeakMap<number[], ReadonlySet<number>>();

/** `unpackTracks`, decoded once per stored object. */
export function decodedTracks(packed: PackedTracks): FeatureTracks | null {
	if (!packed || typeof packed !== "object") return null;
	const cached = tracksCache.get(packed);
	if (cached !== undefined) return cached;
	const tracks = unpackTracks(packed);
	tracksCache.set(packed, tracks);
	return tracks;
}

/** `unpackSolve`, decoded once per stored object. */
export function decodedSolve(packed: PackedSolve): CameraSolve | null {
	if (!packed || typeof packed !== "object") return null;
	const cached = solveCache.get(packed);
	if (cached !== undefined) return cached;
	const solve = unpackSolve(packed);
	solveCache.set(packed, solve);
	return solve;
}

function deletedSet(ids: number[]): ReadonlySet<number> {
	if (!Array.isArray(ids)) return new Set();
	const cached = deletedCache.get(ids);
	if (cached) return cached;
	const deleted = new Set(ids);
	deletedCache.set(ids, deleted);
	return deleted;
}

export function rememberDecodedParts({
	data,
	parts,
}: {
	data: CameraTrackerData;
	parts: DecodedParts;
}): void {
	tracksCache.set(data.tracks, parts.tracks);
	if (data.solve) solveCache.set(data.solve, parts.solve);
	deletedCache.set(data.deletedTrackIds, parts.deleted);
}

export function decodedParts({ data }: { data: CameraTrackerData }): DecodedParts {
	return {
		tracks: decodedTracks(data.tracks),
		solve: data.solve ? decodedSolve(data.solve) : null,
		deleted: deletedSet(data.deletedTrackIds),
	};
}
