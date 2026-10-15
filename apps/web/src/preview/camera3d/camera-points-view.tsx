import type { PointsDrawing } from "./points-drawing";

/** AE-like target colours: red and white rings. */
const RING_FILLS = ["#e5322d", "#ffffff", "#e5322d", "#ffffff"] as const;
const SELECTION_COLOR = "#3fa9f5";

function polygonPoints(points: ReadonlyArray<{ x: number; y: number }>): string {
	return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

/**
 * The track points layer over the preview (decorative for assistive tech:
 * the Tracking tab and the menu carry the meaning). Nothing here takes
 * pointer events.
 */
export function CameraPointsView({ drawing }: { drawing: PointsDrawing }) {
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 size-full overflow-visible"
		>
			{drawing.triangle ? (
				<polygon
					points={polygonPoints(drawing.triangle)}
					fill="#ffffff"
					fillOpacity={0.22}
					stroke="#ffffff"
					strokeOpacity={0.7}
					strokeWidth={1}
				/>
			) : null}
			{drawing.rings ? (
				<g data-target="">
					{drawing.rings.map((ring, index) => (
						<polygon
							key={RING_FILLS[index] + String(index)}
							points={polygonPoints(ring)}
							fill={RING_FILLS[index % RING_FILLS.length]}
							fillOpacity={0.78}
							stroke="#7a0d0a"
							strokeWidth={0.6}
						/>
					))}
				</g>
			) : null}
			{drawing.markers.map((marker) => {
				const half = marker.size / 2;
				const d = `M${marker.x - half} ${marker.y}H${marker.x + half}M${marker.x} ${marker.y - half}V${marker.y + half}`;
				const color = marker.selected ? "#ffffff" : `hsl(${marker.hue.toFixed(1)} 85% 62%)`;
				return (
					<g key={marker.trackId} opacity={marker.dim ? 0.45 : 1}>
						{marker.selected ? (
							<circle cx={marker.x} cy={marker.y} r={half + 2.5} fill="none" stroke="#ffffff" strokeWidth={1} opacity={0.85} />
						) : null}
						<path d={d} stroke="#000000" strokeOpacity={0.55} strokeWidth={3} strokeLinecap="round" />
						<path d={d} stroke={color} strokeWidth={marker.selected ? 1.8 : 1.4} strokeLinecap="round" />
					</g>
				);
			})}
			{drawing.marquee ? (
				<rect
					x={drawing.marquee.x}
					y={drawing.marquee.y}
					width={drawing.marquee.width}
					height={drawing.marquee.height}
					fill={SELECTION_COLOR}
					fillOpacity={0.08}
					stroke={SELECTION_COLOR}
					strokeDasharray="4 3"
				/>
			) : null}
			{drawing.lasso ? (
				<polygon
					points={polygonPoints(drawing.lasso)}
					fill={SELECTION_COLOR}
					fillOpacity={0.08}
					stroke={SELECTION_COLOR}
					strokeDasharray="4 3"
				/>
			) : null}
		</svg>
	);
}
