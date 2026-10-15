/**
 * Manual brush cutout. Strokes are stored on the element (`cutout`, optional: a project
 * without the field loads as before) in coordinates of the SOURCE picture (0..1 across its
 * width and height), so they follow the clip when it is moved, scaled or rotated.
 *
 * A keyframe holds the strokes that make the matte from its time on, until the next
 * keyframe ("hold"). The matte starts as "keep everything"; strokes are applied in order:
 * a "remove" stroke erases, a "keep" stroke brings the picture back.
 */
export type BrushMode = "keep" | "remove";

export type BrushPoint = { x: number; y: number };

export type BrushStroke = {
	mode: BrushMode;
	/** Brush radius as a share of the source width (0.002 .. 0.5). */
	radius: number;
	/** 0 = soft all the way in, 1 = full strength out to the radius. */
	hardness: number;
	/** Extra soft edge beyond the radius, as a share of the radius (0 .. 1). */
	feather: number;
	points: BrushPoint[];
};

export type CutoutKeyframe = {
	/** Clip-local time (media ticks) from which the strokes apply. */
	time: number;
	strokes: BrushStroke[];
};

export type ElementCutout = {
	/** Ascending by `time`, at most one per time. */
	keyframes: CutoutKeyframe[];
};

export const CUTOUT_LIMITS = {
	maxKeyframes: 200,
	maxStrokesPerKeyframe: 400,
	maxPointsPerStroke: 4000,
	minRadius: 0.002,
	maxRadius: 0.5,
} as const;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = ({ value, min, max }: { value: number; min: number; max: number }) => Math.min(max, Math.max(min, value));

function normalizeStroke({ value }: { value: unknown }): BrushStroke | null {
	if (typeof value !== "object" || value === null) return null;
	const mode = Reflect.get(value, "mode");
	const radius = Reflect.get(value, "radius");
	const hardness = Reflect.get(value, "hardness");
	const feather = Reflect.get(value, "feather");
	const points = Reflect.get(value, "points");
	if ((mode !== "keep" && mode !== "remove") || !finite(radius) || !finite(hardness) || !finite(feather)) return null;
	if (!Array.isArray(points) || points.length === 0) return null;
	const clean: BrushPoint[] = [];
	for (const point of points.slice(0, CUTOUT_LIMITS.maxPointsPerStroke)) {
		const x: unknown = typeof point === "object" && point !== null ? Reflect.get(point, "x") : undefined;
		const y: unknown = typeof point === "object" && point !== null ? Reflect.get(point, "y") : undefined;
		if (!finite(x) || !finite(y)) return null;
		clean.push({ x: clamp({ value: x, min: -0.5, max: 1.5 }), y: clamp({ value: y, min: -0.5, max: 1.5 }) });
	}
	return {
		mode,
		radius: clamp({ value: radius, min: CUTOUT_LIMITS.minRadius, max: CUTOUT_LIMITS.maxRadius }),
		hardness: clamp({ value: hardness, min: 0, max: 1 }),
		feather: clamp({ value: feather, min: 0, max: 1 }),
		points: clean,
	};
}

/**
 * Whatever came out of storage (or an agent), as a cutout the renderer can trust: bad strokes
 * and keyframes are dropped, sizes are capped. Null when nothing usable is left.
 */
export function normalizeCutout({ value }: { value: unknown }): ElementCutout | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = Reflect.get(value, "keyframes");
	if (!Array.isArray(raw)) return null;
	const byTime = new Map<number, CutoutKeyframe>();
	for (const entry of raw.slice(0, CUTOUT_LIMITS.maxKeyframes)) {
		if (typeof entry !== "object" || entry === null) continue;
		const time = Reflect.get(entry, "time");
		const strokes = Reflect.get(entry, "strokes");
		if (!finite(time) || !Array.isArray(strokes)) continue;
		const clean: BrushStroke[] = [];
		for (const stroke of strokes.slice(0, CUTOUT_LIMITS.maxStrokesPerKeyframe)) {
			const normalized = normalizeStroke({ value: stroke });
			if (normalized) clean.push(normalized);
		}
		byTime.set(Math.max(0, time), { time: Math.max(0, time), strokes: clean });
	}
	const keyframes = [...byTime.values()].sort((a, b) => a.time - b.time);
	return keyframes.length > 0 ? { keyframes } : null;
}
