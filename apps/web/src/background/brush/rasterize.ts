import type { BrushStroke } from "./types";

/** The raster size for a source: the longest side is `maxSide` pixels, the aspect is kept. */
export function rasterSize({
	sourceWidth,
	sourceHeight,
	maxSide = 512,
}: {
	sourceWidth: number;
	sourceHeight: number;
	maxSide?: number;
}): { width: number; height: number } {
	const scale = maxSide / Math.max(sourceWidth, sourceHeight);
	return {
		width: Math.max(1, Math.round(sourceWidth * scale)),
		height: Math.max(1, Math.round(sourceHeight * scale)),
	};
}

/** Brush strength at distance `d` (pixels): full inside radius * hardness, fading to 0 at radius * (1 + feather). */
export function brushStrength({
	distance,
	radius,
	hardness,
	feather,
}: {
	distance: number;
	radius: number;
	hardness: number;
	feather: number;
}): number {
	const inner = radius * hardness;
	const outer = Math.max(radius * (1 + feather), inner + 1e-6, radius);
	if (distance <= inner) return 1;
	if (distance >= outer) return 0;
	const t = (distance - inner) / (outer - inner);
	return 1 - t * t * (3 - 2 * t);
}

/** What one rasterisation may cost: pixel operations and brush stamps. Hostile or huge strokes stop here. */
export const RASTER_LIMITS = { maxPixelOps: 20_000_000, maxStamps: 20_000 } as const;

export type RasterResult = {
	data: Uint8Array;
	/** The limits were reached: the strokes after that point are not in the matte. */
	truncated: boolean;
};

/**
 * The matte (width x height bytes, 255 = keep) the strokes make, applied in order on a picture
 * that starts fully kept. Points are in source coordinates (0..1); the radius is a share of the
 * source WIDTH, so a round brush stays round on any aspect. Cost is bounded by `limits`
 * (a 4000-point stroke with a huge radius and feather would otherwise be ~10^10 pixel operations).
 */
export function rasterizeStrokesLimited({
	strokes,
	width,
	height,
	limits = RASTER_LIMITS,
}: {
	strokes: readonly BrushStroke[];
	width: number;
	height: number;
	limits?: { maxPixelOps: number; maxStamps: number };
}): RasterResult {
	const matte = new Uint8Array(width * height).fill(255);
	let ops = 0;
	let stamps = 0;
	let truncated = false;
	for (const stroke of strokes) {
		if (truncated) break;
		const radius = stroke.radius * width;
		const reach = radius * (1 + stroke.feather);
		const coverage = new Float32Array(width * height);
		let minX = width;
		let maxX = -1;
		let minY = height;
		let maxY = -1;
		const stamp = ({ cx, cy }: { cx: number; cy: number }): boolean => {
			const x0 = Math.max(0, Math.floor(cx - reach));
			const x1 = Math.min(width - 1, Math.ceil(cx + reach));
			const y0 = Math.max(0, Math.floor(cy - reach));
			const y1 = Math.min(height - 1, Math.ceil(cy + reach));
			const area = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
			if (stamps >= limits.maxStamps || ops + area > limits.maxPixelOps) {
				truncated = true;
				return false;
			}
			stamps += 1;
			ops += area;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const strength = brushStrength({
						distance: Math.hypot(x + 0.5 - cx, y + 0.5 - cy),
						radius,
						hardness: stroke.hardness,
						feather: stroke.feather,
					});
					const index = y * width + x;
					if (strength > (coverage[index] ?? 0)) coverage[index] = strength;
				}
			}
			minX = Math.min(minX, x0);
			maxX = Math.max(maxX, x1);
			minY = Math.min(minY, y0);
			maxY = Math.max(maxY, y1);
			return true;
		};
		// stamps closer than a quarter of the radius make a smooth line
		const spacing = Math.max(0.5, radius / 4);
		let previous: { x: number; y: number } | null = null;
		walk: for (const point of stroke.points) {
			const cx = point.x * width;
			const cy = point.y * height;
			if (previous) {
				const length = Math.hypot(cx - previous.x, cy - previous.y);
				const steps = Math.floor(length / spacing);
				for (let step = 1; step <= steps; step++) {
					const t = step / (steps + 1);
					if (!stamp({ cx: previous.x + (cx - previous.x) * t, cy: previous.y + (cy - previous.y) * t })) break walk;
				}
			}
			if (!stamp({ cx, cy })) break;
			previous = { x: cx, y: cy };
		}
		const mergeArea = Math.max(0, maxX - minX + 1) * Math.max(0, maxY - minY + 1);
		ops += mergeArea;
		for (let y = Math.max(0, minY); y <= Math.min(height - 1, maxY); y++) {
			for (let x = Math.max(0, minX); x <= Math.min(width - 1, maxX); x++) {
				const index = y * width + x;
				const strength = coverage[index] ?? 0;
				if (strength === 0) continue;
				const current = matte[index] ?? 0;
				matte[index] = Math.round(
					stroke.mode === "remove" ? current * (1 - strength) : current + (255 - current) * strength,
				);
			}
		}
	}
	return { data: matte, truncated };
}

export function rasterizeStrokes(input: {
	strokes: readonly BrushStroke[];
	width: number;
	height: number;
}): Uint8Array {
	return rasterizeStrokesLimited(input).data;
}
