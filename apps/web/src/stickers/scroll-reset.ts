/** What resetting a scroller needs (an HTMLElement has it). */
export interface ScrollerLike {
	scrollTo?: (options: ScrollToOptions) => void;
}

/**
 * Back to the top of the list. A new search puts new results in place of the
 * old ones (the old ones stay on screen until then, there is no spinner to
 * shrink the page), so the scroll position would otherwise stay wherever the
 * previous results were scrolled to.
 */
export function scrollToTop({
	element,
}: {
	element: ScrollerLike | null | undefined;
}): void {
	element?.scrollTo?.({ top: 0 });
}
