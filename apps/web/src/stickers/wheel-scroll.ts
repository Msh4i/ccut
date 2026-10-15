import { horizontalScrollTarget } from "./view-logic";

/** What the handler reads of a wheel event. */
export type WheelLike = Pick<
	WheelEvent,
	"deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "preventDefault"
>;

export interface WheelScrollElement {
	scrollLeft: number;
	scrollWidth: number;
	clientWidth: number;
	// Method syntax on purpose: it matches how DOM elements declare these.
	addEventListener(
		type: "wheel",
		listener: (event: WheelLike) => void,
		options: AddEventListenerOptions,
	): void;
	removeEventListener(
		type: "wheel",
		listener: (event: WheelLike) => void,
		options: AddEventListenerOptions,
	): void;
}

const LISTENER_OPTIONS: AddEventListenerOptions = { passive: false };

/**
 * Lets a mouse wheel scroll a bar that has no visible scrollbar sideways.
 * The listener is registered natively and not passive: React's `onWheel` is
 * passive, and a passive listener cannot stop the page from scrolling.
 * Returns the function that removes it.
 */
export function attachHorizontalWheelScroll({
	element,
}: {
	element: WheelScrollElement;
}): () => void {
	const onWheel = (event: WheelLike) => {
		const target = horizontalScrollTarget({
			deltaX: event.deltaX,
			deltaY: event.deltaY,
			deltaMode: event.deltaMode,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
			scrollLeft: element.scrollLeft,
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
		});
		if (target === null) {
			return;
		}
		event.preventDefault();
		element.scrollLeft = target;
	};

	element.addEventListener("wheel", onWheel, LISTENER_OPTIONS);
	return () => element.removeEventListener("wheel", onWheel, LISTENER_OPTIONS);
}
