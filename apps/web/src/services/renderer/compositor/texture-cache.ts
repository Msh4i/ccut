/**
 * Cache rule for external layer textures (decoded frames, images, stickers).
 *
 * A source object is only a valid cache key if its pixels never change while the
 * object stays the same. Video frames break that: the decoder hands them out in
 * a small pool of canvases (`CANVAS_POOL_SIZE` in services/video-cache) and
 * redraws them with later frames, so the same canvas object comes back holding a
 * different frame. Those sources carry a `version` (the frame's timestamp) that
 * changes with the pixels; sources that never change leave it undefined.
 */
export type ExternalTextureKey<TSource = CanvasImageSource> = {
	source: TSource;
	width: number;
	height: number;
	version: number | undefined;
};

export function isExternalTextureCurrent<TSource>({
	previous,
	next,
}: {
	previous: ExternalTextureKey<TSource> | undefined;
	next: ExternalTextureKey<TSource>;
}): boolean {
	return (
		previous !== undefined &&
		previous.source === next.source &&
		previous.width === next.width &&
		previous.height === next.height &&
		previous.version === next.version
	);
}
