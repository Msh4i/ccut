import type { ReactNode } from "react";
import type {
	CameraElement,
	EffectElement,
	GraphicElement,
	ImageElement,
	MaskableElement,
	RetimableElement,
	StickerElement,
	TextElement,
	VisualElement,
	VideoElement,
	AudioElement,
	TimelineElement,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	TextFontIcon,
	ArrowExpandIcon,
	RainDropIcon,
	MusicNote03Icon,
	MagicWand05Icon,
	DashboardSpeed02Icon,
	Motion01Icon,
	KeyframeIcon,
	ColorPickerIcon,
	FocusPointIcon,
	ThreeDViewIcon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { ElementParamsTab } from "./components/element-params-tab";
import { ClipEffectsTab, StandaloneEffectTab } from "@/effects/components/effects-tab";
import { MasksTab } from "@/masks/components/masks-tab";
import { SpeedTab } from "@/speed/components/speed-tab";
import { GraphicTab } from "@/graphics/components/graphic-tab";
import { AnimationTab } from "@/animation/components/animation-tab";
import { BackgroundTab } from "@/background/components/background-tab";
import { KeyframePresetsTab } from "@/animation/components/keyframe-presets-tab";
import { OcShapesIcon } from "@/components/icons";
import { getElementParams } from "@/params/registry";
import { isLayer3D } from "@/scene3d/layer-params";
import { CameraTrackerTab } from "@/tracking/components/camera3d/camera-tracker-tab";
import {
	LAYER_3D_TAB_ID,
	arrangeLayerTabs,
	layer3DTabKeys,
} from "@/tracking/camera3d/ui/layer-tabs";
import { Layer3DTab } from "./camera3d/layer-3d-tab";
import { CameraLayerTab } from "./camera3d/camera-layer-tab";

const TRANSFORM_PARAM_KEYS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
] as const;

const BLENDING_PARAM_KEYS = ["opacity", "blendMode"] as const;
const AUDIO_PARAM_KEYS = ["volume", "muted"] as const;
const TEXT_PARAM_KEYS = [
	"content",
	"fontFamily",
	"fontSize",
	"color",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
] as const;

export type TabContentProps = {
	trackId: string;
};

export type PropertiesTabDef = {
	id: string;
	label: string;
	icon: ReactNode;
	content: (props: TabContentProps) => ReactNode;
};

export type ElementPropertiesConfig = {
	defaultTab: string;
	tabs: PropertiesTabDef[];
};

function buildTransformTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "transform",
		label: "Transform",
		icon: <HugeiconsIcon icon={ArrowExpandIcon} size={16} />,
		content: ({ trackId }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={TRANSFORM_PARAM_KEYS}
				sectionKey="transform"
			/>
		),
	};
}

function buildBlendingTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "blending",
		label: "Blending",
		icon: <HugeiconsIcon icon={RainDropIcon} size={16} />,
		content: ({ trackId }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={BLENDING_PARAM_KEYS}
				sectionKey="blending"
			/>
		),
	};
}

function buildAnimationTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "animation",
		label: "Animation",
		icon: <HugeiconsIcon icon={Motion01Icon} size={16} />,
		content: ({ trackId }) => (
			<AnimationTab element={element} trackId={trackId} />
		),
	};
}

function buildBackgroundTab({
	element,
}: {
	element: TimelineElement;
}): PropertiesTabDef {
	return {
		id: "background",
		label: "Background",
		icon: <HugeiconsIcon icon={ColorPickerIcon} size={16} />,
		content: ({ trackId }) => (
			<BackgroundTab element={element} trackId={trackId} />
		),
	};
}

function buildKeyframePresetsTab({
	element,
}: {
	element: TimelineElement;
}): PropertiesTabDef {
	return {
		id: "keyframe-presets",
		label: "Keyframes",
		icon: <HugeiconsIcon icon={KeyframeIcon} size={16} />,
		content: ({ trackId }) => (
			<KeyframePresetsTab targets={[{ trackId, element }]} />
		),
	};
}

/** AE's 3D Camera Tracker on a video clip (Track Camera and its effect controls). */
function buildCameraTrackerTab({
	element,
}: {
	element: VideoElement;
}): PropertiesTabDef {
	return {
		id: "tracking",
		label: "Tracking",
		icon: <HugeiconsIcon icon={FocusPointIcon} size={16} />,
		content: () => <CameraTrackerTab element={element} />,
	};
}

/**
 * Adds the "3D" tab (AE's 3D layer switch and 3D transform) to a visual
 * layer's tabs once its `transform3d.*` params are registered; on a 3D layer
 * the 2D Transform and Masks tabs are dropped.
 */
function withLayer3DTab({
	element,
	config,
}: {
	element: TextElement | ImageElement | StickerElement | GraphicElement;
	config: ElementPropertiesConfig;
}): ElementPropertiesConfig {
	const paramKeys = layer3DTabKeys({
		elementType: element.type,
		registeredKeys: new Set(getElementParams({ element }).map((param) => param.key)),
	});
	const layer3DTab: PropertiesTabDef | null = paramKeys
		? {
				id: LAYER_3D_TAB_ID,
				label: "3D",
				icon: <HugeiconsIcon icon={ThreeDViewIcon} size={16} />,
				content: ({ trackId }) => (
					<Layer3DTab element={element} trackId={trackId} paramKeys={paramKeys} />
				),
			}
		: null;
	return arrangeLayerTabs({
		tabs: config.tabs,
		defaultTab: config.defaultTab,
		layer3DTab,
		is3D: isLayer3D((key) => element.params[key]),
	});
}

function buildAudioTab({
	element,
}: {
	element: AudioElement | VideoElement;
}): PropertiesTabDef {
	return {
		id: "audio",
		label: "Audio",
		icon: <HugeiconsIcon icon={MusicNote03Icon} size={16} />,
		content: ({ trackId }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={AUDIO_PARAM_KEYS}
				sectionKey="audio"
			/>
		),
	};
}

function buildSpeedTab({
	element,
}: {
	element: RetimableElement;
}): PropertiesTabDef {
	return {
		id: "speed",
		label: "Speed",
		icon: <HugeiconsIcon icon={DashboardSpeed02Icon} size={16} />,
		content: ({ trackId }) => <SpeedTab element={element} trackId={trackId} />,
	};
}

function buildMasksTab({
	element,
}: {
	element: MaskableElement;
}): PropertiesTabDef {
	return {
		id: "masks",
		label: "Masks",
		icon: <OcShapesIcon size={16} />,
		content: ({ trackId }) => <MasksTab element={element} trackId={trackId} />,
	};
}

function buildClipEffectsTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "effects",
		label: "Effects",
		icon: <HugeiconsIcon icon={MagicWand05Icon} size={16} />,
		content: ({ trackId }) => (
			<ClipEffectsTab element={element} trackId={trackId} />
		),
	};
}

function buildTextTab({ element }: { element: TextElement }): PropertiesTabDef {
	return {
		id: "text",
		label: "Text",
		icon: <HugeiconsIcon icon={TextFontIcon} size={16} />,
		content: ({ trackId }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={TEXT_PARAM_KEYS}
				sectionKey="text"
			/>
		),
	};
}

function buildGraphicTab({
	element,
}: {
	element: GraphicElement;
}): PropertiesTabDef {
	return {
		id: "graphic",
		label: "Graphic",
		icon: <OcShapesIcon size={16} />,
		content: ({ trackId }) => <GraphicTab element={element} trackId={trackId} />,
	};
}

function buildStandaloneEffectTab({
	element,
}: {
	element: EffectElement;
}): PropertiesTabDef {
	return {
		id: "effects",
		label: "Effects",
		icon: <HugeiconsIcon icon={MagicWand05Icon} size={16} />,
		content: ({ trackId }) => (
			<StandaloneEffectTab element={element} trackId={trackId} />
		),
	};
}

function getTextConfig({
	element,
}: {
	element: TextElement;
}): ElementPropertiesConfig {
	return withLayer3DTab({
		element,
		config: {
			defaultTab: "text",
			tabs: [
				buildTextTab({ element }),
				buildTransformTab({ element }),
				buildAnimationTab({ element }),
				buildKeyframePresetsTab({ element }),
				buildBlendingTab({ element }),
			],
		},
	});
}

function getVideoConfig({
	element,
	mediaAsset,
}: {
	element: VideoElement;
	mediaAsset: MediaAsset | undefined;
}): ElementPropertiesConfig {
	const showAudioTab = mediaAsset?.hasAudio !== false;
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ element }),
			buildAnimationTab({ element }),
			buildKeyframePresetsTab({ element }),
			...(showAudioTab ? [buildAudioTab({ element })] : []),
			buildSpeedTab({ element }),
			buildBlendingTab({ element }),
			buildBackgroundTab({ element }),
			buildMasksTab({ element }),
			buildClipEffectsTab({ element }),
			buildCameraTrackerTab({ element }),
		],
	};
}

function getImageConfig({
	element,
}: {
	element: ImageElement;
}): ElementPropertiesConfig {
	return withLayer3DTab({
		element,
		config: {
			defaultTab: "transform",
			tabs: [
				buildTransformTab({ element }),
				buildAnimationTab({ element }),
				buildKeyframePresetsTab({ element }),
				buildBlendingTab({ element }),
				buildBackgroundTab({ element }),
				buildMasksTab({ element }),
				buildClipEffectsTab({ element }),
			],
		},
	});
}

function getStickerConfig({
	element,
}: {
	element: StickerElement;
}): ElementPropertiesConfig {
	return withLayer3DTab({
		element,
		config: {
			defaultTab: "transform",
			tabs: [
				buildTransformTab({ element }),
				buildAnimationTab({ element }),
				buildKeyframePresetsTab({ element }),
				buildBlendingTab({ element }),
				buildBackgroundTab({ element }),
				buildClipEffectsTab({ element }),
			],
		},
	});
}

function getGraphicConfig({
	element,
}: {
	element: GraphicElement;
}): ElementPropertiesConfig {
	return withLayer3DTab({
		element,
		config: {
			defaultTab: "graphic",
			tabs: [
				buildGraphicTab({ element }),
				buildTransformTab({ element }),
				buildAnimationTab({ element }),
				buildKeyframePresetsTab({ element }),
				buildBlendingTab({ element }),
				buildMasksTab({ element }),
				buildClipEffectsTab({ element }),
			],
		},
	});
}

function getAudioConfig({
	element,
}: {
	element: AudioElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "audio",
		tabs: [
			buildAudioTab({ element }),
			buildKeyframePresetsTab({ element }),
			buildSpeedTab({ element }),
		],
	};
}

/** A camera layer reproduces a camera solve: its tab shows the source clip and the angle of view. */
function getCameraConfig({
	element,
}: {
	element: CameraElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "camera",
		tabs: [
			{
				id: "camera",
				label: "Camera",
				icon: <HugeiconsIcon icon={Video01Icon} size={16} />,
				content: ({ trackId }) => <CameraLayerTab element={element} trackId={trackId} />,
			},
		],
	};
}

function getEffectConfig({
	element,
}: {
	element: EffectElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "effects",
		tabs: [buildStandaloneEffectTab({ element })],
	};
}

export function getPropertiesConfig({
	element,
	mediaAssets,
}: {
	element: TimelineElement;
	mediaAssets: MediaAsset[];
}): ElementPropertiesConfig {
	switch (element.type) {
		case "text":
			return getTextConfig({ element });
		case "video": {
			const mediaAsset = mediaAssets.find((a) => a.id === element.mediaId);
			return getVideoConfig({ element, mediaAsset });
		}
		case "image":
			return getImageConfig({ element });
		case "sticker":
			return getStickerConfig({ element });
		case "graphic":
			return getGraphicConfig({ element });
		case "audio":
			return getAudioConfig({ element });
		case "effect":
			return getEffectConfig({ element });
		case "camera":
			return getCameraConfig({ element });
	}
}
