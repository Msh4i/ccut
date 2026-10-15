/** Longest piece of an id, name or error text that goes into a message. */
export const MAX_DESCRIBED_LENGTH = 80;

/**
 * An id (or anything that should have been one) as it may appear in a message
 * or log: at most MAX_DESCRIBED_LENGTH characters, and a value that is not a
 * string by its type (`<number>`, `<undefined>`) instead of its content.
 * Sticker ids come from saved projects and the clipboard, so they can be
 * anything and any length; a message must be neither.
 */
export function describeId({ value }: { value: unknown }): string {
	if (typeof value === "string") {
		return value.length > MAX_DESCRIBED_LENGTH
			? `${value.slice(0, MAX_DESCRIBED_LENGTH)}…`
			: value;
	}
	return value === null ? "<null>" : `<${typeof value}>`;
}

/** The message of an error (or the text of a thrown value), cut for a log line. */
export function describeError({ error }: { error: unknown }): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > 4 * MAX_DESCRIBED_LENGTH
		? `${text.slice(0, 4 * MAX_DESCRIBED_LENGTH)}…`
		: text;
}
