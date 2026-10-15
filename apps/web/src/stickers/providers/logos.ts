import { describeId } from "../describe-id";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "../types";

const LOGOS_PROVIDER_ID = "logos";

const EMPTY_SEARCH_RESULT: StickerSearchResult = {
	items: [] as StickerItem[],
	total: 0,
	hasMore: false,
};

const EMPTY_BROWSE_RESULT: StickerBrowseResult = {
	sections: [],
};

export const logosProvider: StickerProvider = {
	id: LOGOS_PROVIDER_ID,
	async search(): Promise<StickerSearchResult> {
		return EMPTY_SEARCH_RESULT;
	},
	async browse(): Promise<StickerBrowseResult> {
		return EMPTY_BROWSE_RESULT;
	},
	resolveUrl({ stickerId }: { stickerId: string }): string {
		// The id used to be returned as the URL, which made "logos:/../api/health"
		// a same-origin request. There are no logo stickers (the tab is disabled).
		throw new Error(`The logos provider has no stickers: "${describeId({ value: stickerId })}"`);
	},
};
