"use client";

import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	KeyframeIcon,
} from "@hugeicons/core-free-icons";
import { invokeAction } from "@/actions";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import {
	getKeyframeToolbarState,
	type KeyframeToolbarState,
} from "@/timeline/keyframe-toolbar-state";
import { resolveKeyframeTargets } from "@/timeline/playhead-keyframes";
import {
	findCurveKeyframesAtTime,
	toSegmentStartKeyframes,
} from "@/timeline/keyframe-curve-targets";
import { useKeyframeCurveMenuStore } from "@/timeline/keyframe-curve-menu-store";
import { cn } from "@/utils/ui";
import { ToolbarButton } from "./toolbar-button";

function formatShortcut({ shortcut }: { shortcut: string | undefined }): string {
	return shortcut
		? ` (${shortcut
				.split("+")
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join("+")})`
		: "";
}

/** The previous / diamond / next buttons. Pure view: the state comes from the caller. */
export function KeyframeToolbarButtons({
	state,
	shortcuts,
	onPrevious,
	onToggle,
	onNext,
	onCurveMenu,
}: {
	state: KeyframeToolbarState;
	shortcuts: { previous?: string; toggle?: string; next?: string };
	onPrevious: () => void;
	onToggle: () => void;
	onNext: () => void;
	/** Right click on the diamond: the curve menu for the keyframes at the playhead. */
	onCurveMenu?: (event: React.MouseEvent) => void;
}) {
	const toggleTooltip = state.toggle.enabled
		? `${state.toggle.isKeyed ? "Remove keyframe" : "Add keyframe"} at the playhead${formatShortcut({ shortcut: shortcuts.toggle })}${onCurveMenu ? ". Right-click: curve" : ""}`
		: `Keyframe at the playhead: ${state.toggle.reason}`;
	return (
		<>
			<ToolbarButton
				icon={<HugeiconsIcon icon={ArrowLeft01Icon} />}
				label="Previous keyframe"
				tooltip={
					state.previous.enabled
						? `Previous keyframe${formatShortcut({ shortcut: shortcuts.previous })}`
						: `Previous keyframe: ${state.previous.reason}`
				}
				disabled={!state.previous.enabled}
				onClick={onPrevious}
			/>
			<ToolbarButton
				icon={
					<HugeiconsIcon
						icon={KeyframeIcon}
						className={cn(state.toggle.isKeyed && "text-primary fill-primary")}
					/>
				}
				label="Add or remove keyframe at the playhead"
				tooltip={toggleTooltip}
				isActive={state.toggle.isKeyed}
				disabled={!state.toggle.enabled}
				onClick={onToggle}
				onContextMenu={
					onCurveMenu
						? (event) => {
								event.preventDefault();
								onCurveMenu(event);
							}
						: undefined
				}
			/>
			<ToolbarButton
				icon={<HugeiconsIcon icon={ArrowRight01Icon} />}
				label="Next keyframe"
				tooltip={
					state.next.enabled
						? `Next keyframe${formatShortcut({ shortcut: shortcuts.next })}`
						: `Next keyframe: ${state.next.reason}`
				}
				disabled={!state.next.enabled}
				onClick={onNext}
			/>
		</>
	);
}

/** The keyframe group of the timeline toolbar, next to Auto hits. */
export function KeyframeToolbarGroup() {
	const { selectedElements } = useElementSelection();
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const playhead = useEditor((e) => e.playback.getCurrentTime());
	const getKeybindingsForAction = useKeybindingsStore(
		(store) => store.getKeybindingsForAction,
	);
	const targets = tracks
		? resolveKeyframeTargets({ tracks, selected: selectedElements })
		: [];
	const state = getKeyframeToolbarState({ targets, playhead });
	const openCurveMenu = useKeyframeCurveMenuStore((store) => store.open);

	return (
		<KeyframeToolbarButtons
			state={state}
			shortcuts={{
				previous: getKeybindingsForAction("previous-keyframe")[0],
				toggle: getKeybindingsForAction("toggle-keyframe-at-playhead")[0],
				next: getKeybindingsForAction("next-keyframe")[0],
			}}
			onPrevious={() => invokeAction("previous-keyframe")}
			onToggle={() => invokeAction("toggle-keyframe-at-playhead")}
			onNext={() => invokeAction("next-keyframe")}
			onCurveMenu={(event) => {
				const target = targets.find(
					({ element }) =>
						playhead >= element.startTime &&
						playhead <= element.startTime + element.duration,
				);
				if (!target) return;
				const { element } = target;
				const keyframes = toSegmentStartKeyframes({
					animations: element.animations,
					keyframes: findCurveKeyframesAtTime({
						trackId: target.trackId,
						elementId: element.id,
						animations: element.animations,
						paths: Object.keys(element.animations ?? {}),
						localTime: playhead - element.startTime,
					}),
				});
				if (keyframes.length === 0) {
					toast.info("No keyframe here. Add two keyframes, then right-click to pick the curve between them.");
					return;
				}
				openCurveMenu({
					x: event.clientX,
					y: event.clientY,
					trackId: target.trackId,
					elementId: element.id,
					keyframes,
				});
			}}
		/>
	);
}
