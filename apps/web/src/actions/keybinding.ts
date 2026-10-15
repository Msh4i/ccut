import type { TActionWithOptionalArgs } from "./types";

const MODIFIER_KEYS = [
	"ctrl",
	"alt",
	"shift",
	"ctrl+shift",
	"alt+shift",
	"ctrl+alt",
	"ctrl+alt+shift",
] as const;

/**
 * Alt is also regarded as macOS OPTION (⌥) key
 * Ctrl is also regarded as macOS COMMAND (⌘) key (NOTE: this differs from HTML Keyboard spec where COMMAND is Meta key!)
 */
export type ModifierKeys = (typeof MODIFIER_KEYS)[number];

const MODIFIER_KEY_SET: ReadonlySet<string> = new Set(MODIFIER_KEYS);

const KEYS = [
	"a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
	"k", "l", "m", "n", "o", "p", "q", "r", "s", "t",
	"u", "v", "w", "x", "y", "z",
	"0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
	"up", "down", "left", "right",
	"/", "?", ".",
	"enter", "tab", "space", "escape", "esc",
	"backspace", "delete", "home", "end",
] as const;

export type Key = (typeof KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(KEYS);

export function isKey(value: string): value is Key {
	return KEY_SET.has(value);
}

export type ModifierBasedShortcutKey = `${ModifierKeys}+${Key}`;
// Singular keybindings (these will be disabled when an input-ish area has been focused)
export type SingleCharacterShortcutKey = `${Key}`;

export type ShortcutKey = ModifierBasedShortcutKey | SingleCharacterShortcutKey;

export function isShortcutKey(value: string): value is ShortcutKey {
	if (isKey(value)) {
		return true;
	}

	// No `Key` contains "+", so the last "+" always separates modifier from key.
	const separatorIndex = value.lastIndexOf("+");
	if (separatorIndex === -1) {
		return false;
	}

	return (
		MODIFIER_KEY_SET.has(value.slice(0, separatorIndex)) &&
		isKey(value.slice(separatorIndex + 1))
	);
}

export type KeybindingConfig = {
	[key in ShortcutKey]?: TActionWithOptionalArgs;
};
