/** A 1x1 transparent GIF: the drag ghost, because the tile draws its own preview. */
const EMPTY_DRAG_IMAGE_SOURCE =
	"data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=";

let emptyDragImage: HTMLImageElement | null = null;

/**
 * The shared, invisible drag image. Created on first use and then reused by
 * every tile: it used to be created on every render of every tile. Null on a
 * server (nothing is cached then, so a browser still gets one later).
 */
export function getEmptyDragImage(): HTMLImageElement | null {
	if (emptyDragImage) {
		return emptyDragImage;
	}
	if (typeof window === "undefined") {
		return null;
	}
	const image = new window.Image();
	image.src = EMPTY_DRAG_IMAGE_SOURCE;
	emptyDragImage = image;
	return emptyDragImage;
}
