"use client";

import { useEffect, useRef, useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import {
	EFFECT_PREVIEW_LOOP_SECONDS,
	effectPreviewService,
} from "@/services/renderer/effect-preview";
import { useEditor } from "@/editor/use-editor";
import { buildEffectElement } from "@/timeline/element-utils";
import type { EffectDefinition } from "@/effects/types";

export function EffectsView() {
	const effects = effectsRegistry
		.getAll()
		.filter((definition) => definition.category !== "filter");

	return (
		<PanelView title="Effects">
			<EffectsGrid effects={effects} />
		</PanelView>
	);
}

export function FiltersView() {
	const filters = effectsRegistry
		.getAll()
		.filter((definition) => definition.category === "filter");

	return (
		<PanelView title="Filters">
			<EffectsGrid effects={filters} />
		</PanelView>
	);
}

function EffectsGrid({ effects }: { effects: EffectDefinition[] }) {
	return (
		<div
			className="grid gap-2"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
		>
			{effects.map((effect) => (
				<EffectItem key={effect.type} effect={effect} />
			))}
		</div>
	);
}

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
	);
}

/**
 * Shows the effect's still thumbnail; while hovered, plays it in a loop from
 * its start. Only the hovered tile animates, so the grid costs nothing at
 * rest.
 */
function EffectPreviewCanvas({ effectType }: { effectType: string }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const frameRef = useRef<number | null>(null);

	const renderAt = useCallback(
		(localTimeSeconds?: number) => {
			if (canvasRef.current) {
				effectPreviewService.renderPreview({
					effectType,
					params: {},
					targetCanvas: canvasRef.current,
					localTimeSeconds,
				});
			}
		},
		[effectType],
	);

	const stopLoop = useCallback(() => {
		if (frameRef.current !== null) {
			cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		}
	}, []);

	useEffect(() => {
		renderAt();
		const unsubscribe = effectPreviewService.onPreviewImageReady({
			callback: () => renderAt(),
		});
		return () => {
			stopLoop();
			unsubscribe();
		};
	}, [renderAt, stopLoop]);

	const startLoop = useCallback(() => {
		if (frameRef.current !== null || prefersReducedMotion()) return;
		const startedAt = performance.now();
		const tick = (now: number) => {
			// A frame's timestamp can predate the performance.now() above.
			const elapsedSeconds = Math.max(0, now - startedAt) / 1000;
			renderAt(elapsedSeconds % EFFECT_PREVIEW_LOOP_SECONDS);
			frameRef.current = requestAnimationFrame(tick);
		};
		frameRef.current = requestAnimationFrame(tick);
	}, [renderAt]);

	const stopAndShowStill = useCallback(() => {
		stopLoop();
		renderAt();
	}, [stopLoop, renderAt]);

	return (
		<canvas
			ref={canvasRef}
			className="size-full"
			onPointerEnter={startLoop}
			onPointerLeave={stopAndShowStill}
		/>
	);
}

function EffectItem({ effect }: { effect: EffectDefinition }) {
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		const element = buildEffectElement({
			effectType: effect.type,
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	}, [editor, effect.type]);

	const preview = <EffectPreviewCanvas effectType={effect.type} />;

	return (
		<DraggableItem
			name={effect.name}
			preview={preview}
			dragData={{
				id: effect.type,
				name: effect.name,
				type: "effect",
				effectType: effect.type,
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
