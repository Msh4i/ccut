import type { FeatureTracks } from "@/tracking/camera/types";
import type { CameraState, Quat, Vec3 } from "@/scene3d/types";
import type {
	CameraSolve,
	PackedArray,
	PackedSolve,
	PackedTracks,
	TrackPoint3D,
} from "./types";

/**
 * Packs the camera tracker's 2D tracks and solve into JSON-safe strings for
 * the project (base64 of little-endian typed arrays) and back. Unpacking
 * treats its input as untrusted: any inconsistency gives `null`, never an
 * exception or an out-of-range read.
 */

/** The largest packed value of a quantised coordinate (Int16). */
const INT16_LIMIT = 32767;

/**
 * Hard limits on stored sizes. They are the one set of numbers behind the
 * codec, the load check (`CAMERA_TRACKER_LOAD_LIMITS`) and the engine, so
 * whatever the engine writes loads again. They also bound one clip's record,
 * which every autosave rewrites, to about 28 MB in base64: 16 MB of samples
 * (an Int16 pair each), 3 MB of track table, 8 MB of solved points, 1 MB of
 * cameras.
 */
export const CODEC_LIMITS = {
	/**
	 * Frames only: about 11 minutes at the analysis rate of 30 fps. The
	 * `samples` limit usually binds first: with roughly 300 live features per
	 * frame (Normal) it is reached after about 6 minutes at 30 fps, with
	 * Detailed Analysis (about twice the features) after about 3. Rough
	 * figures from one scratch measurement.
	 */
	frameCount: 20_000,
	trackCount: 300_000,
	samples: 3_000_000,
	/** The solver writes at most one point per track. */
	points: 300_000,
	frameSize: 16_384,
} as const;

const BASE64_CHUNK = 0x8000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
	}
	return btoa(binary);
}

/** Bytes of a base64 string, or `null` when it is not valid base64. */
export function decodeBase64(text: string): Uint8Array | null {
	if (typeof text !== "string" || text.length % 4 !== 0) return null;
	if (!BASE64_PATTERN.test(text)) return null;
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

type Kind = "f32" | "i32" | "i16" | "u8";

const BYTES: Record<Kind, number> = { f32: 4, i32: 4, i16: 2, u8: 1 };

function pack({ values, kind }: { values: ArrayLike<number>; kind: Kind }): PackedArray {
	const size = BYTES[kind];
	const bytes = new Uint8Array(values.length * size);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < values.length; i++) {
		const offset = i * size;
		if (kind === "f32") view.setFloat32(offset, values[i], true);
		else if (kind === "i32") view.setInt32(offset, values[i], true);
		else if (kind === "i16") view.setInt16(offset, values[i], true);
		else view.setUint8(offset, values[i]);
	}
	return encodeBase64(bytes);
}

function unpackView({
	packed,
	kind,
	length,
}: {
	packed: PackedArray;
	kind: Kind;
	length: number;
}): DataView | null {
	if (!Number.isInteger(length) || length < 0) return null;
	const bytes = decodeBase64(packed);
	if (!bytes || bytes.length !== length * BYTES[kind]) return null;
	return new DataView(bytes.buffer);
}

export function packFloat32(values: ArrayLike<number>): PackedArray {
	return pack({ values, kind: "f32" });
}

export function unpackFloat32({
	packed,
	length,
}: {
	packed: PackedArray;
	length: number;
}): Float32Array | null {
	const view = unpackView({ packed, kind: "f32", length });
	if (!view) return null;
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) out[i] = view.getFloat32(i * 4, true);
	return out;
}

export function packInt32(values: ArrayLike<number>): PackedArray {
	return pack({ values, kind: "i32" });
}

export function unpackInt32({
	packed,
	length,
}: {
	packed: PackedArray;
	length: number;
}): Int32Array | null {
	const view = unpackView({ packed, kind: "i32", length });
	if (!view) return null;
	const out = new Int32Array(length);
	for (let i = 0; i < length; i++) out[i] = view.getInt32(i * 4, true);
	return out;
}

function unpackInt16({ packed, length }: { packed: PackedArray; length: number }): Int16Array | null {
	const view = unpackView({ packed, kind: "i16", length });
	if (!view) return null;
	const out = new Int16Array(length);
	for (let i = 0; i < length; i++) out[i] = view.getInt16(i * 2, true);
	return out;
}

function unpackUint8({ packed, length }: { packed: PackedArray; length: number }): Uint8Array | null {
	const view = unpackView({ packed, kind: "u8", length });
	if (!view) return null;
	return new Uint8Array(view.buffer.slice(0));
}

/** The largest power of two `q` (<= 64) with `(size + 1) * q` inside Int16. */
export function quantizationFor(size: number): number {
	let q = 64;
	while (q > 1 && (size + 1) * q > INT16_LIMIT) q /= 2;
	return q;
}

function isCount({ value, max }: { value: unknown; max: number }): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function isFinitePositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function packTracks(tracks: FeatureTracks): PackedTracks {
	const trackCount = tracks.trackStart.length;
	const quantization = quantizationFor(Math.max(tracks.w, tracks.h));
	let samples = 0;
	for (let i = 0; i < trackCount; i++) samples += tracks.trackLen[i];
	const xy = new Int16Array(samples * 2);
	let k = 0;
	for (let i = 0; i < trackCount; i++) {
		const offset = tracks.trackOffset[i];
		for (let j = 0; j < tracks.trackLen[i] * 2; j++) {
			const value = Math.round(tracks.xy[offset + j] * quantization);
			xy[k++] = Math.max(-INT16_LIMIT, Math.min(INT16_LIMIT, value));
		}
	}
	return {
		width: tracks.w,
		height: tracks.h,
		frameCount: tracks.frameCount,
		fps: tracks.fps,
		quantization,
		trackCount,
		trackStart: packInt32(tracks.trackStart),
		trackLen: packInt32(tracks.trackLen),
		xy: pack({ values: xy, kind: "i16" }),
		cuts: [...tracks.cuts],
	};
}

/**
 * Tracks back from storage, with the live lists rebuilt. `stats` are not
 * stored: `lostFraction` comes back as zeros and `cutNcc` empty.
 */
export function unpackTracks(packed: PackedTracks): FeatureTracks | null {
	if (!packed || typeof packed !== "object") return null;
	const { width, height, frameCount, trackCount, fps, quantization } = packed;
	if (!isCount({ value: width, max: CODEC_LIMITS.frameSize }) || width < 1) return null;
	if (!isCount({ value: height, max: CODEC_LIMITS.frameSize }) || height < 1) return null;
	if (!isCount({ value: frameCount, max: CODEC_LIMITS.frameCount })) return null;
	if (!isCount({ value: trackCount, max: CODEC_LIMITS.trackCount })) return null;
	if (!isFinitePositive(fps) || fps > 1000) return null;
	if (!isCount({ value: quantization, max: 1024 }) || quantization < 1) return null;
	if (!Array.isArray(packed.cuts)) return null;
	const cuts: number[] = [];
	for (const cut of packed.cuts) {
		if (!isCount({ value: cut, max: frameCount })) return null;
		if (cuts.length > 0 && cut <= cuts[cuts.length - 1]) return null;
		cuts.push(cut);
	}
	const trackStart = unpackInt32({ packed: packed.trackStart, length: trackCount });
	const trackLen = unpackInt32({ packed: packed.trackLen, length: trackCount });
	if (!trackStart || !trackLen) return null;
	let samples = 0;
	const liveCounts = new Int32Array(frameCount);
	for (let i = 0; i < trackCount; i++) {
		const start = trackStart[i];
		const length = trackLen[i];
		if (start < 0 || length < 1 || start + length > frameCount) return null;
		samples += length;
		if (samples > CODEC_LIMITS.samples) return null;
		for (let f = start; f < start + length; f++) liveCounts[f]++;
	}
	const quantized = unpackInt16({ packed: packed.xy, length: samples * 2 });
	if (!quantized) return null;
	const xy = new Float32Array(samples * 2);
	for (let i = 0; i < xy.length; i++) xy[i] = quantized[i] / quantization;
	const trackOffset = new Int32Array(trackCount);
	let offset = 0;
	for (let i = 0; i < trackCount; i++) {
		trackOffset[i] = offset;
		offset += trackLen[i] * 2;
	}
	const liveOffsets = new Int32Array(frameCount + 1);
	for (let f = 0; f < frameCount; f++) liveOffsets[f + 1] = liveOffsets[f] + liveCounts[f];
	const liveIds = new Int32Array(liveOffsets[frameCount]);
	const cursor = liveOffsets.slice(0, frameCount);
	for (let i = 0; i < trackCount; i++) {
		for (let f = trackStart[i]; f < trackStart[i] + trackLen[i]; f++) liveIds[cursor[f]++] = i;
	}
	return {
		w: width,
		h: height,
		frameCount,
		fps,
		trackStart,
		trackLen,
		trackOffset,
		xy,
		liveOffsets,
		liveIds,
		cuts,
		stats: { lostFraction: new Float32Array(frameCount), cutNcc: [] },
	};
}

const CAMERA_FLOATS = 8;
const POINT_FLOATS = 4;

export function packSolve(solve: CameraSolve): PackedSolve {
	const cameras = new Float32Array(solve.cameras.length * CAMERA_FLOATS);
	solve.cameras.forEach((camera, i) => {
		cameras.set(
			[...camera.rotation, ...camera.position, camera.focalPx],
			i * CAMERA_FLOATS,
		);
	});
	const points = new Float32Array(solve.points.length * POINT_FLOATS);
	solve.points.forEach((point, i) => {
		points.set([...point.position, point.error], i * POINT_FLOATS);
	});
	return {
		frameWidth: solve.frameWidth,
		frameHeight: solve.frameHeight,
		frameCount: solve.cameras.length,
		cameras: packFloat32(cameras),
		solved: pack({ values: solve.solved, kind: "u8" }),
		pointIds: packInt32(solve.points.map((point) => point.trackId)),
		points: packFloat32(points),
		methodUsed: solve.methodUsed,
		averageError: solve.averageError,
		notices: solve.notices.map((notice) => ({ ...notice })),
	};
}

const METHODS = new Set(["typical", "mostly-flat", "tripod-pan"]);

function isNotice(notice: unknown): boolean {
	if (!notice || typeof notice !== "object" || !("kind" in notice)) return false;
	switch (notice.kind) {
		case "tripod-no-depth":
			return true;
		case "unsolved-frames":
			return "count" in notice && isCount({ value: notice.count, max: CODEC_LIMITS.frameCount });
		case "cut":
			return "frame" in notice && isCount({ value: notice.frame, max: CODEC_LIMITS.frameCount });
		case "high-error":
			return (
				"averageError" in notice &&
				typeof notice.averageError === "number" &&
				Number.isFinite(notice.averageError)
			);
		default:
			return false;
	}
}

/** A solve back from storage; `null` when anything is inconsistent or non-finite. */
export function unpackSolve(packed: PackedSolve): CameraSolve | null {
	if (!packed || typeof packed !== "object") return null;
	const { frameWidth, frameHeight, frameCount, averageError } = packed;
	if (!isFinitePositive(frameWidth) || frameWidth > CODEC_LIMITS.frameSize) return null;
	if (!isFinitePositive(frameHeight) || frameHeight > CODEC_LIMITS.frameSize) return null;
	if (!isCount({ value: frameCount, max: CODEC_LIMITS.frameCount }) || frameCount < 1) return null;
	if (typeof averageError !== "number" || !Number.isFinite(averageError) || averageError < 0) return null;
	if (!METHODS.has(packed.methodUsed)) return null;
	if (!Array.isArray(packed.notices)) return null;
	if (!packed.notices.every(isNotice)) return null;
	const cameraFloats = unpackFloat32({ packed: packed.cameras, length: frameCount * CAMERA_FLOATS });
	const solved = unpackUint8({ packed: packed.solved, length: frameCount });
	if (!cameraFloats || !solved) return null;
	for (let i = 0; i < cameraFloats.length; i++) {
		if (!Number.isFinite(cameraFloats[i])) return null;
	}
	const cameras: CameraState[] = [];
	for (let f = 0; f < frameCount; f++) {
		const o = f * CAMERA_FLOATS;
		const rotation: Quat = [cameraFloats[o], cameraFloats[o + 1], cameraFloats[o + 2], cameraFloats[o + 3]];
		const norm = Math.hypot(...rotation);
		if (!(norm > 0.5 && norm < 1.5)) return null;
		const focalPx = cameraFloats[o + 7];
		if (!(focalPx > 0)) return null;
		cameras.push({
			rotation: [rotation[0] / norm, rotation[1] / norm, rotation[2] / norm, rotation[3] / norm],
			position: [cameraFloats[o + 4], cameraFloats[o + 5], cameraFloats[o + 6]],
			focalPx,
		});
	}
	const pointIdsBytes = decodeBase64(packed.pointIds);
	if (!pointIdsBytes || pointIdsBytes.length % 4 !== 0) return null;
	const pointCount = pointIdsBytes.length / 4;
	if (pointCount > CODEC_LIMITS.points) return null;
	const pointIds = unpackInt32({ packed: packed.pointIds, length: pointCount });
	const pointFloats = unpackFloat32({ packed: packed.points, length: pointCount * POINT_FLOATS });
	if (!pointIds || !pointFloats) return null;
	const points: TrackPoint3D[] = [];
	for (let i = 0; i < pointCount; i++) {
		const o = i * POINT_FLOATS;
		const position: Vec3 = [pointFloats[o], pointFloats[o + 1], pointFloats[o + 2]];
		const error = pointFloats[o + 3];
		if (!position.every(Number.isFinite) || !Number.isFinite(error) || error < 0 || pointIds[i] < 0) return null;
		points.push({ trackId: pointIds[i], position, error });
	}
	return {
		frameWidth,
		frameHeight,
		cameras,
		solved,
		points,
		methodUsed: packed.methodUsed,
		averageError,
		notices: packed.notices.map((notice) => ({ ...notice })),
	};
}
