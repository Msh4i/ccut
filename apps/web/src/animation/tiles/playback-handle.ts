import type { TilePlaybackStore } from "./playback";

export interface VisibilityEntry {
	target: object;
	isIntersecting: boolean;
	intersectionRatio: number;
}

/**
 * Visible means some area is on screen. IntersectionObserver also reports
 * `isIntersecting` for a zero-area rect that only touches the root's edge, which
 * is where a collapsed section (`grid-rows-[0fr]`, overflow hidden) leaves its
 * first row of tiles: those must not animate or hold a slot.
 */
function isEntryVisible(entry: VisibilityEntry): boolean {
	return entry.isIntersecting && entry.intersectionRatio > 0;
}

/**
 * With only 0, going from "edge-adjacent" (intersecting, ratio 0) to really
 * visible crosses no threshold and is never reported; the second value makes
 * that step a report.
 */
const VISIBILITY_THRESHOLDS = [0, 0.01];

function isElement(node: object): node is Element {
	return typeof Element === "function" && node instanceof Element;
}

export interface VisibilityObserver {
	observe: (node: object) => void;
	unobserve: (node: object) => void;
	disconnect: () => void;
}

/** Null when the platform has no way to tell (no IntersectionObserver). */
export type CreateVisibilityObserver = (
	report: (entries: VisibilityEntry[]) => void,
) => VisibilityObserver | null;

/** Calls `onChange` with the current value at once and on every change; returns a stop function. */
export type WatchReducedMotion = (
	onChange: (reducedMotion: boolean) => void,
) => () => void;

export interface TilePlaybackHandle {
	store: TilePlaybackStore;
	/** A tile's node to watch for visibility. Returns the function that stops watching and forgets the tile. */
	observe: (args: { id: string; node: object }) => () => void;
	/** Starts watching (the panel mounted). Returns the function that stops everything. */
	connect: () => () => void;
}

/**
 * Viewport visibility through ancestors' clipping (the properties panel
 * scrolls; a collapsed section clips its content to nothing), so tiles that
 * cannot be seen do not animate.
 */
const createIntersectionObserver: CreateVisibilityObserver = (report) => {
	if (typeof IntersectionObserver !== "function") return null;
	const observer = new IntersectionObserver((entries) => report(entries), {
		threshold: VISIBILITY_THRESHOLDS,
	});
	return {
		observe: (node) => {
			if (isElement(node)) observer.observe(node);
		},
		unobserve: (node) => {
			if (isElement(node)) observer.unobserve(node);
		},
		disconnect: () => observer.disconnect(),
	};
};

export const watchPrefersReducedMotion: WatchReducedMotion = (onChange) => {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		onChange(false);
		return () => {};
	}
	const query = window.matchMedia("(prefers-reduced-motion: reduce)");
	const listener = () => onChange(query.matches);
	onChange(query.matches);
	query.addEventListener("change", listener);
	return () => query.removeEventListener("change", listener);
};

/**
 * Feeds one Animation tab's `TilePlaybackStore` from the outside world: which
 * tiles are visible and whether the OS asks for reduced motion. Tiles observe
 * their node as they mount (before the tab connects, since children's effects
 * run first); `connect` runs while the tab is mounted, and its stop function
 * leaves nothing watching and nothing visible.
 */
export function createTilePlaybackHandle({
	store,
	createObserver = createIntersectionObserver,
	watchReducedMotion = watchPrefersReducedMotion,
}: {
	store: TilePlaybackStore;
	createObserver?: CreateVisibilityObserver;
	watchReducedMotion?: WatchReducedMotion;
}): TilePlaybackHandle {
	const idsByNode = new Map<object, string>();
	let observer: VisibilityObserver | null = null;
	let isConnected = false;

	const report = (entries: VisibilityEntry[]) => {
		for (const entry of entries) {
			const id = idsByNode.get(entry.target);
			if (id !== undefined) {
				store.setVisible({ id, isVisible: isEntryVisible(entry) });
			}
		}
	};

	const watch = ({ id, node }: { id: string; node: object }) => {
		if (observer) {
			observer.observe(node);
		} else {
			store.setVisible({ id, isVisible: true });
		}
	};

	return {
		store,
		observe: ({ id, node }) => {
			idsByNode.set(node, id);
			if (isConnected) watch({ id, node });
			return () => {
				if (idsByNode.get(node) !== id) return;
				idsByNode.delete(node);
				observer?.unobserve(node);
				store.forget({ id });
			};
		},
		connect: () => {
			isConnected = true;
			observer = createObserver(report);
			for (const [node, id] of idsByNode) watch({ id, node });
			const stopWatchingMotion = watchReducedMotion((reducedMotion) =>
				store.setReducedMotion({ reducedMotion }),
			);
			return () => {
				isConnected = false;
				observer?.disconnect();
				observer = null;
				stopWatchingMotion();
				for (const id of idsByNode.values()) {
					store.setVisible({ id, isVisible: false });
				}
			};
		},
	};
}
