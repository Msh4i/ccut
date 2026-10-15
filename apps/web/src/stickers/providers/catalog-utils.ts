/** Small helpers shared by the offline catalog providers (emoji, icons). */

import type { StickerProvider } from "../types";

export function paginate<T>({
	items,
	options,
}: {
	items: T[];
	options?: { page?: number; limit?: number };
}): { items: T[]; hasMore: boolean; total: number } {
	if (options?.limit === undefined || Number.isNaN(options.limit)) {
		return { items, hasMore: false, total: items.length };
	}
	const limit = Math.max(1, options.limit);
	if (!Number.isFinite(limit)) {
		// "No limit": one page with everything. (page - 1) * Infinity would be NaN.
		return { items, hasMore: false, total: items.length };
	}
	const page = Math.max(1, options.page ?? 1);
	const startIndex = (page - 1) * limit;
	const endIndex = startIndex + limit;
	return {
		items: items.slice(startIndex, endIndex),
		hasMore: endIndex < items.length,
		total: items.length,
	};
}

export type CatalogLoad<T> =
	| { status: "ready"; value: T }
	| { status: "failed"; error: Error };

export interface CatalogLoader<T> {
	(): Promise<CatalogLoad<T>>;
	/**
	 * Forgets the loaded catalog, so the next call loads it again. For tests: a
	 * default provider's catalog lives as long as the process, so what one test
	 * file loaded would otherwise still be there for the next one.
	 */
	reset: () => void;
}

/** A catalog provider, plus the reset of its loaded catalog (see `CatalogLoader.reset`). */
export type CatalogStickerProvider = StickerProvider & { resetCatalog: () => void };

/**
 * Loads a catalog once, on first use, and shares the result. A failure is
 * logged (with `label`), reported as `{ status: "failed" }` and NOT cached, so
 * the next call (the picker's Retry button) tries again. Callers must show the
 * failure: an empty catalog and a catalog that could not be loaded are not the
 * same thing.
 */
export function createCatalogLoader<T>({
	load,
	label,
}: {
	load: () => Promise<T>;
	label: string;
}): CatalogLoader<T> {
	let pending: Promise<CatalogLoad<T>> | null = null;

	const loadOnce = () => {
		if (!pending) {
			const attempt: Promise<CatalogLoad<T>> = Promise.resolve()
				.then(load)
				.then((value): CatalogLoad<T> => ({ status: "ready", value }))
				.catch((reason: unknown): CatalogLoad<T> => {
					const error =
						reason instanceof Error ? reason : new Error(String(reason));
					console.error(`Failed to load ${label}:`, error);
					if (pending === attempt) {
						pending = null;
					}
					return { status: "failed", error };
				});
			pending = attempt;
		}
		return pending;
	};

	return Object.assign(loadOnce, {
		reset: () => {
			pending = null;
		},
	});
}

/** A catalog request that has not answered after this long counts as failed. */
export const CATALOG_FETCH_TIMEOUT_MS = 15_000;

/** GET `url` as JSON; rejects on a failing status, bad JSON, or no answer within `timeoutMs`. */
export async function fetchJson({
	url,
	timeoutMs = CATALOG_FETCH_TIMEOUT_MS,
}: {
	url: string;
	timeoutMs?: number;
}): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	return response.json();
}

export function capitalizeFirst({ text }: { text: string }): string {
	return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function slugify({ text }: { text: string }): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringArray({
	value,
	label,
}: {
	value: unknown;
	label: string;
}): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((entry): entry is string => typeof entry === "string")
	) {
		throw new Error(`${label} must be an array of strings`);
	}
	return value;
}

export function getOrThrow<K, V>({ map, key }: { map: Map<K, V>; key: K }): V {
	const value = map.get(key);
	if (value === undefined) {
		throw new Error(`Missing entry for ${String(key)}`);
	}
	return value;
}
