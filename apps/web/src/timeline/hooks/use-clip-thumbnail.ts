import { useEffect, useState } from "react";
import type { MediaAsset } from "@/media/types";
import { getClipThumbnail } from "@/timeline/clip-thumbnails";
import type { ImageElement, VideoElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";

/**
 * The picture of the clip's own first frame (its trim start inside the source
 * file). The asset's single thumbnail is a frame from the file's first seconds,
 * which is a black title card for many files, so every clip cut from them
 * looked black. Null until decoded or when the file cannot be read: the caller
 * keeps the asset thumbnail meanwhile.
 */
export function useClipThumbnail({
	asset,
	element,
}: {
	asset: MediaAsset | undefined;
	element: VideoElement | ImageElement;
}): string | null {
	const assetId = asset?.id;
	const file =
		element.type === "video" && asset?.type === "video" ? asset.file : null;
	const seconds = element.trimStart / TICKS_PER_SECOND;
	const key = assetId && file ? `${assetId}:${seconds}` : null;
	const [loaded, setLoaded] = useState<{
		key: string;
		url: string | null;
	} | null>(null);

	useEffect(() => {
		if (!key || !assetId || !file) return;
		let current = true;
		void getClipThumbnail({ assetId, file, seconds }).then((url) => {
			if (current) setLoaded({ key, url });
		});
		return () => {
			current = false;
		};
	}, [key, assetId, file, seconds]);

	return loaded && loaded.key === key ? loaded.url : null;
}
