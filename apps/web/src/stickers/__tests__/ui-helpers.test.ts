import { describe, expect, mock, test } from "bun:test";
import { createDebouncer } from "../debounce";
import { observeSentinel } from "../sentinel-observer";
import { scrollToTop } from "../scroll-reset";
import { createSingleFlight } from "../single-flight";
import { attachHorizontalWheelScroll, type WheelLike } from "../wheel-scroll";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("createDebouncer", () => {
	test("runs once, with the last arguments, after the quiet period", async () => {
		const calls: string[] = [];
		const debouncer = createDebouncer({ callback: (value: string) => calls.push(value), delayMs: 30 });
		debouncer.call("h");
		debouncer.call("he");
		debouncer.call("hea");
		expect(calls).toEqual([]);
		await sleep(80);
		expect(calls).toEqual(["hea"]);
	});

	test("every call restarts the wait", async () => {
		const calls: string[] = [];
		const debouncer = createDebouncer({ callback: (value: string) => calls.push(value), delayMs: 50 });
		debouncer.call("a");
		await sleep(30);
		debouncer.call("b");
		await sleep(30);
		expect(calls).toEqual([]); // 60 ms passed, but only 30 since the last call
		await sleep(60);
		expect(calls).toEqual(["b"]);
	});

	test("cancel drops the pending call (the panel was closed)", async () => {
		const calls: string[] = [];
		const debouncer = createDebouncer({ callback: (value: string) => calls.push(value), delayMs: 20 });
		debouncer.call("x");
		debouncer.cancel();
		await sleep(60);
		expect(calls).toEqual([]);
	});

	test("flush runs the pending call now, once", async () => {
		const calls: string[] = [];
		const debouncer = createDebouncer({ callback: (value: string) => calls.push(value), delayMs: 40 });
		debouncer.call("now");
		debouncer.flush();
		expect(calls).toEqual(["now"]);
		debouncer.flush(); // nothing pending
		await sleep(80);
		expect(calls).toEqual(["now"]);
	});

	test("can be used again after it ran or was cancelled", async () => {
		const calls: string[] = [];
		const debouncer = createDebouncer({ callback: (value: string) => calls.push(value), delayMs: 15 });
		debouncer.call("1");
		await sleep(50);
		debouncer.call("2");
		debouncer.cancel();
		debouncer.call("3");
		await sleep(50);
		expect(calls).toEqual(["1", "3"]);
	});
});

describe("attachHorizontalWheelScroll", () => {
	/** A bar with the scroll geometry of the tab list, recording its wheel listeners. */
	function fakeBar({ scrollWidth = 500, clientWidth = 300, scrollLeft = 0 } = {}) {
		const added: { listener: (event: WheelLike) => void; options: AddEventListenerOptions }[] = [];
		const removed: ((event: WheelLike) => void)[] = [];
		return {
			scrollWidth,
			clientWidth,
			scrollLeft,
			added,
			removed,
			addEventListener: mock((_type: "wheel", listener: (event: WheelLike) => void, options: AddEventListenerOptions) => {
				added.push({ listener, options });
			}),
			removeEventListener: mock((_type: "wheel", listener: (event: WheelLike) => void) => {
				removed.push(listener);
			}),
		};
	}

	function wheel({ deltaY = 100, deltaX = 0, deltaMode = 0 } = {}) {
		const preventDefault = mock(() => {});
		return { event: { deltaX, deltaY, deltaMode, ctrlKey: false, metaKey: false, preventDefault }, preventDefault };
	}

	test("a vertical wheel scrolls the bar sideways and stops the page from scrolling", () => {
		const bar = fakeBar();
		attachHorizontalWheelScroll({ element: bar });
		const { event, preventDefault } = wheel({ deltaY: 80 });
		bar.added[0].listener(event);
		expect(bar.scrollLeft).toBe(80);
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});

	test("it is registered as non-passive (a passive listener cannot stop the page)", () => {
		const bar = fakeBar();
		attachHorizontalWheelScroll({ element: bar });
		expect(bar.added).toHaveLength(1);
		expect(bar.added[0].options.passive).toBe(false);
	});

	test("leaves the event alone when the bar does not overflow, or for a sideways gesture", () => {
		const fits = fakeBar({ scrollWidth: 300 });
		attachHorizontalWheelScroll({ element: fits });
		const first = wheel();
		fits.added[0].listener(first.event);
		expect(fits.scrollLeft).toBe(0);
		expect(first.preventDefault).not.toHaveBeenCalled();

		const bar = fakeBar();
		attachHorizontalWheelScroll({ element: bar });
		const sideways = wheel({ deltaX: 20 });
		bar.added[0].listener(sideways.event);
		expect(bar.scrollLeft).toBe(0);
		expect(sideways.preventDefault).not.toHaveBeenCalled();
	});

	test("at the end the page keeps the wheel", () => {
		const bar = fakeBar({ scrollLeft: 200 });
		attachHorizontalWheelScroll({ element: bar });
		const { event, preventDefault } = wheel({ deltaY: 100 });
		bar.added[0].listener(event);
		expect(preventDefault).not.toHaveBeenCalled();
	});

	test("the returned cleanup removes the very same listener with the same options", () => {
		const bar = fakeBar();
		const detach = attachHorizontalWheelScroll({ element: bar });
		detach();
		expect(bar.removed).toEqual([bar.added[0].listener]);
		expect(bar.removeEventListener).toHaveBeenCalledWith("wheel", bar.added[0].listener, bar.added[0].options);
	});
});

describe("observeSentinel", () => {
	interface FakeObserver {
		callback: (entries: { isIntersecting: boolean }[]) => void;
		root: object | null;
		rootMargin: string;
		observed: object[];
		disconnected: boolean;
	}

	function fakeObserverFactory() {
		const created: FakeObserver[] = [];
		const createObserver = ({
			callback,
			root,
			rootMargin,
		}: {
			callback: (entries: { isIntersecting: boolean }[]) => void;
			root: object | null;
			rootMargin: string;
		}) => {
			const record: FakeObserver = { callback, root, rootMargin, observed: [], disconnected: false };
			created.push(record);
			return {
				observe: (target: object) => void record.observed.push(target),
				disconnect: () => void (record.disconnected = true),
			};
		};
		return { created, createObserver };
	}

	test("observes the element with a margin, and reports when it comes into view", () => {
		const { created, createObserver } = fakeObserverFactory();
		const element = {};
		let visible = 0;
		observeSentinel({ element, onVisible: () => visible++, createObserver });
		expect(created[0].observed).toEqual([element]);
		expect(created[0].rootMargin).toBe("400px");
		created[0].callback([{ isIntersecting: false }]);
		expect(visible).toBe(0);
		created[0].callback([{ isIntersecting: true }]);
		expect(visible).toBe(1);
	});

	test("observes inside the scroller it is given: the margin only works relative to that root", () => {
		const { created, createObserver } = fakeObserverFactory();
		const scroller = {};
		observeSentinel({ element: {}, root: scroller, onVisible: () => {}, createObserver });
		expect(created[0].root).toBe(scroller);
		expect(created[0].rootMargin).toBe("400px");
	});

	test("without a scroller the root is the viewport (null)", () => {
		const { created, createObserver } = fakeObserverFactory();
		observeSentinel({ element: {}, onVisible: () => {}, createObserver });
		expect(created[0].root).toBeNull();
	});

	test("cleanup disconnects the observer", () => {
		const { created, createObserver } = fakeObserverFactory();
		const stop = observeSentinel({ element: {}, onVisible: () => {}, createObserver });
		stop();
		expect(created[0].disconnected).toBe(true);
	});

	test("with no IntersectionObserver available it reports visible once, so nothing stays hidden", () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
		Reflect.deleteProperty(globalThis, "IntersectionObserver");
		let visible = 0;
		const stop = observeSentinel({ element: {}, onVisible: () => visible++ });
		expect(visible).toBe(1);
		expect(() => stop()).not.toThrow();
		if (original) Object.defineProperty(globalThis, "IntersectionObserver", original);
	});
});

describe("wheel events that are a zoom are left alone", () => {
	test("Ctrl or Meta + wheel does not scroll the bar and is not cancelled", () => {
		const added: ((event: WheelLike) => void)[] = [];
		const bar = {
			scrollWidth: 500,
			clientWidth: 300,
			scrollLeft: 0,
			addEventListener: mock((_type: "wheel", listener: (event: WheelLike) => void) => void added.push(listener)),
			removeEventListener: mock(() => {}),
		};
		attachHorizontalWheelScroll({ element: bar });
		for (const modifier of [{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }]) {
			const preventDefault = mock(() => {});
			added[0]({ deltaX: 0, deltaY: 100, deltaMode: 0, preventDefault, ...modifier });
			expect(bar.scrollLeft).toBe(0);
			expect(preventDefault).not.toHaveBeenCalled();
		}
	});
});

describe("createSingleFlight", () => {
	test("a second trigger while the first runs does not start another task", async () => {
		const flight = createSingleFlight();
		let started = 0;
		let release: () => void = () => {};
		const task = () =>
			new Promise<string>((done) => {
				started++;
				release = () => done("added");
			});
		const first = flight.run(task);
		const second = flight.run(task);
		expect(flight.isRunning()).toBe(true);
		expect(await second).toBeUndefined();
		release();
		expect(await first).toBe("added");
		expect(started).toBe(1);
		expect(flight.isRunning()).toBe(false);
	});

	test("runs again after the task finished, also after it failed", async () => {
		const flight = createSingleFlight();
		await expect(
			flight.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(flight.isRunning()).toBe(false);
		expect(await flight.run(async () => "again")).toBe("again");
	});

	test("a task that throws before returning a promise also frees the lock", async () => {
		const flight = createSingleFlight();
		await expect(
			flight.run(() => {
				throw new Error("sync");
			}),
		).rejects.toThrow("sync");
		expect(flight.isRunning()).toBe(false);
	});
});

describe("scrollToTop", () => {
	test("scrolls the list back to the top", () => {
		const scrollTo = mock((_options: ScrollToOptions) => {});
		scrollToTop({ element: { scrollTo } });
		expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
	});

	test("nothing to scroll (not rendered yet, or no scrollTo) is nothing to do", () => {
		expect(() => scrollToTop({ element: null })).not.toThrow();
		expect(() => scrollToTop({ element: undefined })).not.toThrow();
		expect(() => scrollToTop({ element: {} })).not.toThrow();
	});
});
