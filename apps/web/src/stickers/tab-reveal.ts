/** What revealing a tab needs of its element (an HTMLElement has both). */
export interface TabLike {
	scrollIntoView: (options: ScrollIntoViewOptions) => void;
	focus: (options: FocusOptions) => void;
}

/**
 * Brings the active category tab into view (the tab bar scrolls sideways when
 * it is wider than the panel). After "See all" the tab also takes the focus:
 * the button that had it disappeared with the old tab's content, and focus
 * would otherwise fall back to the page. Neither jumps the page itself.
 */
export function revealTab({
	tab,
	takeFocus,
}: {
	tab: TabLike | null | undefined;
	takeFocus: boolean;
}): void {
	if (!tab) {
		return;
	}
	tab.scrollIntoView({ block: "nearest", inline: "nearest" });
	if (takeFocus) {
		tab.focus({ preventScroll: true });
	}
}
