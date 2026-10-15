export interface FocusModality {
	/** A pointer press (mouse, pen, touch) anywhere: the next focus is mouse-driven. */
	onPointerDown(): void;
	/** Only Tab moves focus by keyboard; every other key leaves the modality alone. */
	onKeyDown({ key }: { key: string }): void;
	/** True while the focused element was last reached with the keyboard. */
	isKeyboard(): boolean;
}

/**
 * Tracks how focus was last moved, without touching the DOM. A page starts in
 * keyboard mode (nothing was clicked yet). A pointer press switches to pointer
 * mode; Tab (with or without Shift) switches back. Space/Enter must not flip
 * it, otherwise a globally handled Space would hand the next Space to the
 * focused control.
 */
export function createFocusModality(): FocusModality {
	let keyboard = true;
	return {
		onPointerDown() {
			keyboard = false;
		},
		onKeyDown({ key }) {
			if (key === "Tab") keyboard = true;
		},
		isKeyboard() {
			return keyboard;
		},
	};
}
