/**
 * Which agents glow the window's edges. An agent glows while one of its tool calls runs and for
 * `LINGER_MS` after the last one ends. Pure: the component feeds it events and a clock.
 */
export const LINGER_MS = 2000;

export type McpColor = "orange" | "blue" | "violet";

export interface McpActivityEvent {
	clientId: string;
	name?: string;
	color?: string;
	running: boolean;
}

export interface GlowEntry {
	clientId: string;
	color: McpColor;
	/** Running calls now. */
	running: number;
	/** Time (ms) the glow ends if nothing runs; irrelevant while `running` > 0. */
	until: number;
}

export type GlowState = Record<string, GlowEntry>;

const isColor = (value: unknown): value is McpColor => value === "orange" || value === "blue" || value === "violet";

export function applyActivity({
	state,
	event,
	now,
}: {
	state: GlowState;
	event: McpActivityEvent;
	now: number;
}): GlowState {
	const previous = state[event.clientId];
	const running = Math.max(0, (previous?.running ?? 0) + (event.running ? 1 : -1));
	return {
		...state,
		[event.clientId]: {
			clientId: event.clientId,
			color: isColor(event.color) ? event.color : (previous?.color ?? "violet"),
			running,
			until: event.running ? now : now + LINGER_MS,
		},
	};
}

/** The glows to draw at `now`, in the order the agents started, and the state with the finished ones dropped. */
export function activeGlows({ state, now }: { state: GlowState; now: number }): {
	glows: Array<{ clientId: string; color: McpColor }>;
	state: GlowState;
	nextExpiry: number | null;
} {
	const kept: GlowState = {};
	let nextExpiry: number | null = null;
	for (const [id, entry] of Object.entries(state)) {
		if (entry.running > 0) {
			kept[id] = entry;
		} else if (entry.until > now) {
			kept[id] = entry;
			nextExpiry = nextExpiry === null ? entry.until : Math.min(nextExpiry, entry.until);
		}
	}
	return {
		glows: Object.values(kept).map(({ clientId, color }) => ({ clientId, color })),
		state: kept,
		nextExpiry,
	};
}

/**
 * Which edges each glow takes. One agent: all four. Two: the first top and bottom, the second left
 * and right. More: the edges are shared round-robin, so every colour shows.
 */
export type Edge = "top" | "right" | "bottom" | "left";
export function edgesFor({ index, count }: { index: number; count: number }): Edge[] {
	if (count <= 1) return ["top", "right", "bottom", "left"];
	if (count === 2) return index === 0 ? ["top", "bottom"] : ["left", "right"];
	const all: Edge[] = ["top", "right", "bottom", "left"];
	return [all[index % 4]];
}
