import { EditorCore } from "@/core";
import type { PinOps } from "@/preview/controllers/pin-gesture";
import { isElementStuck } from "@/tracking/camera/pin-target";
import { useCameraPinStore } from "@/tracking/camera/store";

/** The preview controllers' view of "Stick to scene": the session store and the element's keys (an undone stick is not stuck). */
export const cameraPinOps: PinOps = {
	isPinned: ({ elementId }) =>
		isElementStuck({
			pins: useCameraPinStore.getState().pins,
			tracks: EditorCore.getInstance().scenes.getActiveSceneOrNull()?.tracks,
			elementId,
		}),
	repin: ({ elementId, look }) => {
		void useCameraPinStore.getState().repin({ elementId, look });
	},
};
