import { join } from "node:path";

/**
 * Below this share of emoji with a Turkish name the run fails: it means the
 * CLDR file changed shape or was truncated, not that a few emoji are new.
 */
export const MIN_TURKISH_NAME_RATIO = 0.98;

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/** NUL, newline, tab, the other C0 controls and DEL: none belongs in a file name we build. */
function hasControlCharacter({ text }: { text: string }): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

export function assertTurkishCoverage({
	withTurkish,
	total,
}: {
	withTurkish: number;
	total: number;
}): void {
	if (total === 0) {
		throw new Error("The generated catalog has no emoji");
	}
	const ratio = withTurkish / total;
	if (ratio < MIN_TURKISH_NAME_RATIO) {
		throw new Error(
			`Only ${withTurkish} of ${total} emoji have a Turkish name (${Math.round(ratio * 100)}%, at least ${Math.round(MIN_TURKISH_NAME_RATIO * 100)}% expected). The CLDR annotations may have changed.`,
		);
	}
}

/**
 * `<cacheDirectory>/<commit>/<segments...>`. The cache is tied to the pinned
 * commit, so bumping a pin can never be answered from files cached for an
 * older one. The commit must be a full SHA (a branch name would defeat the
 * pin) and no segment may climb out of the cache.
 */
export function cachePath({
	cacheDirectory,
	commit,
	segments,
}: {
	cacheDirectory: string;
	commit: string;
	segments: string[];
}): string {
	if (!FULL_COMMIT_SHA.test(commit)) {
		throw new Error(`The cache needs a full commit SHA, got "${commit.slice(0, 50)}"`);
	}
	for (const segment of segments) {
		if (
			segment === "" ||
			segment === "." ||
			segment === ".." ||
			/[/\\]/.test(segment) ||
			hasControlCharacter({ text: segment })
		) {
			// Shown with control characters escaped, never raw.
			throw new Error(`Unsafe cache path segment: ${JSON.stringify(segment.slice(0, 50))}`);
		}
	}
	return join(cacheDirectory, commit, ...segments);
}

/**
 * Builds every icon file in memory first. The caller writes only after this
 * returned, so one invalid icon cannot leave a half-updated folder behind.
 */
export async function buildIconSvgs({
	ids,
	buildSvg,
}: {
	ids: string[];
	buildSvg: ({ id }: { id: string }) => Promise<string>;
}): Promise<Map<string, string>> {
	const svgs = await Promise.all(
		ids.map(async (id) => {
			try {
				return await buildSvg({ id });
			} catch (error) {
				throw new Error(`Icon "${id}" is invalid: ${String(error)}`, {
					cause: error,
				});
			}
		}),
	);
	return new Map(ids.map((id, index) => [id, svgs[index]]));
}

/**
 * Reads the text about to be written back through the validator the app uses
 * when it loads the file, so the generator can never write an index the app
 * would refuse.
 */
export function verifySerializedIndex<T>({
	serialized,
	parse,
	label,
}: {
	serialized: string;
	parse: ({ value }: { value: unknown }) => T;
	label: string;
}): T {
	try {
		return parse({ value: JSON.parse(serialized) });
	} catch (error) {
		throw new Error(`The generated ${label} is invalid: ${String(error)}`, {
			cause: error,
		});
	}
}
