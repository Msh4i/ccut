/**
 * Stand-ins for the two preview controllers' dependencies: a scene with one
 * image clip, pointer events that carry just what the controllers read, and a
 * log of everything the controllers ask the timeline to do.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import type { MediaAsset } from "@/media/types";
import type { ParamValues } from "@/params";
import type { ImageElement, SceneTracks } from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import type { TimelinePreviewUpdate } from "../controllers/preview-interaction-controller";

export const CANVAS_SIZE = { width: 1920, height: 1080 } as const;
export const ELEMENT_ID = "img-1";
export const TRACK_ID = "overlay-1";
export const PLAYHEAD = mediaTimeFromSeconds({ seconds: 1 });

export const BASE_PARAMS: ParamValues = {
	"transform.positionX": 10,
	"transform.positionY": 20,
	"transform.scaleX": 0.5,
	"transform.scaleY": 0.5,
	"transform.rotate": 0,
	opacity: 1,
};

function key({ id, seconds, value }: { id: string; seconds: number; value: number }): ScalarAnimationKey {
	return {
		id,
		time: mediaTimeFromSeconds({ seconds }),
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

/** Keys on all five transform channels: x grows 100 px per second, scale 0.5 to 1.5, turn 10 deg per second. */
export const PIN_LIKE_ANIMATIONS: ElementAnimations = {
	"transform.positionX": { keys: [key({ id: "x0", seconds: 0, value: 0 }), key({ id: "x1", seconds: 2, value: 200 })] },
	"transform.positionY": { keys: [key({ id: "y0", seconds: 0, value: 0 }), key({ id: "y1", seconds: 2, value: 40 })] },
	"transform.scaleX": { keys: [key({ id: "sx0", seconds: 0, value: 0.5 }), key({ id: "sx1", seconds: 2, value: 1.5 })] },
	"transform.scaleY": { keys: [key({ id: "sy0", seconds: 0, value: 0.5 }), key({ id: "sy1", seconds: 2, value: 1.5 })] },
	"transform.rotate": { keys: [key({ id: "r0", seconds: 0, value: 0 }), key({ id: "r1", seconds: 2, value: 20 })] },
};

export const OPACITY_ANIMATIONS: ElementAnimations = {
	opacity: { keys: [key({ id: "o0", seconds: 0, value: 1 }), key({ id: "o1", seconds: 2, value: 0.5 })] },
};

export function imageElement({
	animations,
	params = BASE_PARAMS,
	id = ELEMENT_ID,
}: {
	animations?: ElementAnimations;
	params?: ParamValues;
	id?: string;
} = {}): ImageElement {
	return {
		id,
		type: "image",
		name: "image",
		mediaId: "media-1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTimeFromSeconds({ seconds: 4 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params,
		...(animations ? { animations } : {}),
	};
}

/** A second image clip on a track of its own, above the first. */
export const OTHER_TRACK_ID = "overlay-2";

export function sceneTracksWithTwo({
	lower,
	upper,
}: {
	lower: ImageElement;
	upper: ImageElement;
}): SceneTracks {
	const base = sceneTracks({ element: lower });
	return {
		...base,
		overlay: [
			{ id: OTHER_TRACK_ID, name: "Overlay 2", type: "video", muted: false, hidden: false, elements: [upper] },
			...base.overlay,
		],
	};
}

export function sceneTracks({ element }: { element: ImageElement }): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
		overlay: [
			{
				id: TRACK_ID,
				name: "Overlay",
				type: "video",
				muted: false,
				hidden: false,
				elements: [element],
			},
		],
		audio: [],
	};
}

const asset: MediaAsset = Object.assign(Object.create(null), {
	id: "media-1",
	type: "image",
	name: "image.png",
	width: 1920,
	height: 1080,
});

export const MEDIA_ASSETS: MediaAsset[] = [asset];

export type TimelineCall =
	| { call: "preview"; updates: readonly TimelinePreviewUpdate[] }
	| { call: "commit" }
	| { call: "discard" };

export function timelineLog() {
	const calls: TimelineCall[] = [];
	return {
		calls,
		ops: {
			previewElements: (updates: readonly TimelinePreviewUpdate[]) => {
				calls.push({ call: "preview", updates });
			},
			commitPreview: () => {
				calls.push({ call: "commit" });
			},
			discardPreview: () => {
				calls.push({ call: "discard" });
			},
		},
	};
}

/** The part of an element a controller captures the pointer on. */
export interface CaptureTarget {
	setPointerCapture: (pointerId: number) => void;
	hasPointerCapture: (pointerId: number) => boolean;
	releasePointerCapture: (pointerId: number) => void;
}

/**
 * A handle that keeps pointer capture the way the browser does: releasing a
 * capture that is held queues one `lostpointercapture`, which the browser
 * delivers afterwards (the page's handler for it is the handle's end handler).
 */
export function capturingTarget() {
	let captured: number | null = null;
	let lostCaptureQueued = 0;
	const target: CaptureTarget = {
		setPointerCapture: (pointerId) => {
			captured = pointerId;
		},
		hasPointerCapture: (pointerId) => captured === pointerId,
		releasePointerCapture: (pointerId) => {
			if (captured !== pointerId) return;
			captured = null;
			lostCaptureQueued++;
		},
	};
	return {
		target,
		isCaptured: () => captured !== null,
		/** How many `lostpointercapture` events the browser still has to deliver. */
		takeLostCaptures: () => {
			const count = lostCaptureQueued;
			lostCaptureQueued = 0;
			return count;
		},
	};
}

export function pointerEvent({
	clientX = 0,
	clientY = 0,
	type = "pointerdown",
	button = 0,
	pointerId = 1,
	target = {
		setPointerCapture: () => {},
		hasPointerCapture: () => false,
		releasePointerCapture: () => {},
	},
}: {
	clientX?: number;
	clientY?: number;
	type?: string;
	button?: number;
	pointerId?: number;
	target?: CaptureTarget;
} = {}): ReactPointerEvent {
	return Object.assign(Object.create(null), {
		clientX,
		clientY,
		type,
		button,
		pointerId,
		currentTarget: target,
		stopPropagation: () => {},
	});
}

/** Canvas px equal screen px, so the controllers see the numbers the tests give. */
export const IDENTITY_VIEWPORT = {
	screenToCanvas: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({
		x: clientX,
		y: clientY,
	}),
	screenPixelsToLogicalThreshold: () => ({ x: 1, y: 1 }),
};
