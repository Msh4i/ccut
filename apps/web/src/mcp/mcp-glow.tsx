"use client";

import { useEffect, useRef, useState } from "react";
import { activeGlows, applyActivity, edgesFor, type Edge, type GlowState, type McpColor } from "./glow-state";
import { getMcpBridge } from "./bridge";

const COLORS: Record<McpColor, string> = {
	orange: "255, 138, 31",
	blue: "47, 123, 255",
	violet: "139, 92, 246",
};

const EDGE_STYLE: Record<Edge, { position: React.CSSProperties; direction: string }> = {
	top: { position: { top: 0, left: 0, right: 0, height: 56 }, direction: "to bottom" },
	bottom: { position: { bottom: 0, left: 0, right: 0, height: 56 }, direction: "to top" },
	left: { position: { top: 0, bottom: 0, left: 0, width: 56 }, direction: "to right" },
	right: { position: { top: 0, bottom: 0, right: 0, width: 56 }, direction: "to left" },
};

// A slow breathing glow; a static border when the system asks for less motion.
const CSS = `
@keyframes ccut-mcp-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.95; } }
.ccut-mcp-glow { animation: ccut-mcp-breathe 2.6s ease-in-out infinite; will-change: opacity; }
@media (prefers-reduced-motion: reduce) { .ccut-mcp-glow { animation: none; opacity: 0.75; } }
`;

/** The soft glow along the inside edges of the window while an agent works (and 2 s after). */
export function McpGlowView({ glows }: { glows: Array<{ clientId: string; color: McpColor }> }) {
	if (glows.length === 0) return null;
	return (
		<div aria-hidden="true" data-testid="mcp-glow" className="pointer-events-none fixed inset-0 z-[70]">
			<style>{CSS}</style>
			{glows.flatMap((glow, index) =>
				edgesFor({ index, count: glows.length }).map((edge) => (
					<div
						key={`${glow.clientId}:${edge}`}
						data-edge={edge}
						data-color={glow.color}
						className="ccut-mcp-glow absolute"
						style={{
							...EDGE_STYLE[edge].position,
							background: `linear-gradient(${EDGE_STYLE[edge].direction}, rgba(${COLORS[glow.color]}, 0.55), rgba(${COLORS[glow.color]}, 0))`,
						}}
					/>
				)),
			)}
		</div>
	);
}

export function McpGlow() {
	const [entries, setEntries] = useState<GlowState>({});
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const bridge = getMcpBridge();
		if (!bridge) return;
		const schedule = (state: GlowState) => {
			if (timer.current) clearTimeout(timer.current);
			const { nextExpiry } = activeGlows({ state, now: Date.now() });
			if (nextExpiry !== null) {
				timer.current = setTimeout(() => {
					setEntries((current) => activeGlows({ state: current, now: Date.now() }).state);
				}, Math.max(0, nextExpiry - Date.now()) + 20);
			}
		};
		const stop = bridge.onActivity((event) => {
			setEntries((current) => {
				const next = activeGlows({ state: applyActivity({ state: current, event, now: Date.now() }), now: Date.now() }).state;
				schedule(next);
				return next;
			});
		});
		return () => {
			stop();
			if (timer.current) clearTimeout(timer.current);
		};
	}, []);

	return <McpGlowView glows={Object.values(entries).map(({ clientId, color }) => ({ clientId, color }))} />;
}
