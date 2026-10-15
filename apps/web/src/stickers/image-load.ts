/** A sticker image that has not answered after this long counts as failed. */
export const STICKER_LOAD_TIMEOUT_MS = 10_000;

/** The part of an <img> that loading uses (a test passes a fake). */
export interface ImageLike {
	onload: ((event: Event) => void) | null;
	onerror: ((event: Event) => void) | null;
	src: string;
}

/**
 * Loads `url` into an <img>. Rejects on an error event or after `timeoutMs`
 * (a stalled request would otherwise block a render frame, or an add, for
 * ever). Whatever the outcome, no handler or timer is left behind; on a
 * timeout the request is also cancelled.
 */
export function loadImage({
	url,
	timeoutMs,
}: {
	url: string;
	timeoutMs?: number;
}): Promise<HTMLImageElement>;
export function loadImage<T extends ImageLike>({
	url,
	timeoutMs,
	createImage,
}: {
	url: string;
	timeoutMs?: number;
	createImage: () => T;
}): Promise<T>;
export function loadImage({
	url,
	timeoutMs = STICKER_LOAD_TIMEOUT_MS,
	createImage = () => new Image(),
}: {
	url: string;
	timeoutMs?: number;
	createImage?: () => ImageLike;
}): Promise<ImageLike> {
	return new Promise<ImageLike>((resolve, reject) => {
		const image = createImage();

		function settle() {
			clearTimeout(timer);
			image.onload = null;
			image.onerror = null;
		}

		const timer = setTimeout(() => {
			settle();
			image.src = ""; // stop the request
			reject(new Error(`Timed out loading image after ${timeoutMs} ms`));
		}, timeoutMs);

		image.onload = () => {
			settle();
			resolve(image);
		};
		image.onerror = () => {
			settle();
			reject(new Error("Failed to load image"));
		};

		image.src = url;
	});
}
