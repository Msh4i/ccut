import { TILE_ANIMATION_CAP, TilePlaybackStore } from "./playback";
import {
	createTilePlaybackHandle,
	type CreateVisibilityObserver,
	type TilePlaybackHandle,
	type WatchReducedMotion,
} from "./playback-handle";

const ORDER_SEPARATOR = "\n";

/** The tile ids as one string: a stable effect dependency. Ids never hold a line break. */
export function tileOrderKey({ order }: { order: readonly string[] }): string {
	return order.join(ORDER_SEPARATOR);
}

export interface TabTilePlayback {
	handle: TilePlaybackHandle;
	/** Effect body: the tiles in document order (another element type has other tiles). */
	syncOrder: (args: { orderKey: string }) => void;
	/** Effect body: the tab is mounted. Returns the cleanup that stops all watching. */
	mount: () => () => void;
}

/**
 * Everything `useTilePlayback` does, without React, so it can be tested: one
 * store with the cap, its observers, the tile order, and mounting.
 */
export function createTabTilePlayback({
	cap = TILE_ANIMATION_CAP,
	createObserver,
	watchReducedMotion,
}: {
	cap?: number;
	createObserver?: CreateVisibilityObserver;
	watchReducedMotion?: WatchReducedMotion;
} = {}): TabTilePlayback {
	const handle = createTilePlaybackHandle({
		store: new TilePlaybackStore({ cap }),
		createObserver,
		watchReducedMotion,
	});
	return {
		handle,
		syncOrder: ({ orderKey }) =>
			handle.store.setOrder({
				order: orderKey === "" ? [] : orderKey.split(ORDER_SEPARATOR),
			}),
		mount: () => handle.connect(),
	};
}

/** What `isVisibleFocus` needs of an element (an HTMLElement has it). */
export interface FocusTarget {
	matches?: (selector: string) => boolean;
}

/**
 * Keyboard (or programmatic) focus, as `:focus-visible` tells it. A tile
 * focused by a mouse click must not keep looping after the pointer leaves.
 * An engine that does not know the selector counts every focus, so keyboard
 * users never lose it.
 */
export function isVisibleFocus({ target }: { target: FocusTarget }): boolean {
	if (typeof target.matches !== "function") return true;
	try {
		return target.matches(":focus-visible");
	} catch {
		return true;
	}
}

/** A tile's pointer and focus handlers. The None tile (no id) and a static render (no store) get no-ops. */
export function tileInteraction({
	store,
	id,
}: {
	store: TilePlaybackStore | undefined;
	id: string | null;
}): {
	onPointerEnter: () => void;
	onPointerLeave: () => void;
	onFocus: (event: { currentTarget: FocusTarget }) => void;
	onBlur: () => void;
} {
	if (!store || id === null) {
		const ignore = () => {};
		return { onPointerEnter: ignore, onPointerLeave: ignore, onFocus: ignore, onBlur: ignore };
	}
	return {
		onPointerEnter: () => store.setHovered({ id, isHovered: true }),
		onPointerLeave: () => store.setHovered({ id, isHovered: false }),
		onFocus: (event) => {
			if (isVisibleFocus({ target: event.currentTarget })) {
				store.setFocused({ id, isFocused: true });
			}
		},
		onBlur: () => store.setFocused({ id, isFocused: false }),
	};
}
