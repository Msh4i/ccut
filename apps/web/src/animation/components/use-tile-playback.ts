import { useEffect, useState, useSyncExternalStore } from "react";
import type { TilePlayback } from "@/animation/tiles/playback";
import type { TilePlaybackHandle } from "@/animation/tiles/playback-handle";
import {
	createTabTilePlayback,
	tileOrderKey,
} from "@/animation/tiles/tab-playback";

/**
 * The playback store of one Animation tab: which of its tiles animate. It
 * lives as long as the tab is mounted; unmounting it (another tab, another
 * selection type, the panel closing) disconnects the observers. The logic is
 * in `createTabTilePlayback`; this only ties it to the tab's lifetime.
 */
export function useTilePlayback({
	order,
}: {
	/** Tile ids in document order. */
	order: readonly string[];
}): TilePlaybackHandle {
	const [tab] = useState(() => createTabTilePlayback());
	const orderKey = tileOrderKey({ order });

	useEffect(() => tab.syncOrder({ orderKey }), [tab, orderKey]);
	useEffect(() => tab.mount(), [tab]);

	return tab.handle;
}

const subscribeNone = () => () => {};
const stillOnServer = (): TilePlayback => "still";

/** How one tile plays; "still" without a store (a static render) or without an id (the None tile). */
export function useTileMode({
	playback,
	id,
}: {
	playback: TilePlaybackHandle | undefined;
	id: string | null;
}): TilePlayback {
	return useSyncExternalStore(
		playback ? playback.store.subscribe : subscribeNone,
		() => (playback && id !== null ? playback.store.getPlayback(id) : "still"),
		stillOnServer,
	);
}
