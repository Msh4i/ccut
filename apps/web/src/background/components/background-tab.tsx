"use client";

import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ColorPickerIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { BrushSection } from "@/background/components/brush-section";
import { SmartCutoutSection } from "@/background/components/smart-cutout-section";
import { ElementParamFields } from "@/components/editor/panels/properties/components/element-params-tab";
import { CHROMA_KEY_PARAM_KEYS } from "@/background/chroma-key";
import { CHROMA_KEY_PARAM_LIST } from "@/params/registry";
import { useEditor } from "@/editor/use-editor";
import { hasKeyframesForPath } from "@/animation";
import type { TimelineElement } from "@/timeline";
import { subMediaTime } from "@/wasm";

type EyeDropperResult = { sRGBHex: string };
type EyeDropperApi = new () => { open: () => Promise<EyeDropperResult> };

function getEyeDropper(): EyeDropperApi | null {
	// Reflect.get answers any: the API is a browser extra the DOM types do not list.
	const candidate = Reflect.get(window, "EyeDropper");
	return typeof candidate === "function" ? candidate : null;
}

const CHROMA_FIELD_KEYS = CHROMA_KEY_PARAM_LIST.filter(
	(key) => key !== CHROMA_KEY_PARAM_KEYS.enabled,
);

/**
 * Background removal, one section per way: the colour key (green screen), the
 * smart cutout (a model finds the subject) and the brush (paint it by hand).
 */
export function BackgroundTab({
	element,
	trackId,
}: {
	element: TimelineElement;
	trackId: string;
}) {
	return (
		<>
			<ChromaKeySection element={element} trackId={trackId} />
			{element.type === "video" ? (
				<SmartCutoutSection element={element} trackId={trackId} />
			) : null}
			{element.type === "video" || element.type === "image" ? (
				<BrushSection element={element} trackId={trackId} />
			) : null}
		</>
	);
}

function ChromaKeySection({
	element,
	trackId,
}: {
	element: TimelineElement;
	trackId: string;
}) {
	const editor = useEditor();
	const EyeDropper = getEyeDropper();
	const enabled = element.params?.[CHROMA_KEY_PARAM_KEYS.enabled] === true;

	const writeParams = (patch: Record<string, string | boolean>) =>
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: { params: { ...element.params, ...patch } },
				},
			],
		});

	const pick = async () => {
		if (!EyeDropper) return;
		let hex: string;
		try {
			hex = (await new EyeDropper().open()).sRGBHex;
		} catch {
			// Escape or a click away: nothing was picked.
			return;
		}
		const colorPath = CHROMA_KEY_PARAM_KEYS.color;
		if (hasKeyframesForPath({ animations: element.animations, propertyPath: colorPath })) {
			// The fixed colour is ignored while the colour has keys: key it here.
			const playhead = editor.playback.getCurrentTime();
			if (playhead < element.startTime || playhead > element.startTime + element.duration) {
				toast.info("Move the playhead onto the clip to change a keyed colour.");
				return;
			}
			editor.timeline.upsertKeyframes({
				keyframes: [
					{
						trackId,
						elementId: element.id,
						propertyPath: colorPath,
						time: subMediaTime({ a: playhead, b: element.startTime }),
						value: hex,
					},
				],
			});
			return;
		}
		writeParams({ [colorPath]: hex, [CHROMA_KEY_PARAM_KEYS.enabled]: true });
	};

	return (
		<Section sectionKey={`${element.id}:background-chroma`}>
			<SectionHeader
				trailing={
					<Switch
						aria-label="Chroma key"
						checked={enabled}
						onCheckedChange={(next) =>
							writeParams({ [CHROMA_KEY_PARAM_KEYS.enabled]: next })
						}
					/>
				}
			>
				<SectionTitle className="text-foreground">Chroma key</SectionTitle>
			</SectionHeader>
			<SectionContent>
				{enabled ? (
					<SectionFields>
						<Button
							variant="secondary"
							size="sm"
							className="w-full"
							disabled={!EyeDropper}
							title={
								EyeDropper
									? "Then click the background colour in the preview"
									: "This window cannot pick a colour from the screen"
							}
							onClick={() => void pick()}
						>
							<HugeiconsIcon icon={ColorPickerIcon} />
							Pick colour from preview
						</Button>
						<ElementParamFields
							element={element}
							trackId={trackId}
							paramKeys={CHROMA_FIELD_KEYS}
						/>
					</SectionFields>
				) : (
					<p className="text-muted-foreground text-xs leading-relaxed">
						Removes one colour, such as a green screen.
					</p>
				)}
			</SectionContent>
		</Section>
	);
}
