/** The part of a DOM element the decision needs, so tests need no DOM. */
export interface InteractiveTargetCandidate {
	tagName: string;
	isContentEditable?: boolean;
	getAttribute(name: string): string | null;
	parentElement: InteractiveTargetCandidate | null;
}

/**
 * How a focused element reacts to Enter/Space.
 * - text-entry: types or edits with those keys, always theirs.
 * - click-control: the browser "clicks" it, theirs only for keyboard focus.
 * - other: no activation behaviour (sliders use arrows/Home/End/Page keys).
 */
type KeyTargetKind = "text-entry" | "click-control" | "other";

const CLICK_INPUT_TYPES: ReadonlySet<string> = new Set([
	"button",
	"submit",
	"reset",
	"checkbox",
	"radio",
	"image",
	"file",
	"color",
]);

const CLICK_ROLES: ReadonlySet<string> = new Set([
	"button",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"checkbox",
	"radio",
	"switch",
	"option",
	"link",
	"combobox",
	"spinbutton",
]);

const MAX_ANCESTOR_DEPTH = 64;

/** Keys that activate a focused control: the global shortcut must not take them. */
export function isActivationKey({ key }: { key: string }): boolean {
	return key === "Enter" || key === " " || key === "Spacebar";
}

function getInputKind({
	element,
}: {
	element: InteractiveTargetCandidate;
}): KeyTargetKind {
	const type = (element.getAttribute("type") ?? "text").trim().toLowerCase();
	if (CLICK_INPUT_TYPES.has(type)) return "click-control";
	if (type === "range") return "other";
	return "text-entry";
}

/** Null means this element says nothing, so the decision moves to its parent. */
function classifyElement({
	element,
}: {
	element: InteractiveTargetCandidate;
}): KeyTargetKind | null {
	if (element.isContentEditable) return "text-entry";

	const tag = element.tagName.toUpperCase();
	if (tag === "TEXTAREA" || tag === "SELECT") return "text-entry";
	if (tag === "INPUT") return getInputKind({ element });

	// A role attribute may list fallbacks ("slider foo"): the first token wins.
	const role =
		element.getAttribute("role")?.trim().toLowerCase().split(/\s+/)[0] ?? null;
	// ARIA sliders never use Enter/Space; arrows/Home/End/Page keys are theirs.
	if (role === "slider") return "other";

	if (tag === "BUTTON" || tag === "SUMMARY") return "click-control";
	if (tag === "A" && element.getAttribute("href") !== null) {
		return "click-control";
	}
	if (role !== null && CLICK_ROLES.has(role)) return "click-control";
	return null;
}

/** The nearest element, starting at the target, that decides what Enter/Space does. */
function classifyTarget({
	target,
}: {
	target: InteractiveTargetCandidate | null;
}): KeyTargetKind {
	for (
		let current = target, depth = 0;
		current !== null && depth < MAX_ANCESTOR_DEPTH;
		current = current.parentElement, depth++
	) {
		const kind = classifyElement({ element: current });
		if (kind !== null) return kind;
	}
	return "other";
}

/**
 * Enter/Space pressed on a control activates that control instead of running a
 * global shortcut, but only when the control was reached with the keyboard.
 * A control that keeps focus after a mouse click must not swallow Space.
 */
export function shouldLeaveKeyToTarget({
	key,
	ctrlKey,
	metaKey,
	altKey,
	target,
	keyboardFocus,
}: {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	target: InteractiveTargetCandidate | null;
	keyboardFocus: boolean;
}): boolean {
	if (!isActivationKey({ key })) return false;
	// Ctrl/Meta/Alt chords are user-bindable shortcuts. Shift may pass.
	if (ctrlKey || metaKey || altKey) return false;

	const kind = classifyTarget({ target });
	if (kind === "text-entry") return true;
	if (kind === "click-control") return keyboardFocus;
	return false;
}
