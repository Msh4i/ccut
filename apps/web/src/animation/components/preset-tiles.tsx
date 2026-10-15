"use client";

import { ImageOff } from "lucide-react";
import Image from "next/image";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
	buildChosenAnimation,
	getPresetDefinition,
	getPresetsForElementType,
	type PresetAnimationId,
	type PresetAnimations,
	type PresetDefinition,
	type PresetPhase,
} from "@/animation/presets";
import {
	startTileEffect,
	tileDrawingAt,
	type TileDrawing,
} from "@/animation/tiles/animator";
import { TILE_PICTURE_SIZE, type TileContent } from "@/animation/tiles/content";
import {
	REST_FRAME,
	TILE_CANVAS,
	getTileBox,
	tileFrameStyle,
	type TileBox,
} from "@/animation/tiles/frame";
import { TILE_STILL_PROGRESS } from "@/animation/tiles/playback";
import type { TilePlaybackHandle } from "@/animation/tiles/playback-handle";
import { tileInteraction } from "@/animation/tiles/tab-playback";
import { getTileTicker } from "@/animation/tiles/ticker";
import type { ElementType } from "@/timeline/types";
import { cn } from "@/utils/ui";
import { mediaTimeToSeconds } from "@/wasm";
import { useTileMode } from "./use-tile-playback";

/** Text size relative to the tile's width, so a few characters fill the text box at any panel width. */
const TEXT_FONT_SIZE = "10cqw";

export function getTileId({
	phase,
	presetId,
}: {
	phase: PresetPhase;
	presetId: PresetAnimationId;
}): string {
	return `${phase}:${presetId}`;
}

function percentOf({ part, whole }: { part: number; whole: number }): string {
	return `${Number(((part / whole) * 100).toFixed(3))}%`;
}

/**
 * The presets of one phase as tiles: "None" first, then one tile per preset
 * the element supports. Each tile previews its preset on the element's own
 * content; clicking one calls `onChoose` exactly like the old text buttons.
 */
export function PresetTileGrid({
	title,
	phase,
	elementType,
	content,
	presetAnimations,
	duration,
	playback,
	onChoose,
}: {
	title: string;
	phase: PresetPhase;
	elementType: ElementType;
	content: TileContent;
	presetAnimations: PresetAnimations | undefined;
	/** The clip's length in ticks: a tile plays over the length a click would give it. */
	duration: number;
	/** Undefined in a static render: every tile then shows its still frame. */
	playback: TilePlaybackHandle | undefined;
	onChoose: (definition: PresetDefinition | undefined) => void;
}) {
	const presets = getPresetsForElementType({ elementType });
	const animation = presetAnimations?.[phase];
	const selected = animation ? getPresetDefinition(animation.id) : undefined;
	const box = getTileBox(
		content.kind === "text"
			? { kind: "text" }
			: { kind: "picture", aspect: content.aspect },
	);

	return (
		<div className="@container">
			<div
				role="group"
				aria-label={`${title} animation`}
				className="grid grid-cols-2 gap-x-1.5 gap-y-2 @[14rem]:grid-cols-3 @[24rem]:grid-cols-4"
			>
				<PresetTile
					id={null}
					label="None"
					definition={undefined}
					phase={phase}
					content={content}
					box={box}
					isSelected={!selected}
					previewMs={0}
					playback={playback}
					onSelect={() => onChoose(undefined)}
				/>
				{presets.map((definition) => (
					<PresetTile
						key={definition.id}
						id={getTileId({ phase, presetId: definition.id })}
						label={
							phase === "out"
								? (definition.outLabel ?? definition.label)
								: definition.label
						}
						definition={definition}
						phase={phase}
						content={content}
						box={box}
						isSelected={selected?.id === definition.id}
						previewMs={
							mediaTimeToSeconds({
								time: buildChosenAnimation({
									presetAnimations,
									phase,
									definition,
									duration,
								}).duration,
							}) * 1000
						}
						playback={playback}
						onSelect={() => onChoose(definition)}
					/>
				))}
			</div>
		</div>
	);
}

function PresetTile({
	id,
	label,
	definition,
	phase,
	content,
	box,
	isSelected,
	previewMs,
	playback,
	onSelect,
}: {
	/** Null for the None tile, which never animates. */
	id: string | null;
	label: string;
	definition: PresetDefinition | undefined;
	phase: PresetPhase;
	content: TileContent;
	box: TileBox;
	isSelected: boolean;
	previewMs: number;
	playback: TilePlaybackHandle | undefined;
	onSelect: () => void;
}) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const moverRef = useRef<HTMLSpanElement>(null);
	const shownRef = useRef<HTMLSpanElement>(null);
	const hiddenRef = useRef<HTMLSpanElement>(null);
	const drawnRef = useRef<TileDrawing | null>(null);
	const playMsRef = useRef(previewMs);
	const mode = useTileMode({ playback, id });

	const tile = { ...TILE_CANVAS, box };
	const text = content.kind === "text" ? content.text : null;
	const still: TileDrawing = definition
		? tileDrawingAt({ definition, phase, progress: TILE_STILL_PROGRESS, tile, text })
		: {
				style: tileFrameStyle({ frame: REST_FRAME, tile }),
				text: text === null ? null : { shown: text, hidden: "" },
			};

	// What React drew in this commit: a stopping animation puts the tile back
	// to it. Layout effects run before the passive cleanup that reads it. The
	// play length is read per frame, so dragging the Duration slider rescales
	// a running tile instead of restarting it.
	useLayoutEffect(() => {
		drawnRef.current = still;
		playMsRef.current = previewMs;
	});

	useEffect(() => {
		const node = buttonRef.current;
		if (!playback || id === null || !node) return;
		return playback.observe({ id, node });
	}, [playback, id]);

	const { width: boxWidth, height: boxHeight } = box;
	// Frames are written straight to the DOM: an animating tile costs no React
	// render, and nothing else in the panel re-renders.
	useEffect(() => {
		const mover = moverRef.current;
		return startTileEffect({
			nodes: mover
				? { mover, shown: shownRef.current, hidden: hiddenRef.current }
				: null,
			ticker: getTileTicker(),
			definition,
			mode,
			phase,
			getPlayMs: () => playMsRef.current,
			tile: { ...TILE_CANVAS, box: { width: boxWidth, height: boxHeight } },
			text,
			getDrawn: () => drawnRef.current,
		});
	}, [definition, phase, mode, boxWidth, boxHeight, text]);

	const handlers = tileInteraction({ store: playback?.store, id });

	return (
		<button
			ref={buttonRef}
			type="button"
			aria-pressed={isSelected}
			title={label}
			onClick={onSelect}
			onPointerEnter={handlers.onPointerEnter}
			onPointerLeave={handlers.onPointerLeave}
			onFocus={handlers.onFocus}
			onBlur={handlers.onBlur}
			className="group/tile flex min-w-0 cursor-pointer flex-col gap-1 rounded-sm text-left outline-hidden"
		>
			<span
				aria-hidden="true"
				className={cn(
					"@container relative grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-sm border transition-colors",
					content.kind === "text" && content.needsLightBackdrop
						? "bg-[hsl(0_0%_78%)]"
						: "bg-[hsl(0_0%_4%)]",
					isSelected
						? "border-primary ring-1 ring-primary"
						: "border-border group-hover/tile:border-muted-foreground/60",
					"group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-ring",
				)}
			>
				<span
					ref={moverRef}
					className="grid min-w-0 place-items-center"
					style={{
						width: percentOf({ part: box.width, whole: TILE_CANVAS.width }),
						height: percentOf({ part: box.height, whole: TILE_CANVAS.height }),
						transform: still.style.transform,
						opacity: still.style.opacity,
					}}
				>
					{content.kind === "text" && still.text ? (
						<span
							className="block max-w-full overflow-hidden text-ellipsis whitespace-pre leading-tight"
							style={{
								fontFamily: content.fontFamily,
								fontWeight: content.fontWeight,
								fontStyle: content.fontStyle,
								color: content.color,
								fontSize: TEXT_FONT_SIZE,
							}}
						>
							<span ref={shownRef}>{still.text.shown}</span>
							<span ref={hiddenRef} className="invisible">
								{still.text.hidden}
							</span>
						</span>
					) : (
						<TilePicture src={content.kind === "picture" ? content.src : null} />
					)}
				</span>
			</span>
			<span
				className={cn(
					"truncate px-0.5 text-[0.7rem] leading-tight",
					isSelected
						? "text-secondary-foreground"
						: "text-muted-foreground group-hover/tile:text-foreground",
				)}
			>
				{label}
			</span>
		</button>
	);
}

/** A clip's poster frame, or a placeholder box when it has none. */
function TilePicture({ src }: { src: string | null }) {
	if (!src) {
		return (
			<span className="grid size-full place-items-center rounded-[2px] border border-dashed border-muted-foreground/50 text-muted-foreground">
				<ImageOff className="size-1/2 max-h-6 max-w-6" />
			</span>
		);
	}
	return (
		<Image
			src={src}
			alt=""
			width={TILE_PICTURE_SIZE}
			height={TILE_PICTURE_SIZE}
			unoptimized
			draggable={false}
			className="size-full object-contain"
		/>
	);
}
