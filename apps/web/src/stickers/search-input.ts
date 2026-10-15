import { createDebouncer } from "./debounce";

export interface SearchInput {
	/** The box's text changed. */
	input: ({ query }: { query: string }) => void;
	/** Drops the search that is waiting (the tab changed). */
	cancelPending: () => void;
	/** Runs the search that is waiting now (the panel closed: what was typed is not lost). */
	flushPending: () => void;
}

/**
 * The picker's search box: typing searches once the typing pauses (a search
 * redraws the grid, so one per keystroke is wasted work), but emptying the box
 * goes back to browsing at once, and drops any search still waiting.
 */
export function createSearchInput({
	search,
	delayMs,
}: {
	search: ({ query }: { query: string }) => void;
	delayMs: number;
}): SearchInput {
	const debouncer = createDebouncer({
		callback: (query: string) => search({ query }),
		delayMs,
	});

	return {
		input: ({ query }) => {
			if (query.trim() === "") {
				debouncer.cancel();
				search({ query });
				return;
			}
			debouncer.call(query);
		},
		cancelPending: debouncer.cancel,
		flushPending: debouncer.flush,
	};
}
