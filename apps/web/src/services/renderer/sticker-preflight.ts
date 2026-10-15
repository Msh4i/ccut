import { describeId } from "@/stickers/describe-id";
import { loadStickerSource } from "./nodes/sticker-node";

/** A sticker that could not be loaded, and the names of the timeline elements that use it. */
export interface UnloadableSticker {
	stickerId: string;
	names: string[];
}

interface StickerTrackLike {
	hidden?: boolean;
	elements: readonly {
		type: string;
		name?: unknown;
		hidden?: boolean;
		stickerId?: unknown;
	}[];
}

/** The part of the scene's tracks that the preflight reads. */
export interface StickerTracksLike {
	overlay: readonly StickerTrackLike[];
	main: StickerTrackLike;
}

type StickerLoader = ({ stickerId }: { stickerId: string }) => Promise<unknown>;

/** What the export would try to draw. Retry at once: see `assertStickersLoadable`. */
const loadForExport: StickerLoader = ({ stickerId }) =>
	loadStickerSource({ stickerId, retry: "now" });

/** Longest list of names in the error message; the rest is counted. */
const MAX_NAMES_IN_ERROR = 5;

/**
 * Every distinct sticker the export would draw, with the names of its
 * elements. Hidden elements and hidden tracks are left out, as the scene
 * builder leaves them out.
 */
export function collectStickers({
	tracks,
}: {
	tracks: StickerTracksLike;
}): UnloadableSticker[] {
	const found = new Map<string, string[]>();

	for (const track of [...tracks.overlay, tracks.main]) {
		if (track.hidden) {
			continue;
		}
		for (const element of track.elements) {
			if (element.type !== "sticker" || element.hidden) {
				continue;
			}
			// A damaged project can hold anything here. A value that is not a
			// string is listed under its type ("<undefined>"), which no provider
			// can load, so it is reported like any sticker that cannot be loaded.
			const key =
				typeof element.stickerId === "string"
					? element.stickerId
					: describeId({ value: element.stickerId });
			const name = typeof element.name === "string" ? element.name : "";
			const names = found.get(key) ?? [];
			if (name !== "" && !names.includes(name)) {
				names.push(name);
			}
			found.set(key, names);
		}
	}

	return [...found].map(([stickerId, names]) => ({ stickerId, names }));
}

/** The stickers of the timeline that cannot be loaded; all are tried at the same time. */
export async function findUnloadableStickers({
	tracks,
	load = loadForExport,
}: {
	tracks: StickerTracksLike;
	load?: StickerLoader;
}): Promise<UnloadableSticker[]> {
	const stickers = collectStickers({ tracks });
	const outcomes = await Promise.allSettled(
		stickers.map(({ stickerId }) => load({ stickerId })),
	);
	return stickers.filter((_, index) => outcomes[index].status === "rejected");
}

export function formatStickerExportError({
	failed,
}: {
	failed: UnloadableSticker[];
}): string {
	const names = [
		...new Set(
			failed.flatMap(({ stickerId, names: elementNames }) =>
				(elementNames.length > 0 ? elementNames : [stickerId]).map((name) =>
					describeId({ value: name }),
				),
			),
		),
	];
	const shown = names
		.slice(0, MAX_NAMES_IN_ERROR)
		.map((name) => `"${name}"`)
		.join(", ");
	const hidden = names.length - MAX_NAMES_IN_ERROR;
	const list = hidden > 0 ? `${shown} and ${hidden} more` : shown;

	return names.length === 1
		? `Sticker ${list} could not be loaded. Remove it or re-add it.`
		: `Stickers ${list} could not be loaded. Remove them or re-add them.`;
}

/**
 * Export preflight: every sticker on the timeline is loaded before anything
 * else happens, and one that cannot be loaded stops the export with an error
 * that names it (an image that cannot be loaded does the same). The load
 * retries at once instead of trusting an earlier preview failure, so a
 * sticker that works again is not refused; the loaded images then stay cached,
 * which is why the frames of the export need no further requests.
 */
export async function assertStickersLoadable({
	tracks,
	load,
}: {
	tracks: StickerTracksLike;
	load?: StickerLoader;
}): Promise<void> {
	const failed = await findUnloadableStickers({ tracks, load });
	if (failed.length > 0) {
		throw new Error(formatStickerExportError({ failed }));
	}
}

/** How often the cancel flag is looked at while the stickers load (the same as during the encode). */
const CANCEL_POLL_MS = 100;

/**
 * `assertStickersLoadable` that listens for Cancel. A sticker that never
 * answers keeps the preflight waiting up to the load timeout (10 s), and the
 * encode's own cancel check does not exist yet at this point, so without this
 * Cancel would do nothing for that long.
 *
 * - "cancelled": the user cancelled, before or during the loads. Nothing more
 *   is waited for (a load still in flight finishes, or fails, on its own; its
 *   failure is handled and goes nowhere).
 * - "ready": every sticker loaded.
 * - throws: a sticker could not be loaded and the user had not cancelled. A
 *   cancel that came in while it failed wins: the user asked to stop, an error
 *   about a sticker would be the wrong answer.
 */
export async function preflightStickers({
	tracks,
	load,
	isCancelled,
	pollMs = CANCEL_POLL_MS,
}: {
	tracks: StickerTracksLike;
	load?: StickerLoader;
	isCancelled?: () => boolean;
	pollMs?: number;
}): Promise<"ready" | "cancelled"> {
	if (!isCancelled) {
		await assertStickersLoadable({ tracks, load });
		return "ready";
	}
	if (isCancelled()) {
		return "cancelled";
	}

	let timer: ReturnType<typeof setInterval> | undefined;
	const cancelled = new Promise<"cancelled">((resolve) => {
		timer = setInterval(() => {
			if (isCancelled()) {
				resolve("cancelled");
			}
		}, pollMs);
	});
	const loaded = assertStickersLoadable({ tracks, load }).then(
		() => "ready" as const,
	);

	try {
		return await Promise.race([loaded, cancelled]);
	} catch (error) {
		if (isCancelled()) {
			return "cancelled";
		}
		throw error;
	} finally {
		clearInterval(timer);
	}
}
