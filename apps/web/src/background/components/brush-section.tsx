"use client";

import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Delete02Icon,
	KeyframeAddIcon,
	KeyframeRemoveIcon,
	PaintBrush02Icon,
	Undo02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useBrushStore } from "@/background/brush/brush-store";
import { addMatteKeyframe, deleteMatteKeyframe, playheadInClip, undoLastStroke, writeCutout } from "@/background/brush/edit";
import { activeKeyframe } from "@/background/brush/keyframes";
import { useEditor } from "@/editor/use-editor";
import type { ImageElement, VideoElement } from "@/timeline";
import { cn } from "@/utils/ui";

const SEGMENT_ITEM =
	"h-7 min-w-0 flex-1 rounded-sm px-2 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs";

/**
 * "Brush cutout": paint "remove" and "keep" strokes on the preview to cut the picture out by hand.
 * On a video each matte keyframe holds its strokes until the next one (diamonds at the bottom of
 * the selected clip on the timeline).
 */
export function BrushSection({ element, trackId }: { element: VideoElement | ImageElement; trackId: string }) {
	const editor = useEditor();
	const brush = useBrushStore();
	const target = { trackId, element };
	const isVideo = element.type === "video";
	const time = playheadInClip({ editor, element });
	const strokes = element.cutout && time !== null ? (activeKeyframe({ cutout: element.cutout, time })?.strokes.length ?? 0) : 0;

	return (
		<Section sectionKey={`${element.id}:brush-cutout`}>
			<SectionHeader
				trailing={
					<Button
						variant={brush.active ? "secondary" : "ghost"}
						size="sm"
						aria-pressed={brush.active}
						className={cn(brush.active && "text-primary")}
						onClick={() => brush.set({ active: !brush.active })}
					>
						<HugeiconsIcon icon={PaintBrush02Icon} />
						{brush.active ? "Painting" : "Paint"}
					</Button>
				}
			>
				<SectionTitle className="text-foreground">Brush</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Paint on the preview to remove parts of the picture, or bring them back.
					</p>
					<ToggleGroup
						type="single"
						aria-label="Brush mode"
						value={brush.mode}
						onValueChange={(value) => (value === "keep" || value === "remove") && brush.set({ mode: value })}
						className="bg-foreground/5 gap-1 rounded-md p-1"
					>
						<ToggleGroupItem value="remove" className={SEGMENT_ITEM}>
							<span className="size-2 rounded-full bg-red-500" />
							Remove
						</ToggleGroupItem>
						<ToggleGroupItem value="keep" className={SEGMENT_ITEM}>
							<span className="size-2 rounded-full bg-green-500" />
							Keep
						</ToggleGroupItem>
					</ToggleGroup>
					<BrushSlider label="Size" value={brush.radius} min={0.005} max={0.25} onChange={(radius) => brush.set({ radius })} />
					<BrushSlider label="Hardness" value={brush.hardness} min={0} max={1} onChange={(hardness) => brush.set({ hardness })} />
					<BrushSlider label="Feather" value={brush.feather} min={0} max={1} onChange={(feather) => brush.set({ feather })} />
					<div className="flex items-center gap-1">
						<Button variant="ghost" size="sm" disabled={time === null || strokes === 0} onClick={() => time !== null && undoLastStroke({ editor, target, time })}>
							<HugeiconsIcon icon={Undo02Icon} />
							Undo stroke
						</Button>
						<Button variant="ghost" size="sm" disabled={!element.cutout} onClick={() => writeCutout({ editor, target, cutout: null })}>
							<HugeiconsIcon icon={Delete02Icon} />
							Clear
						</Button>
					</div>
					{isVideo ? (
						<div className="flex items-center justify-between gap-2 border-t pt-3">
							<span className="text-muted-foreground text-xs">Matte keyframe</span>
							<div className="flex items-center gap-1">
								<Button
									variant="ghost"
									size="icon"
									aria-label="Add matte keyframe at playhead"
									title="Add a matte keyframe here: later strokes change only from here on"
									disabled={time === null || !element.cutout}
									onClick={() => {
										if (time === null) return;
										const result = addMatteKeyframe({ editor, target, time });
										if (result && !result.ok) toast.error(result.reason);
									}}
								>
									<HugeiconsIcon icon={KeyframeAddIcon} />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									aria-label="Delete matte keyframe here"
									title="Delete the matte keyframe here"
									disabled={time === null || !element.cutout}
									onClick={() => time !== null && deleteMatteKeyframe({ editor, target, time })}
								>
									<HugeiconsIcon icon={KeyframeRemoveIcon} />
								</Button>
							</div>
						</div>
					) : null}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function BrushSlider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
	const percent = Math.round(((value - min) / (max - min)) * 100);
	return (
		<SectionField label={label}>
			<div className="flex items-center gap-3">
				<Slider
					aria-label={label}
					min={min}
					max={max}
					step={(max - min) / 100}
					value={[value]}
					onValueChange={([next]) => next !== undefined && onChange(next)}
				/>
				<span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">{percent}%</span>
			</div>
		</SectionField>
	);
}
