"use client";

import { useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import type { ParamValue } from "@/params";
import type { VideoElement } from "@/timeline";
import {
	getCameraTrackerApi,
	useCameraTrackerSession,
} from "@/tracking/camera3d/session";
import type { CameraTrackerSettings } from "@/tracking/camera3d/types";
import { buildTrackingTab, settingPatch } from "@/tracking/camera3d/ui/tab-model";
import {
	callEngine,
	createTrackedLayers,
	playheadAnalysisFrame,
	runCameraTracker,
} from "./camera-tracker-actions";
import { CameraTrackerTabView } from "./camera-tracker-tab-view";

/**
 * The Tracking tab of a video clip: AE's 3D Camera Tracker effect controls.
 * Thin: the model decides, the engine (`getCameraTrackerApi()`) does the
 * work; without a registered engine everything is disabled with the reason.
 */
export function CameraTrackerTab({ element }: { element: VideoElement }) {
	const time = useEditor((editor) => editor.playback.getCurrentTime());
	const phase = useCameraTrackerSession((state) => state.phase);
	const outcome = useCameraTrackerSession((state) => state.outcomes[element.id]);
	const api = getCameraTrackerApi();
	const decoded = api ? api.decoded({ elementId: element.id }) : null;
	const model = buildTrackingTab({
		apiReady: api !== null,
		elementId: element.id,
		phase,
		decoded,
		outcome,
	});
	// a slider's value while it is dragged; written once, on release (one undo step)
	const [draft, setDraft] = useState<Partial<CameraTrackerSettings>>({});
	const draftRef = useRef<Partial<CameraTrackerSettings>>({});

	const preview = ({ key, value }: { key: keyof CameraTrackerSettings; value: ParamValue }) => {
		const patch = settingPatch({ key, value });
		if (!patch) return;
		draftRef.current = { ...draftRef.current, ...patch };
		setDraft(draftRef.current);
	};
	const commit = () => {
		const patch = draftRef.current;
		draftRef.current = {};
		setDraft({});
		if (!api || Object.keys(patch).length === 0) return;
		callEngine(() => api.updateSettings({ elementId: element.id, patch }));
	};

	return (
		<CameraTrackerTabView
			elementId={element.id}
			model={model}
			values={{ ...model.settings, ...draft }}
			onPrimary={() => {
				if (!api) return;
				if (model.primary.action === "cancel") {
					api.cancel();
					return;
				}
				void runCameraTracker({ api, elementId: element.id, mode: "track" });
			}}
			onStaleAction={() => {
				if (!api || !model.stale) return;
				void runCameraTracker({
					api,
					elementId: element.id,
					mode: model.stale.action === "resolve" ? "resolve" : "track",
				});
			}}
			onCreateCamera={() => {
				if (!api || !decoded) return;
				createTrackedLayers({
					api,
					args: {
						elementId: element.id,
						kind: null,
						multiple: false,
						target: null,
						trackIds: [],
						frame: playheadAnalysisFrame({ clip: element, decoded, time }),
					},
				});
			}}
			onSettingPreview={preview}
			onSettingCommit={commit}
		/>
	);
}
