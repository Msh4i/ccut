"use client";

import { useMcpState } from "./use-mcp-state";
import type { McpColor } from "./glow-state";

const DOT: Record<McpColor, string> = { orange: "#ff8a1f", blue: "#2f7bff", violet: "#8b5cf6" };

/** A small badge in the top bar: who is connected, each in their colour. Nothing when nobody is. */
export function McpBadge() {
	const { state } = useMcpState();
	if (!state || state.clients.length === 0) return null;
	const label = state.clients.map((client) => `${client.name} (${client.level === "edit" ? "read and edit" : "read only"})`).join(", ");
	return (
		<div role="status" title={`Connected: ${label}`} aria-label={`Connected agents: ${label}`} className="text-muted-foreground flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs">
			<span className="flex -space-x-1">
				{state.clients.map((client) => (
					<span key={client.id} className="size-2.5 rounded-full border border-background" style={{ background: DOT[client.color] }} />
				))}
			</span>
			<span>{state.clients.length === 1 ? state.clients[0].name : `${state.clients.length} agents`}</span>
		</div>
	);
}
