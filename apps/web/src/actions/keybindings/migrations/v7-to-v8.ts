import { getPersistedKeybindingsState } from "../persisted-state";

/**
 * The keyframe shortcuts added in round 7. The store keeps a saved keymap as
 * it is (new defaults are not merged in), so without this the owner's saved
 * keymap would never get Alt+K / Alt+Left / Alt+Right. Additive: a shortcut is
 * added only when the action has no key yet and the key is free; nothing the
 * user bound, moved or removed on purpose is touched.
 */
const KEYFRAME_SHORTCUTS = [
	["alt+k", "toggle-keyframe-at-playhead"],
	["alt+left", "previous-keyframe"],
	["alt+right", "next-keyframe"],
] as const;

export function v7ToV8({ state }: { state: unknown }): unknown {
	const v7 = getPersistedKeybindingsState({ state });
	if (!v7) return state;
	const keybindings = { ...v7.keybindings };
	const boundActions = new Set(Object.values(keybindings));

	for (const [key, action] of KEYFRAME_SHORTCUTS) {
		if (boundActions.has(action) || keybindings[key] !== undefined) continue;
		keybindings[key] = action;
	}

	return { ...v7, keybindings };
}
