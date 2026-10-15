"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	PencilEdit02Icon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import type {
	NormalizedCubicBezier,
	SelectedKeyframeRef,
} from "@/animation/types";
import type { SegmentShape } from "@/animation/segment-easing";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { registerCanceller } from "@/editor/cancel-interaction";
import { useEditor } from "@/editor/use-editor";
import { useKeyframeCurveMenuStore } from "@/timeline/keyframe-curve-menu-store";
import { resolveKeyframeTargets } from "@/timeline/playhead-keyframes";
import {
	getSegmentPairRefs,
	planSegmentEasing,
} from "@/timeline/segment-easing-plan";
import type { TimelineElement } from "@/timeline/types";
import { cn } from "@/utils/ui";
import { BezierGraph, BEZIER_GRAPH_MIN_HEIGHT } from "./graph-editor/bezier-graph";
import { CurveThumb } from "./graph-editor/curve-thumb";
import { savePreset, useCustomPresets } from "./graph-editor/custom-presets-store";
import {
	BUILTIN_PRESETS,
	PRESET_MATCH_TOLERANCE,
} from "./graph-editor/easing-presets";
import { useCurveSession } from "./graph-editor/use-curve-session";

interface CurveChoice {
	id: string;
	label: string;
	/** What the thumbnail draws. */
	thumb: NormalizedCubicBezier | "hold";
	/** What is written on the segment. */
	shape: SegmentShape;
}

function presetValue(id: string): NormalizedCubicBezier {
	const preset = BUILTIN_PRESETS.find((candidate) => candidate.id === id);
	if (!preset) throw new Error(`missing easing preset ${id}`);
	return preset.value;
}

const LINEAR: NormalizedCubicBezier = [0, 0, 1, 1];

/** The shapes of the menu, in CapCut's order: the plain ones first, then the characterful ones. */
const BUILTIN_CHOICES: CurveChoice[] = [
	{ id: "linear", label: "Linear", thumb: LINEAR, shape: "linear" },
	{ id: "ease-in", label: "Ease in", thumb: presetValue("ease-in"), shape: presetValue("ease-in") },
	{ id: "ease-out", label: "Ease out", thumb: presetValue("ease-out"), shape: presetValue("ease-out") },
	{ id: "ease-in-out", label: "In out", thumb: presetValue("ease-in-out"), shape: presetValue("ease-in-out") },
	{ id: "smooth", label: "Smooth", thumb: presetValue("smooth"), shape: presetValue("smooth") },
	{ id: "pop", label: "Pop", thumb: presetValue("pop"), shape: presetValue("pop") },
	{ id: "hold", label: "Hold", thumb: "hold", shape: "hold" },
];

function matches({ a, b }: { a: NormalizedCubicBezier; b: NormalizedCubicBezier }): boolean {
	return a.every((value, index) => Math.abs(value - b[index]) < PRESET_MATCH_TOLERANCE);
}

/** "transform.positionX" → "Position X". */
export function describeKeyframeTargets(keyframes: readonly SelectedKeyframeRef[]): string {
	const paths = [...new Set(keyframes.map((keyframe) => keyframe.propertyPath))];
	if (paths.length !== 1) return `${paths.length} properties`;
	const leaf = paths[0].split(".").pop() ?? paths[0];
	const words = leaf.replace(/([a-z])([A-Z])/g, "$1 $2");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The keyframe curve menu: a grid of curve shapes for the segment after the
 * keyframes it was opened on, and an inline graph for a custom curve. Drawn
 * once; any diamond opens it through `useKeyframeCurveMenuStore`.
 */
export function KeyframeCurveMenu() {
	const request = useKeyframeCurveMenuStore((state) => state.request);
	const close = useKeyframeCurveMenuStore((state) => state.close);
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const element =
		request && tracks
			? (resolveKeyframeTargets({
					tracks,
					selected: [{ trackId: request.trackId, elementId: request.elementId }],
				})[0]?.element ?? null)
			: null;

	useEffect(() => {
		if (request && !element) close();
	}, [request, element, close]);

	return (
		<Popover
			open={request !== null && element !== null}
			onOpenChange={(next) => {
				if (!next) close();
			}}
		>
			{request && (
				<PopoverAnchor asChild>
					<div
						aria-hidden
						className="pointer-events-none fixed size-px"
						style={{ left: request.x, top: request.y }}
					/>
				</PopoverAnchor>
			)}
			{request && element && (
				<CurveMenuContent
					key={`${request.x}:${request.y}:${request.keyframes.map((k) => k.keyframeId).join(",")}`}
					element={element}
					keyframes={request.keyframes}
					onDone={close}
				/>
			)}
		</Popover>
	);
}

function CurveMenuContent({
	element,
	keyframes,
	onDone,
}: {
	element: TimelineElement;
	keyframes: SelectedKeyframeRef[];
	onDone: () => void;
}) {
	const editor = useEditor();
	const [customOpen, setCustomOpen] = useState(false);
	const saved = useCustomPresets();
	// The pairs are fixed when the menu opens: the keys keep their ids while curves change.
	const [pairRefs] = useState(() => getSegmentPairRefs({ element, keyframes }));
	const session = useCurveSession({ selectedKeyframes: pairRefs });
	const { state, onCancelPreview } = session;

	useEffect(
		() =>
			registerCanceller({
				fn: () => {
					onCancelPreview();
					onDone();
				},
			}),
		[onCancelPreview, onDone],
	);
	useEffect(() => onCancelPreview, [onCancelPreview]);

	const activeId = (() => {
		if (state.status === "unavailable") {
			return state.reason === "selected-segment-is-hold" ? "hold" : null;
		}
		const all = [
			...BUILTIN_CHOICES.filter((choice) => choice.thumb !== "hold"),
			...saved.map((preset) => ({ id: preset.id, thumb: preset.value })),
		];
		return (
			all.find((choice) => choice.thumb !== "hold" && matches({ a: choice.thumb, b: state.cubicBezier }))
				?.id ?? "custom"
		);
	})();

	const apply = (shape: SegmentShape) => {
		const entries = planSegmentEasing({ element, keyframes, easing: shape });
		if (entries.length === 0) {
			toast.info("Add a second keyframe: a curve shapes the motion between two keyframes.");
			return;
		}
		onCancelPreview();
		editor.timeline.updateKeyframeCurves({ keyframes: entries });
		if (!customOpen) onDone();
	};

	return (
		<PopoverContent
			side="bottom"
			align="start"
			sideOffset={6}
			collisionPadding={12}
			onCloseAutoFocus={(event) => event.preventDefault()}
			className="w-72 overflow-hidden p-0"
		>
			<div className="flex items-baseline justify-between gap-2 px-3 pt-3 pb-2">
				<span className="text-sm font-medium">Curve</span>
				<span className="text-muted-foreground truncate text-xs">
					{describeKeyframeTargets(keyframes)}
				</span>
			</div>

			<div className="grid grid-cols-4 gap-1.5 px-3 pb-3">
				{BUILTIN_CHOICES.map((choice) => (
					<CurveTile
						key={choice.id}
						label={choice.label}
						thumb={choice.thumb}
						isActive={activeId === choice.id}
						onSelect={() => apply(choice.shape)}
					/>
				))}
				<CurveTile
					label="Custom"
					isActive={customOpen || activeId === "custom"}
					onSelect={() => setCustomOpen((open) => !open)}
					icon={<HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />}
				/>
			</div>

			{saved.length > 0 && (
				<div className="border-t px-3 pt-2 pb-3">
					<div className="text-muted-foreground pb-1.5 text-[11px]">Saved</div>
					<div className="grid grid-cols-4 gap-1.5">
						{saved.map((preset) => (
							<CurveTile
								key={preset.id}
								label={preset.label}
								thumb={preset.value}
								isActive={activeId === preset.id}
								onSelect={() => apply(preset.value)}
							/>
						))}
					</div>
				</div>
			)}

			{customOpen && (
				<div className="border-t px-3 pt-3 pb-3">
					{state.status === "ready" ? (
						<>
							{state.componentOptions.length > 1 && (
								<div className="bg-muted/40 mb-2 inline-flex rounded-md p-0.5">
									{state.componentOptions.map((component) => (
										<button
											key={component.key}
											type="button"
											onClick={() => session.onActiveComponentKeyChange(component.key)}
											className={cn(
												"cursor-pointer rounded-sm px-2 py-1 text-xs font-medium",
												state.activeComponentKey === component.key
													? "bg-background text-foreground shadow-xs"
													: "text-muted-foreground hover:text-foreground",
											)}
										>
											{component.label}
										</button>
									))}
								</div>
							)}
							<BezierGraph
								value={state.cubicBezier}
								onChange={session.onPreviewValue}
								onChangeEnd={session.onCommitValue}
								onCancel={onCancelPreview}
							/>
							<button
								type="button"
								onClick={() => {
									savePreset({ value: state.cubicBezier });
									toast.success("Curve saved.");
								}}
								className="text-muted-foreground hover:text-foreground mt-2 flex cursor-pointer items-center gap-1 text-xs"
							>
								<HugeiconsIcon icon={PlusSignIcon} className="size-3.5" />
								Save this curve
							</button>
						</>
					) : (
						<div
							style={{ minHeight: BEZIER_GRAPH_MIN_HEIGHT / 2 }}
							className="bg-muted/20 text-muted-foreground flex items-center justify-center rounded-sm border border-dashed px-3 text-center text-xs leading-relaxed"
						>
							{state.status === "unavailable" && state.reason === "selected-segment-is-hold"
								? "Hold has no curve. Pick another shape first, then drag its handles here."
								: state.message}
						</div>
					)}
				</div>
			)}
		</PopoverContent>
	);
}

function CurveTile({
	label,
	thumb,
	icon,
	isActive,
	onSelect,
}: {
	label: string;
	thumb?: NormalizedCubicBezier | "hold";
	icon?: React.ReactNode;
	isActive: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			title={label}
			className={cn(
				"group flex cursor-pointer flex-col items-center gap-1 rounded-md p-1 outline-none",
				"focus-visible:ring-ring/60 focus-visible:ring-2",
			)}
		>
			<span
				className={cn(
					"flex h-9 w-full items-center justify-center rounded-md border transition-colors",
					isActive
						? "border-primary bg-primary/10 text-primary"
						: "bg-foreground/5 text-foreground/70 group-hover:bg-foreground/10 group-hover:text-foreground border-transparent",
				)}
			>
				{thumb ? <CurveThumb value={thumb} width={44} height={26} /> : icon}
			</span>
			<span
				className={cn(
					"w-full truncate text-center text-[10px] leading-tight",
					isActive ? "text-primary" : "text-muted-foreground",
				)}
			>
				{label}
			</span>
		</button>
	);
}

