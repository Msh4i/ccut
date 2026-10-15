export const STICKER_CATEGORIES = {
	all: "All",
	// v0.4.0
	// logos: "Logos",
	emoji: "Emoji",
	icons: "Icons",
	flags: "Flags",
	shapes: "Shapes",
};

/**
 * True for the keys of STICKER_CATEGORIES only. `key in STICKER_CATEGORIES`
 * also accepts "constructor", "toString" and "__proto__" (inherited from
 * Object.prototype), which a persisted or typed value must never become.
 */
export function isStickerCategory(
	value: unknown,
): value is keyof typeof STICKER_CATEGORIES {
	return typeof value === "string" && Object.hasOwn(STICKER_CATEGORIES, value);
}
