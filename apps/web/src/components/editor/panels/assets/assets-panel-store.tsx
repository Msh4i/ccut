import type { ElementType } from "react";
import { create } from "zustand";
import { type PersistStorage, persist } from "zustand/middleware";
import {
	ClosedCaptionIcon,
	FilterIcon,
	Folder03Icon,
	Happy01Icon,
	HeadphonesIcon,
	MagicWand05Icon,
	TextIcon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export const TAB_KEYS = [
	"media",
	"sounds",
	"text",
	"stickers",
	"effects",
	"filters",
	"captions",
	"settings",
] as const;

export type Tab = (typeof TAB_KEYS)[number];

/**
 * Tabs shown in a build. Sounds is only the online Freesound library (and the
 * sounds saved from it), which the desktop app cannot reach: hide it there
 * instead of showing a panel that only errors.
 */
export function getVisibleTabKeys({
	isDesktop,
}: {
	isDesktop: boolean;
}): readonly Tab[] {
	return isDesktop ? TAB_KEYS.filter((key) => key !== "sounds") : TAB_KEYS;
}

export const VISIBLE_TAB_KEYS = getVisibleTabKeys({
	isDesktop: process.env.NEXT_PUBLIC_DESKTOP === "1",
});

const createHugeiconsIcon =
	({ icon }: { icon: IconSvgElement }) =>
	({ className }: { className?: string }) => (
		<HugeiconsIcon icon={icon} className={className} />
	);

export const tabs = {
	media: {
		icon: createHugeiconsIcon({ icon: Folder03Icon }),
		label: "Media",
	},
	sounds: {
		icon: createHugeiconsIcon({ icon: HeadphonesIcon }),
		label: "Sounds",
	},
	text: {
		icon: createHugeiconsIcon({ icon: TextIcon }),
		label: "Text",
	},
	stickers: {
		icon: createHugeiconsIcon({ icon: Happy01Icon }),
		label: "Stickers",
	},
	effects: {
		icon: createHugeiconsIcon({ icon: MagicWand05Icon }),
		label: "Effects",
	},
	filters: {
		icon: createHugeiconsIcon({ icon: FilterIcon }),
		label: "Filters",
	},
	captions: {
		icon: createHugeiconsIcon({ icon: ClosedCaptionIcon }),
		label: "Captions",
	},
	settings: {
		icon: createHugeiconsIcon({ icon: Settings01Icon }),
		label: "Settings",
	},
} satisfies Record<
	Tab,
	{ icon: ElementType<{ className?: string }>; label: string }
>;

export type MediaViewMode = "grid" | "list";
export type MediaSortKey = "name" | "type" | "duration" | "size";
export type MediaSortOrder = "asc" | "desc";

interface AssetsPanelStore {
	activeTab: Tab;
	setActiveTab: (tab: Tab) => void;
	highlightMediaId: string | null;
	requestRevealMedia: (mediaId: string) => void;
	clearHighlight: () => void;

	/* Media */
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	mediaSortBy: MediaSortKey;
	mediaSortOrder: MediaSortOrder;
	setMediaSort: (args: { key: MediaSortKey; order: MediaSortOrder }) => void;
}

/** What survives a reload: the media view settings, never the active tab. */
export type PersistedAssetsPanelState = Pick<
	AssetsPanelStore,
	"mediaViewMode" | "mediaSortBy" | "mediaSortOrder"
>;

/**
 * Creates the store. Without `storage` it persists to the browser's
 * localStorage (zustand's default, bound when the store is created); tests
 * pass an in-memory storage so they do not depend on whether a `window`
 * existed when this module was first imported.
 */
export function createAssetsPanelStore({
	storage,
}: {
	storage?: PersistStorage<PersistedAssetsPanelState>;
} = {}) {
	return create<AssetsPanelStore>()(
		persist(
			(set) => ({
				activeTab: "media",
				setActiveTab: (tab) => set({ activeTab: tab }),
				highlightMediaId: null,
				requestRevealMedia: (mediaId) =>
					set({ activeTab: "media", highlightMediaId: mediaId }),
				clearHighlight: () => set({ highlightMediaId: null }),
				mediaViewMode: "grid",
				setMediaViewMode: (mode) => set({ mediaViewMode: mode }),
				mediaSortBy: "name",
				mediaSortOrder: "asc",
				setMediaSort: ({ key, order }) =>
					set({ mediaSortBy: key, mediaSortOrder: order }),
			}),
			{
				name: "assets-panel",
				partialize: (state): PersistedAssetsPanelState => ({
					mediaViewMode: state.mediaViewMode,
					mediaSortBy: state.mediaSortBy,
					mediaSortOrder: state.mediaSortOrder,
				}),
				// Only when given: an explicit `storage: undefined` would replace
				// zustand's default and turn persistence off.
				...(storage ? { storage } : {}),
			},
		),
	);
}

export const useAssetsPanelStore = createAssetsPanelStore();
