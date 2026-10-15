"use client";

import { useCallback, useEffect, useState } from "react";
import { registerCanceller } from "@/editor/cancel-interaction";
import { useKeyframeSelection } from "@/timeline/hooks/element/use-keyframe-selection";
import { useCurveSession } from "./use-curve-session";

export function useGraphEditorController() {
	const { selectedKeyframes } = useKeyframeSelection();
	const session = useCurveSession({ selectedKeyframes });
	const { state, onCancelPreview: discardPreview } = session;
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (!open) {
			return;
		}

		return registerCanceller({
			fn: () => {
				discardPreview();
				setOpen(false);
			},
		});
	}, [discardPreview, open]);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen) {
				discardPreview();
			}

			setOpen(nextOpen);
		},
		[discardPreview],
	);

	return {
		...session,
		open,
		onOpenChange: handleOpenChange,
		canOpen: state.status === "ready",
		tooltip: state.status === "ready" ? "Open graph editor" : state.message,
	};
}
