export interface SentinelObserver {
	observe: (target: object) => void;
	disconnect: () => void;
}

type ObserverFactory = ({
	callback,
	root,
	rootMargin,
}: {
	callback: (entries: { isIntersecting: boolean }[]) => void;
	/** The scroller to observe inside; null is the viewport. */
	root: object | null;
	rootMargin: string;
}) => SentinelObserver;

/** Start drawing the next part a little before the end of the list is reached. */
const DEFAULT_ROOT_MARGIN = "400px";

const createIntersectionObserver: ObserverFactory = ({
	callback,
	root,
	rootMargin,
}) => {
	const observer = new IntersectionObserver(callback, {
		root: root instanceof Element ? root : null,
		rootMargin,
	});
	return {
		observe: (target) => {
			if (target instanceof Element) {
				observer.observe(target);
			}
		},
		disconnect: () => observer.disconnect(),
	};
};

/**
 * Calls `onVisible` whenever `element` (the marker after the last drawn tile)
 * is, or comes, near the viewport. Create a new one after each part is drawn:
 * a fresh observer reports the marker's current state at once, so a tall
 * window keeps drawing until the marker is out of reach. When no observer can
 * be created (no IntersectionObserver) it reports visible once, so nothing
 * stays hidden.
 */
export function observeSentinel({
	element,
	onVisible,
	root = null,
	rootMargin = DEFAULT_ROOT_MARGIN,
	createObserver = createIntersectionObserver,
}: {
	element: object;
	onVisible: () => void;
	/**
	 * The element that scrolls. A margin is measured against the root: without
	 * it (the viewport) the margin does nothing for a list inside a scroller,
	 * and the next part would only start once the marker is really on screen.
	 */
	root?: object | null;
	rootMargin?: string;
	createObserver?: ObserverFactory;
}): () => void {
	let observer: SentinelObserver;
	try {
		observer = createObserver({
			callback: (entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					onVisible();
				}
			},
			root,
			rootMargin,
		});
	} catch {
		onVisible();
		return () => {};
	}
	observer.observe(element);
	return () => observer.disconnect();
}
