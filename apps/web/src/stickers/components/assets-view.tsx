"use client";

import Image from "next/image";
import type { CSSProperties } from "react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEditor } from "@/editor/use-editor";
import { createAddHandler } from "@/stickers/add-handler";
import { addSticker } from "@/stickers/add-sticker";
import { STICKER_CATEGORIES, isStickerCategory } from "@/stickers/categories";
import { getRegionLabel, resolveQueryToRegions } from "@/stickers";
import { parseShapeStickerId } from "@/stickers/providers/shapes";
import { createSearchInput } from "@/stickers/search-input";
import { MAX_QUERY_CHARS } from "@/stickers/search-fold";
import { observeSentinel } from "@/stickers/sentinel-observer";
import { createSingleFlight } from "@/stickers/single-flight";
import { scrollToTop } from "@/stickers/scroll-reset";
import { revealTab } from "@/stickers/tab-reveal";
import {
	PROGRESSIVE_INITIAL_COUNT,
	type ContentState,
	formatResultCount,
	getContentState,
	getEmptyMessage,
	getStatusMessage,
	revealMore,
	shouldStartInitialBrowse,
} from "@/stickers/view-logic";
import { attachHorizontalWheelScroll } from "@/stickers/wheel-scroll";
import type { TimelineDragData } from "@/timeline/drag";
import type {
	StickerBrowseSection,
	StickerCategory,
	StickerItem as StickerData,
} from "@/stickers";
import { useStickersStore } from "@/stickers/stickers-store";
import { cn } from "@/utils/ui";
import { AlertCircleIcon, HappyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** Grids with more tiles than this skip rendering while off screen. */
const LONG_GRID_ITEM_COUNT = 60;
/** The search runs this long after the last keystroke. */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * The element that scrolls the results. The "load the next part" marker
 * observes inside it: with the viewport as root a margin would do nothing for
 * a list inside a scroller.
 */
const ScrollRootContext = createContext<HTMLElement | null>(null);

export function StickersView() {
	const {
		browseContent,
		browseStickers,
		isBrowsing,
		isSearching,
		loadError,
		searchQuery,
		searchResults,
		searchStickers,
		selectedCategory,
		setSearchQuery,
		setSelectedCategory,
		viewMode,
	} = useStickersStore();

	const contentState = getContentState({
		viewMode,
		selectedCategory,
		isSearching,
		isBrowsing,
		loadError,
		hasSearchResults: Boolean(searchResults?.items.length),
		hasBrowseSections: Boolean(browseContent?.sections.length),
	});
	const statusMessage = getStatusMessage({
		state: contentState,
		viewMode,
		isSearching,
		total: searchResults?.total ?? 0,
		sectionCount: (browseContent?.sections ?? []).filter(
			(section) => !section.error,
		).length,
		hasSectionErrors: (browseContent?.sections ?? []).some(
			(section) => section.error,
		),
		loadError,
	});

	// The store starts a browse on every category change; this is only for the
	// first open (and never after a failure: Retry is the user's).
	useEffect(() => {
		if (
			shouldStartInitialBrowse({
				viewMode,
				hasBrowseContent: browseContent !== null,
				isBrowsing,
				loadError,
			})
		) {
			void browseStickers();
		}
	}, [browseContent, browseStickers, isBrowsing, loadError, viewMode]);

	const searchInput = useMemo(
		() =>
			createSearchInput({
				search: ({ query }) => void searchStickers({ query }),
				delayMs: SEARCH_DEBOUNCE_MS,
			}),
		[searchStickers],
	);
	// The panel closing must not lose what was typed: the search that is still
	// waiting runs, and the store keeps the result for the next time it opens.
	useEffect(() => () => searchInput.flushPending(), [searchInput]);

	const tabListRef = useRef<HTMLDivElement>(null);
	const focusActiveTabRef = useRef(false);

	// "See all" can switch to a tab that is scrolled out of view, and its
	// button disappears with the old tab: focus follows to the active tab.
	useEffect(() => {
		revealTab({
			tab: tabListRef.current?.querySelector<HTMLElement>(
				'[data-state="active"]',
			),
			takeFocus: focusActiveTabRef.current,
		});
		focusActiveTabRef.current = false;
	}, [selectedCategory]);

	// The bar has no visible scrollbar: the mouse wheel scrolls it sideways.
	useEffect(() => {
		const tabList = tabListRef.current;
		return tabList
			? attachHorizontalWheelScroll({ element: tabList })
			: undefined;
	}, []);

	// New results replace the old ones in place (the old ones stay on screen
	// while the search runs), so the scroll position has to be reset by hand.
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	useEffect(() => {
		scrollToTop({ element: scroller });
	}, [scroller, searchResults, selectedCategory]);

	const runSearch = ({ query }: { query: string }) => {
		setSearchQuery({ query });
		searchInput.input({ query });
	};

	return (
		<div className="flex h-full flex-col py-2">
			{/* The one live region: it stays in the page, so every change is announced. */}
			<div role="status" aria-live="polite" className="sr-only">
				{statusMessage}
			</div>
			<div className="px-2">
				<Input
					size="sm"
					variant="default"
					placeholder="Search..."
					aria-label="Search stickers"
					maxLength={MAX_QUERY_CHARS}
					value={searchQuery}
					onChange={(e) => runSearch({ query: e.target.value })}
					showClearIcon
					onClear={() => runSearch({ query: "" })}
					className="w-full"
					containerClassName="w-full"
				/>
			</div>

			<Tabs
				value={selectedCategory}
				onValueChange={(value) => {
					if (isStickerCategory(value)) {
						// The store searches the typed query in the new tab right away.
						searchInput.cancelPending();
						setSelectedCategory({ category: value });
					}
				}}
				variant="underline"
				className="mt-2 flex min-h-0 flex-1 flex-col"
			>
				<TabsList
					ref={tabListRef}
					aria-label="Sticker categories"
					// Five tabs can be wider than a narrow panel (the tools panel goes
					// down to 15% of the window): scroll sideways, no visible bar.
					// Scrolling clips the trigger's -mb-px overlap of the list border,
					// which would thin the active underline, so the grey line moves
					// inside the scroller as an inset shadow (pixel-identical). The
					// scroller also clips the focus ring, so it is drawn inset.
					className="scrollbar-hidden overflow-x-auto overflow-y-hidden border-b-0 pb-px [box-shadow:inset_0_-1px_0_0_var(--border)]"
				>
					{Object.entries(STICKER_CATEGORIES).map(([key, label]) => (
						<TabsTrigger
							key={key}
							value={key}
							className="shrink-0 focus-visible:ring-inset focus-visible:ring-offset-0"
						>
							{label}
						</TabsTrigger>
					))}
				</TabsList>
				{/* The scroller is the tab panel: the active tab's aria-controls points at it, and it can be focused to scroll with the keyboard. */}
				<TabsContent
					value={selectedCategory}
					ref={setScroller}
					className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 focus-visible:ring-inset focus-visible:ring-offset-0"
				>
					<ScrollRootContext.Provider value={scroller}>
						<StickersContentView
							state={contentState}
							onSeeAll={(category) => {
								// The store searches the typed query in the new tab itself.
								searchInput.cancelPending();
								focusActiveTabRef.current = true;
								setSelectedCategory({ category });
							}}
						/>
					</ScrollRootContext.Provider>
				</TabsContent>
			</Tabs>
		</div>
	);
}

function StickerGrid({
	items,
	shouldCapSize = false,
}: {
	items: StickerData[];
	shouldCapSize?: boolean;
}) {
	const gridStyle: CSSProperties & {
		"--sticker-min": string;
		"--sticker-max"?: string;
	} = {
		gridTemplateColumns: shouldCapSize
			? "repeat(auto-fill, minmax(var(--sticker-min, 80px), var(--sticker-max, 140px)))"
			: "repeat(auto-fill, minmax(var(--sticker-min, 80px), 1fr))",
		"--sticker-min": "80px",
		...(shouldCapSize ? { "--sticker-max": "140px" } : {}),
	};

	return (
		<div
			className={cn(
				"grid gap-2",
				// A long grid (a whole emoji group) is not laid out or painted while
				// it is off screen; `auto` then remembers its real height, so the
				// scroll position stays put. Short grids would get a placeholder
				// taller than themselves, so they are left alone.
				items.length > LONG_GRID_ITEM_COUNT &&
					"[content-visibility:auto] [contain-intrinsic-block-size:auto_600px]",
			)}
			style={gridStyle}
		>
			{items.map((item) => (
				<StickerItem key={item.id} item={item} shouldCapSize={shouldCapSize} />
			))}
		</div>
	);
}

/**
 * A long list drawn in parts: the first PROGRESSIVE_INITIAL_COUNT tiles, then
 * more each time the marker after the last tile scrolls near the viewport.
 * Mounting 2,000 tiles at once is about 22,000 DOM nodes; the list stays
 * complete (every item is reached by scrolling) and the tiles already drawn
 * are not redrawn, because they are the same memoised items.
 */
export function ProgressiveStickerGrid({ items }: { items: StickerData[] }) {
	const [state, setState] = useState({
		source: items,
		count: PROGRESSIVE_INITIAL_COUNT,
	});
	// A new list (a new search) starts over from the first part.
	const count =
		state.source === items ? state.count : PROGRESSIVE_INITIAL_COUNT;
	const hasMore = count < items.length;
	const root = useContext(ScrollRootContext);
	const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);

	// Recreated after every part: a fresh observer reports the marker's state
	// at once, so a tall window keeps drawing until the marker is out of reach.
	useEffect(() => {
		if (!sentinel || !hasMore) {
			return;
		}
		return observeSentinel({
			element: sentinel,
			root,
			onVisible: () =>
				setState((previous) => ({
					source: items,
					count: revealMore({
						visible:
							previous.source === items
								? previous.count
								: PROGRESSIVE_INITIAL_COUNT,
						total: items.length,
					}),
				})),
		});
	}, [sentinel, hasMore, count, items, root]);

	return (
		<>
			<StickerGrid items={items.slice(0, count)} />
			{hasMore && (
				<div
					ref={setSentinel}
					data-sticker-sentinel
					aria-hidden="true"
					className="h-px"
				/>
			)}
		</>
	);
}

function StickerRow({ items }: { items: StickerData[] }) {
	return (
		<div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hidden">
			{items.map((item) => (
				<div key={item.id} className="w-20 shrink-0">
					<StickerItem item={item} shouldCapSize containerClassName="w-full" />
				</div>
			))}
		</div>
	);
}

function EmptyView({ message }: { message: string }) {
	return (
		<div className="bg-background flex h-full flex-col items-center justify-center gap-3 p-4">
			<HugeiconsIcon
				icon={HappyIcon}
				className="text-muted-foreground size-10"
			/>
			<div className="flex flex-col gap-2 text-center">
				<p className="text-lg font-medium">No stickers found</p>
				<p className="text-muted-foreground text-sm text-balance">{message}</p>
			</div>
		</div>
	);
}

/** A catalog that could not be loaded is not "no stickers": say so, and offer Retry. */
export function LoadErrorView({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div
			role="alert"
			className="bg-background flex h-full flex-col items-center justify-center gap-3 p-4"
		>
			<HugeiconsIcon
				icon={AlertCircleIcon}
				className="text-muted-foreground size-10"
			/>
			<div className="flex flex-col gap-2 text-center">
				<p className="text-lg font-medium">{"Couldn't load stickers"}</p>
				<p className="text-muted-foreground text-sm text-balance">{message}</p>
			</div>
			<Button onClick={onRetry}>Retry</Button>
		</div>
	);
}

function SectionError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	// Not an alert: a row per failed category would be several alerts at once.
	// The live region announces that some stickers could not be loaded, and
	// Retry runs the whole load again, which is what its label says.
	return (
		<div className="border-border flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
			<p className="text-muted-foreground text-xs">{message}</p>
			<Button
				variant="text"
				size="sm"
				className="h-auto shrink-0 p-0 text-xs text-primary"
				aria-label="Retry loading stickers"
				onClick={onRetry}
			>
				Retry
			</Button>
		</div>
	);
}

function RegionBanner({ region }: { region: string }) {
	return (
		<div className="flex h-7 items-center gap-1.5 rounded-lg border border-sky-100 bg-sky-50 px-2">
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="shrink-0 text-sky-600"
				aria-hidden="true"
			>
				<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
				<circle cx="12" cy="10" r="3" />
			</svg>
			<span className="text-xs font-semibold text-sky-600">{region}</span>
		</div>
	);
}

/**
 * The results of a category search: the count and the grid. While a new search
 * runs the old results stay (a spinner would tear a 2,000-tile grid down and
 * mount it again), dimmed and marked busy. The count is plain text: the
 * picker's one live region announces it.
 */
export function SearchResultsView({
	results,
	regionLabel,
	isSearching,
}: {
	results: { items: StickerData[]; total: number };
	regionLabel: string | null;
	isSearching: boolean;
}) {
	return (
		<div
			aria-busy={isSearching}
			className={cn("flex flex-col gap-3 pb-4", isSearching && "opacity-60")}
		>
			{regionLabel && <RegionBanner region={regionLabel} />}
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground text-sm">
					{formatResultCount({ total: results.total })}
				</span>
			</div>
			<ProgressiveStickerGrid items={results.items} />
		</div>
	);
}

function StickersContentView({
	state,
	onSeeAll,
}: {
	state: ContentState;
	onSeeAll: (category: StickerCategory) => void;
}) {
	const {
		browseContent,
		clearRecentStickers,
		isSearching,
		loadError,
		retryLoad,
		searchedQuery,
		searchResults,
		selectedCategory,
		viewMode,
	} = useStickersStore();

	switch (state) {
		case "error":
			return (
				<LoadErrorView
					message={loadError ?? "Something went wrong."}
					onRetry={() => void retryLoad()}
				/>
			);

		case "spinner":
			return (
				<div className="flex items-center justify-center py-8">
					<Spinner className="text-muted-foreground size-6" />
				</div>
			);

		case "results": {
			// The label belongs to the results on screen, not to the text now in the box.
			const normalizedQuery = searchedQuery.trim().toLowerCase();
			const isRegionSearch =
				selectedCategory === "flags" &&
				resolveQueryToRegions({ query: normalizedQuery }) !== null;
			return (
				<SearchResultsView
					results={{
						items: searchResults?.items ?? [],
						total: searchResults?.total ?? 0,
					}}
					regionLabel={
						isRegionSearch ? getRegionLabel({ query: normalizedQuery }) : null
					}
					isSearching={isSearching}
				/>
			);
		}

		case "sections":
			return (
				<div
					aria-busy={isSearching}
					className={cn("flex flex-col gap-4 pb-4", isSearching && "opacity-60")}
				>
					{(browseContent?.sections ?? []).map((section) => (
						<StickerSection
							key={section.id}
							section={section}
							onClearRecent={clearRecentStickers}
							onSeeAll={onSeeAll}
							onRetry={() => void retryLoad()}
						/>
					))}
				</div>
			);

		case "no-results":
		case "empty":
			return (
				<EmptyView
					message={getEmptyMessage({ viewMode, selectedCategory, searchedQuery })}
				/>
			);
	}
}

export function StickerSection({
	section,
	onClearRecent,
	onSeeAll,
	onRetry,
}: {
	section: StickerBrowseSection;
	onClearRecent: () => void;
	onSeeAll: (category: StickerCategory) => void;
	onRetry: () => void;
}) {
	const hasHeader =
		Boolean(section.title) || section.id === "recent" || section.action;

	return (
		<div className="flex flex-col gap-2">
			{hasHeader && (
				<div className="flex items-center justify-between gap-2">
					{section.title ? (
						<p className="text-xs text-muted-foreground">{section.title}</p>
					) : (
						<div />
					)}

					<div className="ml-auto flex items-center gap-2">
						{section.id === "recent" && (
							<Button
								onClick={onClearRecent}
								variant="text"
								size="sm"
								className="h-auto gap-1 p-0 text-xs text-muted-foreground"
								aria-label={section.title ? `Clear ${section.title}` : "Clear"}
							>
								Clear
							</Button>
						)}

						{section.action?.type === "see-all" && section.action.category && (
							<Button
								variant="text"
								size="sm"
								className="h-auto gap-1 p-0 text-xs text-primary"
								aria-label={
									section.title ? `See all ${section.title}` : "See all"
								}
								onClick={() => {
									if (section.action?.category) {
										onSeeAll(section.action.category);
									}
								}}
							>
								See all
							</Button>
						)}
					</div>
				</div>
			)}

			{section.error ? (
				<SectionError message={section.error} onRetry={onRetry} />
			) : section.layout === "row" ? (
				<StickerRow items={section.items} />
			) : (
				<ProgressiveStickerGrid items={section.items} />
			)}
		</div>
	);
}

interface StickerItemProps {
	item: StickerData;
	shouldCapSize?: boolean;
	containerClassName?: string;
}

// memo + a one-field store selector: the Emoji and Icons tabs render well over a
// thousand tiles, and a tile must not re-render (DraggableItem allocates an
// Image per render) every time the search box or the store changes.
const StickerItem = memo(function StickerItem({
	item,
	shouldCapSize = false,
	containerClassName,
}: StickerItemProps) {
	const editor = useEditor();
	const addToRecentStickers = useStickersStore(
		(state) => state.addToRecentStickers,
	);
	const [isAdding, setIsAdding] = useState(false);
	// The component remounts for another sticker (the grids key tiles by id),
	// so the error state needs no reset.
	const [hasImageError, setHasImageError] = useState(false);
	const [addFlight] = useState(createSingleFlight);

	const displayName = item.name;
	const shapePreset =
		item.provider === "shapes" ? parseShapeStickerId({ stickerId: item.id }) : null;

	// Enter pressed twice while a slow image loads must add one element.
	const handleAdd = createAddHandler({
		flight: addFlight,
		add: () =>
			addSticker({
				item,
				shapePreset,
				editor,
				addToRecent: addToRecentStickers,
			}),
		onError: ({ error }) => {
			console.error("Failed to add sticker:", error);
			toast.error("Failed to add sticker to timeline");
		},
		onBusyChange: ({ busy }) => setIsAdding(busy),
	});

	const preview = (
		<div className="flex size-full items-center justify-center p-3">
			{hasImageError ? (
				<span className="text-muted-foreground text-center text-xs break-all">
					{displayName}
				</span>
			) : (
				<Image
					src={item.previewUrl}
					alt={displayName}
					width={64}
					height={64}
					className={cn(
						"size-full object-contain",
						// Icons are drawn white (stickers have no tint); flip them to
						// black on the light card so the thumbnail stays visible. The
						// inserted sticker itself stays white.
						item.provider === "icons" && "invert dark:invert-0",
					)}
					style={
						shouldCapSize
							? {
									maxWidth: "var(--sticker-max, 160px)",
									maxHeight: "var(--sticker-max, 160px)",
								}
							: undefined
					}
					onError={() => setHasImageError(true)}
					loading="lazy"
					unoptimized
				/>
			)}
		</div>
	);

	const dragData: TimelineDragData = shapePreset
		? {
				id: item.id,
				type: "graphic",
				name: displayName,
				definitionId: shapePreset.definitionId,
				params: shapePreset.params ?? {},
			}
		: {
				id: item.id,
				type: "sticker",
				name: displayName,
				stickerId: item.id,
			};

	return (
		<div
			className={cn("relative", isAdding && "pointer-events-none opacity-50")}
		>
			<DraggableItem
				name={displayName}
				preview={preview}
				dragData={dragData}
				onAddToTimeline={() => void handleAdd()}
				aspectRatio={1}
				shouldShowLabel={false}
				isRounded
				variant="card"
				containerClassName={containerClassName ?? "w-full"}
			/>
			{isAdding && (
				<div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/60">
					<Spinner className="size-6 text-white" />
				</div>
			)}
		</div>
	);
});
