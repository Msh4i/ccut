/**
 * The smart cutout model. ONE constant: to switch to another model file (for instance if the
 * licence of this one cannot be confirmed) change this object and `MODELS` in
 * apps/electron/models-ipc.js (same id, sha256 and size).
 * U²-Net-P: github.com/danielgatis/rembg release v0.0.0 `u2netp.onnx`.
 */
export const SMART_CUTOUT_MODEL = {
	id: "u2netp",
	label: "U²-Net-P",
	sizeBytes: 4_574_861,
	sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
	/** Square input side the model takes. */
	inputSize: 320,
} as const;

/** Clips with more frames than this get a matte on every 2nd frame (the rest is interpolated). */
export const LONG_CLIP_FRAMES = 450;
/** Weight of the current frame in the temporal smoothing. */
export const SMOOTHING_ALPHA = 0.6;
/** Mean absolute luma difference (0..1) between two analysed frames that counts as a scene cut. */
export const SCENE_CUT_THRESHOLD = 0.25;
/** Most matte bytes ONE clip may take (a wider stride keeps a long clip under it). */
export const MAX_MATTE_MEMORY_BYTES = 256 * 1024 * 1024;
/** Most matte bytes all clips together keep in memory; older clips are dropped from memory (their data stays on disk). */
export const MAX_TOTAL_MATTE_BYTES = 512 * 1024 * 1024;
/** Most model runs for one clip: a longer clip gets a wider stride. */
export const MAX_ANALYSED_FRAMES = 20_000;
/** Runs kept in IndexedDB; the least recently used are deleted beyond this. */
export const MAX_STORED_RUNS = 12;
/** A frame rate or size outside these is a damaged or hostile file, not a video. */
export const LIMITS = { maxFps: 1000, maxFrames: 10_000_000, maxSide: 4096, maxStride: 100_000 } as const;
