import { getBezierPoint } from "@/animation/bezier";
import type { NormalizedCubicBezier } from "@/animation/types";

const SEGMENTS = 24;

/**
 * A small picture of an easing curve: time to the right, value up. "hold" is
 * the step a held key makes (flat, then a jump at the end).
 */
export function CurveThumb({
	value,
	width = 40,
	height = 22,
	paddingX = 4,
	paddingY = 3,
	strokeWidth = 1.5,
}: {
	value: NormalizedCubicBezier | "hold";
	width?: number;
	height?: number;
	paddingX?: number;
	paddingY?: number;
	strokeWidth?: number;
}) {
	const toX = (progress: number) => paddingX + progress * (width - paddingX * 2);
	const toY = (progress: number) =>
		paddingY + (1 - progress) * (height - paddingY * 2);
	const points: string[] = [];
	if (value === "hold") {
		points.push(`${toX(0)},${toY(0)}`, `${toX(1)},${toY(0)}`, `${toX(1)},${toY(1)}`);
	} else {
		for (let i = 0; i <= SEGMENTS; i++) {
			const progress = i / SEGMENTS;
			const x = getBezierPoint({ progress, p0: 0, p1: value[0], p2: value[2], p3: 1 });
			const y = getBezierPoint({ progress, p0: 0, p1: value[1], p2: value[3], p3: 1 });
			points.push(`${toX(x)},${toY(y)}`);
		}
	}
	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
			<path
				d={`M${points.join("L")}`}
				fill="none"
				className="stroke-current"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
