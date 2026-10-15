/**
 * Messages between the main thread and a decode worker
 * (docs/ccut/playback-p5-design.md section 4).
 *
 * A "stream" is one `FrameStream` of the cache: the worker opens the file for
 * it (its own mediabunny Input) and runs one decoder ("iterator") at a time on
 * it. A decoded frame stays in the worker, as a sample, until the main thread
 * closes it; only its metadata crosses over until the main thread asks for a
 * picture (`render`).
 *
 * Every message a side receives is shape-checked (`parseToWorker`,
 * `parseFromWorker`): anything else is dropped, never trusted.
 */

/** An ImageBitmap on the wire (a structural view: tests use plain objects). */
export type WireBitmap = { readonly width: number; readonly height: number };

/** A VideoFrame on the wire. */
export type WireVideoFrame = object;

/**
 * The picture of a frame: a bitmap of the requested scale (the preview while it
 * plays) or, at full size, a VideoFrame the main thread draws with the code it
 * always used.
 */
export type WireImage =
	| { readonly kind: "bitmap"; readonly bitmap: WireBitmap }
	| { readonly kind: "frame"; readonly frame: WireVideoFrame };

export type ToWorkerMessage =
	| { type: "open"; streamId: number; file: object }
	| { type: "iterate"; streamId: number; iteratorId: number; startTime: number }
	| { type: "pull"; iteratorId: number }
	| { type: "render"; requestId: number; frameId: number; scale: number }
	| { type: "close"; frameId: number }
	| { type: "return"; iteratorId: number }
	| { type: "dispose"; streamId: number };

export type FrameBytesWire = { decoded: number; drawn: number };

/** The track's rotation in degrees, clockwise (mediabunny's `Rotation`). */
export type WireRotation = 0 | 90 | 180 | 270;

/** What an `error` message answers: an `open` (id = stream), a `pull` (id = iterator) or a `render` (id = request). */
export type ErrorTarget = "open" | "pull" | "render";

export type FromWorkerMessage =
	| {
			type: "opened";
			streamId: number;
			displaySize: { width: number; height: number };
			frameBytes: FrameBytesWire;
			/** What a VideoFrame lacks: the main thread draws it with this rotation. */
			rotation: WireRotation;
	  }
	| {
			type: "frame";
			iteratorId: number;
			frameId: number;
			timestamp: number;
			duration: number;
	  }
	| { type: "done"; iteratorId: number }
	| { type: "rendered"; requestId: number; image: WireImage }
	| { type: "error"; target: ErrorTarget; id: number; message: string }
	| { type: "disposed"; streamId: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
	return isFiniteNumber(value) && value > 0;
}

function isSize(value: unknown): value is { width: number; height: number } {
	return isRecord(value) && isPositiveFinite(value.width) && isPositiveFinite(value.height);
}

function isRotation(value: unknown): value is WireRotation {
	return value === 0 || value === 90 || value === 180 || value === 270;
}

function isFrameBytes(value: unknown): value is FrameBytesWire {
	return isRecord(value) && isPositiveFinite(value.decoded) && isPositiveFinite(value.drawn);
}

export function parseToWorker(value: unknown): ToWorkerMessage | null {
	if (!isRecord(value)) return null;
	switch (value.type) {
		case "open":
			return isId(value.streamId) && isRecord(value.file)
				? { type: "open", streamId: value.streamId, file: value.file }
				: null;
		case "iterate":
			return isId(value.streamId) && isId(value.iteratorId) && isFiniteNumber(value.startTime)
				? {
						type: "iterate",
						streamId: value.streamId,
						iteratorId: value.iteratorId,
						startTime: value.startTime,
					}
				: null;
		case "pull":
			return isId(value.iteratorId) ? { type: "pull", iteratorId: value.iteratorId } : null;
		case "render":
			return isId(value.requestId) && isId(value.frameId) && isPositiveFinite(value.scale)
				? {
						type: "render",
						requestId: value.requestId,
						frameId: value.frameId,
						scale: value.scale,
					}
				: null;
		case "close":
			return isId(value.frameId) ? { type: "close", frameId: value.frameId } : null;
		case "return":
			return isId(value.iteratorId) ? { type: "return", iteratorId: value.iteratorId } : null;
		case "dispose":
			return isId(value.streamId) ? { type: "dispose", streamId: value.streamId } : null;
		default:
			return null;
	}
}

function isWireBitmap(value: unknown): value is WireBitmap {
	return isRecord(value) && isPositiveFinite(value.width) && isPositiveFinite(value.height);
}

function parseImage(value: unknown): WireImage | null {
	if (!isRecord(value)) return null;
	if (value.kind === "bitmap") {
		const bitmap = value.bitmap;
		return isWireBitmap(bitmap) ? { kind: "bitmap", bitmap } : null;
	}
	if (value.kind === "frame") {
		return isRecord(value.frame) ? { kind: "frame", frame: value.frame } : null;
	}
	return null;
}

export function parseFromWorker(value: unknown): FromWorkerMessage | null {
	if (!isRecord(value)) return null;
	switch (value.type) {
		case "opened":
			return isId(value.streamId) &&
				isSize(value.displaySize) &&
				isFrameBytes(value.frameBytes) &&
				isRotation(value.rotation)
				? {
						type: "opened",
						streamId: value.streamId,
						displaySize: value.displaySize,
						frameBytes: value.frameBytes,
						rotation: value.rotation,
					}
				: null;
		case "frame":
			return isId(value.iteratorId) &&
				isId(value.frameId) &&
				isFiniteNumber(value.timestamp) &&
				isFiniteNumber(value.duration) &&
				value.duration >= 0
				? {
						type: "frame",
						iteratorId: value.iteratorId,
						frameId: value.frameId,
						timestamp: value.timestamp,
						duration: value.duration,
					}
				: null;
		case "done":
			return isId(value.iteratorId) ? { type: "done", iteratorId: value.iteratorId } : null;
		case "rendered": {
			const image = parseImage(value.image);
			return isId(value.requestId) && image
				? { type: "rendered", requestId: value.requestId, image }
				: null;
		}
		case "error":
			return (value.target === "open" || value.target === "pull" || value.target === "render") &&
				isId(value.id) &&
				typeof value.message === "string"
				? { type: "error", target: value.target, id: value.id, message: value.message }
				: null;
		case "disposed":
			return isId(value.streamId) ? { type: "disposed", streamId: value.streamId } : null;
		default:
			return null;
	}
}
