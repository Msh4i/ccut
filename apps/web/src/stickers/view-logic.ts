import { STICKER_CATEGORIES, isStickerCategory } from "./categories";
import { describeId } from "./describe-id";

/**
 * The picker's decisions that do not need a DOM: which view the store state
 * calls for, when the panel may start its first browse, how a mouse wheel moves
 * the tab bar, and how a long result list is drawn in parts. Kept apart from
 * the components so each rule is tested on its own.
 */

/** Tiles drawn at first for a long result list (22k DOM nodes per 2,000 tiles otherwise). */
export const PROGRESSIVE_INITIAL_COUNT = 200;
/** Tiles added each time the end of the list scrolls into view. */
export const PROGRESSIVE_STEP = 200;
/** A wheel that reports lines (Firefox, some mice) moves about this many pixels per line. */
const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;

export function revealMore({
	visible,
	total,
}: {
	visible: number;
	total: number;
}): number {
	return Math.min(total, visible + PROGRESSIVE_STEP);
}

/**
 * Whether the panel's effect should start a browse. The store already starts
 * one on a category change (and a search when there is a query), so the effect
 * is only for the very first open. It must not run while a browse is in flight
 * (that duplicated the 1,595/2,866-item work), and not after a failure: the
 * user's Retry is the only thing that retries, otherwise a failing catalog
 * would be requested in a loop.
 */
export function shouldStartInitialBrowse({
	viewMode,
	hasBrowseContent,
	isBrowsing,
	loadError,
}: {
	viewMode: "browse" | "search";
	hasBrowseContent: boolean;
	isBrowsing: boolean;
	loadError: string | null;
}): boolean {
	return (
		viewMode === "browse" &&
		!hasBrowseContent &&
		!isBrowsing &&
		loadError === null
	);
}

/**
 * Where a mouse wheel over the tab bar should scroll it to, or null to leave
 * the wheel to the browser. The bar has no visible scrollbar, so a plain
 * vertical wheel has to move it sideways. Left alone: Ctrl/Meta + wheel (a zoom),
 * sideways gestures (a trackpad already scrolls it), a bar that does not overflow, and a bar that
 * is already at the end the wheel points to (the page may take it).
 */
export function horizontalScrollTarget({
	deltaX,
	deltaY,
	deltaMode,
	scrollLeft,
	scrollWidth,
	clientWidth,
	ctrlKey = false,
	metaKey = false,
}: {
	deltaX: number;
	deltaY: number;
	deltaMode: number;
	scrollLeft: number;
	scrollWidth: number;
	clientWidth: number;
	/** Ctrl or Meta with the wheel is pinch-zoom or page zoom: not ours. */
	ctrlKey?: boolean;
	metaKey?: boolean;
}): number | null {
	const maxScrollLeft = scrollWidth - clientWidth;
	if (
		ctrlKey ||
		metaKey ||
		deltaX !== 0 ||
		deltaY === 0 ||
		maxScrollLeft <= 0
	) {
		return null;
	}

	const pixels =
		deltaMode === WHEEL_DELTA_MODE_LINE
			? deltaY * WHEEL_LINE_HEIGHT_PX
			: deltaMode === WHEEL_DELTA_MODE_PAGE
				? deltaY * clientWidth
				: deltaY;
	const target = Math.min(maxScrollLeft, Math.max(0, scrollLeft + pixels));
	return target === scrollLeft ? null : target;
}

export type ContentState =
	/** A catalog could not be loaded: message and Retry. */
	| "error"
	/** A category search with matches: the grid. */
	| "results"
	/** Browse sections, or the All tab's search sections. */
	| "sections"
	| "spinner"
	/** A category search finished with no matches. */
	| "no-results"
	| "empty";

/**
 * Which view the store state calls for. While a new search runs, the previous
 * results stay on screen: swapping a 2,000-tile grid for a spinner on every
 * keystroke tears the grid down and mounts it again.
 */
export function getContentState({
	viewMode,
	selectedCategory,
	isSearching,
	isBrowsing,
	loadError,
	hasSearchResults,
	hasBrowseSections,
}: {
	viewMode: "browse" | "search";
	selectedCategory: string;
	isSearching: boolean;
	isBrowsing: boolean;
	loadError: string | null;
	hasSearchResults: boolean;
	hasBrowseSections: boolean;
}): ContentState {
	if (loadError !== null) {
		return "error";
	}

	if (viewMode === "search") {
		if (selectedCategory !== "all") {
			if (hasSearchResults) return "results";
			return isSearching ? "spinner" : "no-results";
		}
		if (hasBrowseSections) return "sections";
		return isSearching ? "spinner" : "empty";
	}

	if (hasBrowseSections) return "sections";
	return isBrowsing ? "spinner" : "empty";
}

/** "1 result", "2 results". */
export function formatResultCount({ total }: { total: number }): string {
	return `${total} result${total === 1 ? "" : "s"}`;
}

/**
 * The text of the picker's one live region (screen readers announce changes to
 * it politely): searching, how many results, no matches, a failure. Browsing
 * is silent. It is always in the page, so a change is announced even when the
 * previous results stay on screen during a new search.
 */
export function getStatusMessage({
	state,
	viewMode,
	isSearching,
	total,
	sectionCount,
	hasSectionErrors,
	loadError,
}: {
	state: ContentState;
	viewMode: "browse" | "search";
	isSearching: boolean;
	total: number;
	sectionCount: number;
	hasSectionErrors: boolean;
	loadError: string | null;
}): string {
	if (state === "error") {
		return loadError ?? "Something went wrong";
	}
	if (viewMode === "search") {
		if (isSearching) return "Searching…";
		if (state === "results") return formatResultCount({ total });
		if (state === "sections") {
			return `Found stickers in ${sectionCount} ${sectionCount === 1 ? "category" : "categories"}`;
		}
		return "No stickers found";
	}
	return hasSectionErrors ? "Some stickers could not be loaded" : "";
}

/** The text of the empty view. `searchedQuery` is the query the results belong to, not what is typed now. */
export function getEmptyMessage({
	viewMode,
	selectedCategory,
	searchedQuery,
}: {
	viewMode: "browse" | "search";
	selectedCategory: string;
	searchedQuery: string;
}): string {
	if (viewMode === "search") {
		return `No stickers found for "${describeId({ value: searchedQuery })}"`;
	}
	if (selectedCategory === "all") {
		return "No stickers available yet.";
	}
	return isStickerCategory(selectedCategory)
		? `No stickers available in ${STICKER_CATEGORIES[selectedCategory].toLowerCase()} yet.`
		: "No stickers available here yet.";
}
