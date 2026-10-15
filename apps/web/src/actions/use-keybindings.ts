import { useEffect, useState } from "react";
import { invokeAction } from "@/actions";
import { createFocusModality } from "@/actions/focus-modality";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { isSliderKey } from "@/params/slider";
import { isTypableDOMElement } from "@/utils/browser";
import { shouldLeaveKeyToTarget } from "@/actions/interactive-target";

/**
 * a composable that hooks to the caller component's
 * lifecycle and hooks to the keyboard events to fire
 * the appropriate actions based on keybindings
 */
export function useKeybindingsListener() {
	const editor = useEditor();
	const {
		keybindings,
		getKeybindingString,
		overlayDepth,
		isLoadingProject,
		isRecording,
	} = useKeybindingsStore();
	// Survives the effect re-running when bindings change, so a click made
	// before that re-run is not forgotten.
	const [focusModality] = useState(createFocusModality);

	useEffect(() => {
		const eventOptions: AddEventListenerOptions = { capture: true };
		const handlePointerDown = () => {
			focusModality.onPointerDown();
		};
		const handleKeyDown = (ev: KeyboardEvent) => {
			const key = ev.key ?? "";
			// Before every early return below, so Tab is seen even inside overlays.
			focusModality.onKeyDown({ key });

			const normalizedKey = key.toLowerCase();

			if (overlayDepth > 0 || isLoadingProject || isRecording) {
				return;
			}

			const binding = getKeybindingString(ev);
			const activeElement = document.activeElement;
			const isTextInput =
				activeElement instanceof HTMLElement &&
				isTypableDOMElement({ element: activeElement });
			const boundAction = binding ? keybindings.get(binding) : undefined;

			if (normalizedKey === "escape" && isTextInput) {
				activeElement.blur();
				return;
			}

			// A focused slider owns its arrow/Home/End/Page keys; frame stepping and
			// timeline jumps must not fire on top of them.
			const isSliderFocused = Boolean(
				activeElement?.closest('[role="slider"]'),
			);
			if (
				isSliderFocused &&
				isSliderKey({ key: ev.key }) &&
				!ev.ctrlKey &&
				!ev.metaKey &&
				!ev.altKey
			) {
				return;
			}

			// Enter/Space on a control focused with the keyboard activates that
			// control (a button click), so the global shortcut must neither run nor
			// preventDefault. A control still focused after a mouse click does not
			// get them: click a clip, press Space, and the video plays.
			if (
				shouldLeaveKeyToTarget({
					key,
					ctrlKey: ev.ctrlKey,
					metaKey: ev.metaKey,
					altKey: ev.altKey,
					target: ev.target instanceof HTMLElement ? ev.target : activeElement,
					keyboardFocus: focusModality.isKeyboard(),
				})
			) {
				return;
			}

			if (!binding) return;
			if (!boundAction) return;

			if (isTextInput) return;
			if (boundAction === "paste-copied") {
				if (!editor.clipboard.hasEntry()) return;
				ev.preventDefault();
				invokeAction("paste-copied", undefined, "keypress");
				return;
			}

			ev.preventDefault();

			switch (boundAction) {
				case "seek-forward":
					invokeAction("seek-forward", { seconds: 1 }, "keypress");
					break;
				case "seek-backward":
					invokeAction("seek-backward", { seconds: 1 }, "keypress");
					break;
				case "jump-forward":
					invokeAction("jump-forward", { seconds: 5 }, "keypress");
					break;
				case "jump-backward":
					invokeAction("jump-backward", { seconds: 5 }, "keypress");
					break;
				default:
					invokeAction(boundAction, undefined, "keypress");
			}
		};

		window.addEventListener("pointerdown", handlePointerDown, eventOptions);
		document.addEventListener("keydown", handleKeyDown, eventOptions);

		return () => {
			window.removeEventListener(
				"pointerdown",
				handlePointerDown,
				eventOptions,
			);
			document.removeEventListener("keydown", handleKeyDown, eventOptions);
		};
	}, [
		focusModality,
		keybindings,
		getKeybindingString,
		overlayDepth,
		isLoadingProject,
		isRecording,
		editor,
	]);
}
