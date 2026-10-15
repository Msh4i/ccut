import { cameraAtFrame, horizontalAngleOfViewDeg } from "@/scene3d/camera";
import { LAYER_3D_ENABLED_KEY, LAYER_3D_KEYS } from "@/scene3d/layer-params";
import type { CameraElement, ElementType, VideoElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import type { DecodedCameraTracker } from "../session";
import { analysisFrameAt, clipSourceTimeAt } from "./view";

/**
 * Properties panel decisions for 3D layers and camera layers (architecture
 * 5.1 state 8): which params the "3D" tab lists, how it sits among the other
 * tabs, and what the camera layer's tab shows.
 */

export const LAYER_3D_TAB_ID = "transform3d";

/** Element types that can be 3D layers (architecture 2.1). */
const LAYER_3D_ELEMENT_TYPES: ReadonlySet<ElementType> = new Set([
	"text",
	"image",
	"sticker",
	"graphic",
]);

/** The "3D layer" switch, then AE's order: Position, Orientation, X/Y/Z Rotation, Scale. */
const LAYER_3D_TAB_KEYS: readonly string[] = [
	LAYER_3D_ENABLED_KEY,
	LAYER_3D_KEYS.positionX,
	LAYER_3D_KEYS.positionY,
	LAYER_3D_KEYS.positionZ,
	LAYER_3D_KEYS.orientationX,
	LAYER_3D_KEYS.orientationY,
	LAYER_3D_KEYS.orientationZ,
	LAYER_3D_KEYS.rotationX,
	LAYER_3D_KEYS.rotationY,
	LAYER_3D_KEYS.rotationZ,
	LAYER_3D_KEYS.scaleX,
	LAYER_3D_KEYS.scaleY,
	LAYER_3D_KEYS.scaleZ,
];

/**
 * The param keys the 3D tab lists for an element type, or `null` when the
 * type has no 3D tab or its params are not registered (the tab is then not
 * offered at all: it would be empty).
 */
export function layer3DTabKeys({
	elementType,
	registeredKeys,
}: {
	elementType: ElementType;
	registeredKeys: ReadonlySet<string>;
}): string[] | null {
	if (!LAYER_3D_ELEMENT_TYPES.has(elementType)) return null;
	if (!registeredKeys.has(LAYER_3D_ENABLED_KEY)) return null;
	return LAYER_3D_TAB_KEYS.filter((key) => registeredKeys.has(key));
}

/** Tabs a 3D layer does not get: its 2D transform is ignored by the renderer, and masks are not drawn on 3D layers (P1). */
const HIDDEN_ON_3D: ReadonlySet<string> = new Set(["transform", "masks"]);

/**
 * Puts the 3D tab right after Transform; on a 3D layer drops Transform and
 * Masks and, when the default tab was one of them, opens the 3D tab.
 */
export function arrangeLayerTabs<T extends { id: string }>({
	tabs,
	defaultTab,
	layer3DTab,
	is3D,
}: {
	tabs: readonly T[];
	defaultTab: string;
	layer3DTab: T | null;
	is3D: boolean;
}): { tabs: T[]; defaultTab: string } {
	if (!layer3DTab) return { tabs: [...tabs], defaultTab };
	const transformIndex = tabs.findIndex((tab) => tab.id === "transform");
	const at = transformIndex >= 0 ? transformIndex + 1 : Math.min(1, tabs.length);
	const withTab = [...tabs.slice(0, at), layer3DTab, ...tabs.slice(at)];
	if (!is3D) return { tabs: withTab, defaultTab };
	return {
		tabs: withTab.filter((tab) => !HIDDEN_ON_3D.has(tab.id)),
		defaultTab: HIDDEN_ON_3D.has(defaultTab) ? layer3DTab.id : defaultTab,
	};
}

export const CAMERA_TAB_NOTES = {
	missingSource:
		"The clip this camera was tracked from is gone: 3D layers use the default camera.",
	noSolve: "The source clip has no camera solve.",
} as const;

export interface CameraTabModel {
	sourceName: string;
	/** Horizontal angle of view at the playhead, one decimal, or `null` without a solve. */
	angleOfView: string | null;
	note: string | null;
	hidden: boolean;
}

export function buildCameraTab({
	camera,
	source,
	decoded,
	time,
}: {
	camera: CameraElement;
	source: VideoElement | null;
	decoded: DecodedCameraTracker | null;
	time: MediaTime;
}): CameraTabModel {
	const hidden = camera.hidden === true;
	if (!source) {
		return { sourceName: "Missing clip", angleOfView: null, note: CAMERA_TAB_NOTES.missingSource, hidden };
	}
	const solve = decoded?.solve ?? null;
	if (!decoded || !solve) {
		return { sourceName: source.name, angleOfView: null, note: CAMERA_TAB_NOTES.noSolve, hidden };
	}
	const frame = analysisFrameAt({
		sourceTime: clipSourceTimeAt({ clip: source, time }),
		sourceStart: decoded.data.sourceStart,
		fps: decoded.tracks?.fps ?? decoded.data.tracks.fps,
	});
	const state = cameraAtFrame({ frames: solve.cameras, frame });
	if (!state) {
		return { sourceName: source.name, angleOfView: null, note: CAMERA_TAB_NOTES.noSolve, hidden };
	}
	const degrees = horizontalAngleOfViewDeg({
		focalPx: state.focalPx,
		frameWidth: solve.frameWidth,
	});
	return {
		sourceName: source.name,
		angleOfView: `${degrees.toFixed(1)}°`,
		note: null,
		hidden,
	};
}
