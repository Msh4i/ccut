/** At most this many tiles animate on their own at once (hovered/focused ones always do). */
export const TILE_ANIMATION_CAP = 4;

/** Where a tile that is not animating is shown: half way, which still hints at the motion. */
export const TILE_STILL_PROGRESS = 0.5;

/**
 * - `loop`: plays its phase again and again, with a pause at rest.
 * - `once`: plays its phase one time (reduced motion, on hover or focus).
 * - `still`: shows the frame at `TILE_STILL_PROGRESS`.
 */
export type TilePlayback = "loop" | "once" | "still";

function readCap(cap: number): number {
	return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
}

/**
 * How every tile in `order` (document order) plays. The hovered tile always
 * animates; the focused one too while it is visible (a focused tile that was
 * scrolled away, or whose panel is hidden, stops). The remaining slots up to
 * `cap` go to visible tiles in document order. With reduced motion nothing
 * plays on its own: hovering or focusing a tile is an explicit request, so
 * that tile plays once.
 */
export function planTilePlayback({
	order,
	visible,
	hovered,
	focused,
	reducedMotion,
	cap,
}: {
	order: readonly string[];
	visible: ReadonlySet<string>;
	hovered: string | null;
	focused: string | null;
	reducedMotion: boolean;
	cap: number;
}): Map<string, TilePlayback> {
	const animating = new Set<string>();
	for (const id of order) {
		if (id === hovered || (id === focused && visible.has(id))) {
			animating.add(id);
		}
	}
	const limit = reducedMotion ? 0 : readCap(cap);
	for (const id of order) {
		if (animating.size >= limit) break;
		if (visible.has(id)) animating.add(id);
	}

	const plan = new Map<string, TilePlayback>();
	for (const id of order) {
		if (!animating.has(id)) {
			plan.set(id, "still");
		} else {
			plan.set(id, reducedMotion ? "once" : "loop");
		}
	}
	return plan;
}

function isSamePlan({
	previous,
	next,
}: {
	previous: Map<string, TilePlayback>;
	next: Map<string, TilePlayback>;
}): boolean {
	if (previous.size !== next.size) return false;
	for (const [id, playback] of next) {
		if (previous.get(id) !== playback) return false;
	}
	return true;
}

/**
 * The live inputs of `planTilePlayback` for one Animation tab, and the plan
 * they give. Tiles read their own entry (`getPlayback`) and are told when the
 * plan changes; nothing else in the panel re-renders.
 */
export class TilePlaybackStore {
	private readonly cap: number;
	private order: readonly string[] = [];
	private readonly visible = new Set<string>();
	private hovered: string | null = null;
	private focused: string | null = null;
	private reducedMotion = false;
	/** The user paused every tile (WCAG 2.2.2): nothing loops on its own, hover and focus play once. */
	private paused = false;
	private plan = new Map<string, TilePlayback>();
	private readonly listeners = new Set<() => void>();

	constructor({ cap }: { cap: number }) {
		this.cap = cap;
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	readonly getPlayback = (id: string): TilePlayback =>
		this.plan.get(id) ?? "still";

	setOrder({ order }: { order: readonly string[] }): void {
		this.order = [...order];
		this.update();
	}

	setVisible({ id, isVisible }: { id: string; isVisible: boolean }): void {
		if (isVisible) {
			this.visible.add(id);
		} else {
			this.visible.delete(id);
		}
		this.update();
	}

	setHovered({ id, isHovered }: { id: string; isHovered: boolean }): void {
		if (isHovered) {
			this.hovered = id;
		} else if (this.hovered === id) {
			this.hovered = null;
		}
		this.update();
	}

	setFocused({ id, isFocused }: { id: string; isFocused: boolean }): void {
		if (isFocused) {
			this.focused = id;
		} else if (this.focused === id) {
			this.focused = null;
		}
		this.update();
	}

	setReducedMotion({ reducedMotion }: { reducedMotion: boolean }): void {
		this.reducedMotion = reducedMotion;
		this.update();
	}

	readonly getPaused = (): boolean => this.paused;

	/** Pauses (or resumes) the tiles' own looping; a hovered or focused tile still plays once. */
	setPaused({ paused }: { paused: boolean }): void {
		if (this.paused === paused) return;
		this.paused = paused;
		this.update();
		// A button that shows the state must hear the change even when no tile changes (all already still).
		this.notify();
	}

	/** A tile that unmounts: it is no longer hovered, focused or visible. */
	forget({ id }: { id: string }): void {
		this.visible.delete(id);
		if (this.hovered === id) this.hovered = null;
		if (this.focused === id) this.focused = null;
		this.update();
	}

	private update(): void {
		const next = planTilePlayback({
			order: this.order,
			visible: this.visible,
			hovered: this.hovered,
			focused: this.focused,
			reducedMotion: this.reducedMotion || this.paused,
			cap: this.cap,
		});
		if (isSamePlan({ previous: this.plan, next })) return;
		this.plan = next;
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
