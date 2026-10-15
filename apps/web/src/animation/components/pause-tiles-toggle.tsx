"use client";

import { useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { Toggle } from "@/components/ui/toggle";
import type { TilePlaybackHandle } from "@/animation/tiles/playback-handle";

/**
 * Pauses every tile that animates on its own (WCAG 2.2.2: moving content that
 * starts by itself needs a way to stop it). A hovered or focused tile still
 * plays once. The state lasts as long as the Animation tab is mounted.
 */
export function PauseTilesToggle({ playback }: { playback: TilePlaybackHandle }) {
	const paused = useSyncExternalStore(
		playback.store.subscribe,
		playback.store.getPaused,
		() => false,
	);
	return (
		<Toggle
			size="sm"
			variant="outline"
			className="self-start"
			pressed={paused}
			onPressedChange={(next) => playback.store.setPaused({ paused: next })}
			aria-label="Pause tile animations"
		>
			<HugeiconsIcon icon={paused ? PlayIcon : PauseIcon} />
			{paused ? "Play tile animations" : "Pause tile animations"}
		</Toggle>
	);
}
