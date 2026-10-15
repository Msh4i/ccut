import { resolveStickerId } from "@/stickers";
import { describeError, describeId } from "@/stickers/describe-id";
import { STICKER_LOAD_TIMEOUT_MS, loadImage } from "@/stickers/image-load";
import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface StickerNodeParams extends VisualNodeParams {
	stickerId: string;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
}

interface CachedStickerSource {
	source: HTMLImageElement;
	width: number;
	height: number;
}

/**
 * How long a failed sticker is left alone before its next load attempt. A
 * failure must not stick for the session (a transient problem would hide the
 * sticker until reload), but retrying on every frame of a playing timeline
 * would repeat a failing request thousands of times.
 */
export const STICKER_RETRY_AFTER_MS = 5_000;

/**
 * What `loadStickerSource` does about a sticker that failed before:
 *  - "after-delay": reject until STICKER_RETRY_AFTER_MS has passed, then retry;
 *  - "never": reject with the stored failure (export: no timer decides the
 *    output, so two exports of the same project give the same result);
 *  - "now": retry at once (the export preflight must really try again).
 */
export type StickerRetryMode = "after-delay" | "never" | "now";

interface StickerFailure {
	at: number;
	error: Error;
}

const stickerSourceCache = new Map<string, Promise<CachedStickerSource>>();
const stickerFailures = new Map<string, StickerFailure>();
const warnedStickerIds = new Set<string>();
const backgroundRetries = new Set<string>();

function startLoad({
	stickerId,
	timeoutMs,
}: {
	stickerId: string;
	timeoutMs: number;
}): Promise<CachedStickerSource> {
	const promise = (async (): Promise<CachedStickerSource> => {
		const url = resolveStickerId({
			stickerId,
			options: { width: 200, height: 200 },
		});

		try {
			const image = await loadImage({ url, timeoutMs });
			return {
				source: image,
				width: image.naturalWidth,
				height: image.naturalHeight,
			};
		} catch (reason) {
			const message =
				reason instanceof Error && reason.message.startsWith("Timed out")
					? `Failed to load sticker: ${describeId({ value: stickerId })} (${reason.message})`
					: `Failed to load sticker: ${describeId({ value: stickerId })}`;
			throw new Error(message, { cause: reason });
		}
	})();

	stickerSourceCache.set(stickerId, promise);
	promise.then(
		() => {
			stickerFailures.delete(stickerId);
		},
		(error: unknown) => {
			if (stickerSourceCache.get(stickerId) === promise) {
				stickerSourceCache.delete(stickerId);
			}
			stickerFailures.set(stickerId, {
				at: Date.now(),
				error: error instanceof Error ? error : new Error(String(error)),
			});
		},
	);
	return promise;
}

export function loadStickerSource({
	stickerId,
	retry = "after-delay",
	timeoutMs = STICKER_LOAD_TIMEOUT_MS,
}: {
	stickerId: string;
	retry?: StickerRetryMode;
	timeoutMs?: number;
}): Promise<CachedStickerSource> {
	const failure = stickerFailures.get(stickerId);
	if (failure) {
		const isDue =
			retry === "now" ||
			(retry === "after-delay" &&
				Date.now() - failure.at >= STICKER_RETRY_AFTER_MS);
		if (!isDue) {
			return Promise.reject(failure.error);
		}
	}

	// Loaded already, or a load (the first one, or a retry) in flight: share it.
	return (
		stickerSourceCache.get(stickerId) ?? startLoad({ stickerId, timeoutMs })
	);
}

function startBackgroundRetry({
	stickerId,
	timeoutMs,
}: {
	stickerId: string;
	timeoutMs?: number;
}): void {
	if (backgroundRetries.has(stickerId)) {
		return;
	}
	backgroundRetries.add(stickerId);
	loadStickerSource({ stickerId, retry: "now", timeoutMs })
		.catch(() => {
			// recorded as a new failure by startLoad; the next frames see null
		})
		.finally(() => {
			backgroundRetries.delete(stickerId);
		});
}

function warnOnce({
	stickerId,
	error,
}: {
	stickerId: unknown;
	error: unknown;
}): void {
	// Keyed by the short label: bounded, and one line per kind of bad id.
	const label = describeId({ value: stickerId });
	if (warnedStickerIds.has(label)) {
		return;
	}
	warnedStickerIds.add(label);
	console.warn(
		`Sticker "${label}" could not be loaded and is skipped: ${describeError({ error })}`,
	);
}

/**
 * The sticker's source for a preview frame, or null when it cannot be loaded
 * (so the renderer skips that sticker and still draws the frame). Warns once
 * per sticker id. A failed sticker is retried in the background once the retry
 * delay has passed; the frame never waits for that retry (a request that never
 * answers would otherwise freeze the preview), it gets null and a later frame
 * gets the sticker.
 */
export async function loadStickerSourceOrNull({
	stickerId,
	timeoutMs,
}: {
	stickerId: string;
	/** How long an image may take; tests shorten it. */
	timeoutMs?: number;
}): Promise<CachedStickerSource | null> {
	const failure = stickerFailures.get(stickerId);
	if (failure) {
		if (Date.now() - failure.at >= STICKER_RETRY_AFTER_MS) {
			startBackgroundRetry({ stickerId, timeoutMs });
		}
		warnOnce({ stickerId, error: failure.error });
		return null;
	}

	try {
		return await loadStickerSource({ stickerId, timeoutMs });
	} catch (error) {
		warnOnce({ stickerId, error });
		return null;
	}
}

export class StickerNode extends VisualNode<
	StickerNodeParams,
	ResolvedVisualSourceNodeState
> {}
