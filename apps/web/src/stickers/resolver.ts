import { stickersRegistry, type StickersRegistry } from "./registry";
import { parseStickerId } from "./sticker-id";
import { registerDefaultStickerProviders } from "./providers";
import { assertSafeStickerUrl } from "./url-guard";
import { describeError, describeId } from "./describe-id";
import type { StickerResolveOptions } from "@/stickers/types";

export function resolveStickerId({
	stickerId,
	options,
	registry,
}: {
	stickerId: unknown;
	options?: StickerResolveOptions;
	/** Tests pass their own; the app uses the default providers' registry. */
	registry?: StickersRegistry;
}): string {
	// Saved projects are not typed: anything can arrive here.
	if (typeof stickerId !== "string") {
		throw new Error(
			`Sticker id must be a string, got ${describeId({ value: stickerId })}`,
		);
	}
	if (!registry) {
		registerDefaultStickerProviders();
	}

	const parsedStickerId = parseStickerId({ stickerId });
	const url = (registry ?? stickersRegistry).get(parsedStickerId.providerId).resolveUrl({
		stickerId,
		options,
	});
	return assertSafeStickerUrl({ url, stickerId });
}

/** Bound on distinct warnings: a project full of bad ids must not grow memory or flood the log. */
const MAX_WARNED_IDS = 500;
const warnedUnresolvableIds = new Set<string>();

/** Forgets which ids were warned about. For tests: the memory is process-wide, so one test's warnings would use up another's. */
export function resetUnresolvableWarnings(): void {
	warnedUnresolvableIds.clear();
}

/**
 * `resolveStickerId` for places that draw (a timeline thumbnail): an id that
 * cannot be resolved (an old or hand-edited project, a provider that is gone,
 * a refused URL, a value that is not even a string) gives null instead of
 * throwing, so one bad element cannot take the whole editor down. Warns once
 * per id (per kind, for values that are not strings), in one short line.
 */
export function safeResolveStickerId({
	stickerId,
	options,
}: {
	stickerId: unknown;
	options?: StickerResolveOptions;
}): string | null {
	try {
		return resolveStickerId({ stickerId, options });
	} catch (error) {
		const label = describeId({ value: stickerId });
		if (
			!warnedUnresolvableIds.has(label) &&
			warnedUnresolvableIds.size < MAX_WARNED_IDS
		) {
			warnedUnresolvableIds.add(label);
			console.warn(
				`Sticker id "${label}" cannot be resolved: ${describeError({ error })}`,
			);
		}
		return null;
	}
}
