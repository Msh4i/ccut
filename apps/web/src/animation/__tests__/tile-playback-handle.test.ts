import { describe, expect, test } from "bun:test";
import {
	createTilePlaybackHandle,
	watchPrefersReducedMotion,
	type VisibilityEntry,
	type VisibilityObserver,
} from "@/animation/tiles/playback-handle";
import { TilePlaybackStore } from "@/animation/tiles/playback";

/** An IntersectionObserver stand-in that reports only when the test says so. */
function fakeObserverFactory() {
	const created: {
		report: (entries: VisibilityEntry[]) => void;
		observed: Set<object>;
		disconnected: boolean;
	}[] = [];
	const createObserver = (report: (entries: VisibilityEntry[]) => void): VisibilityObserver => {
		const record = { report, observed: new Set<object>(), disconnected: false };
		created.push(record);
		return {
			observe: (node) => {
				record.observed.add(node);
			},
			unobserve: (node) => {
				record.observed.delete(node);
			},
			disconnect: () => {
				record.disconnected = true;
				record.observed.clear();
			},
		};
	};
	return { createObserver, created };
}

function fakeReducedMotion(initial: boolean) {
	let listener: ((reduced: boolean) => void) | null = null;
	let stops = 0;
	return {
		watchReducedMotion: (onChange: (reduced: boolean) => void) => {
			listener = onChange;
			onChange(initial);
			return () => {
				listener = null;
				stops += 1;
			};
		},
		change: (reduced: boolean) => listener?.(reduced),
		stopCount: () => stops,
		isWatched: () => listener !== null,
	};
}

function setup({ reduced = false }: { reduced?: boolean } = {}) {
	const store = new TilePlaybackStore({ cap: 4 });
	store.setOrder({ order: ["a", "b", "c"] });
	const observers = fakeObserverFactory();
	const motion = fakeReducedMotion(reduced);
	const handle = createTilePlaybackHandle({
		store,
		createObserver: observers.createObserver,
		watchReducedMotion: motion.watchReducedMotion,
	});
	return { store, handle, observers, motion };
}

describe("createTilePlaybackHandle: visibility and reduced motion feed the store", () => {
	test("tiles observed before the panel connects are watched once it does", () => {
		const { store, handle, observers } = setup();
		const nodeA = {};
		const nodeB = {};
		handle.observe({ id: "a", node: nodeA });
		handle.observe({ id: "b", node: nodeB });
		expect(observers.created).toHaveLength(0);
		handle.connect();
		expect(observers.created).toHaveLength(1);
		expect([...observers.created[0].observed]).toEqual([nodeA, nodeB]);
		expect(store.getPlayback("a")).toBe("still");
		observers.created[0].report([
			{ target: nodeA, isIntersecting: true, intersectionRatio: 1 },
			{ target: nodeB, isIntersecting: false, intersectionRatio: 0 },
		]);
		expect(store.getPlayback("a")).toBe("loop");
		expect(store.getPlayback("b")).toBe("still");
	});

	test("a tile observed after connecting is watched right away", () => {
		const { store, handle, observers } = setup();
		handle.connect();
		const node = {};
		handle.observe({ id: "c", node });
		expect(observers.created[0].observed.has(node)).toBe(true);
		observers.created[0].report([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
		expect(store.getPlayback("c")).toBe("loop");
	});

	test("reports about nodes nobody registered are ignored", () => {
		const { store, handle, observers } = setup();
		handle.connect();
		observers.created[0].report([{ target: {}, isIntersecting: true, intersectionRatio: 1 }]);
		expect(["a", "b", "c"].map((id) => store.getPlayback(id))).toEqual(["still", "still", "still"]);
	});

	test("a tile that unmounts is unobserved and forgotten", () => {
		const { store, handle, observers } = setup();
		handle.connect();
		const node = {};
		const unobserve = handle.observe({ id: "a", node });
		observers.created[0].report([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
		store.setHovered({ id: "a", isHovered: true });
		unobserve();
		expect(observers.created[0].observed.has(node)).toBe(false);
		expect(store.getPlayback("a")).toBe("still");
		observers.created[0].report([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
		expect(store.getPlayback("a")).toBe("still");
	});

	test("disconnecting (the panel unmounts) stops the observer and the reduced-motion watcher, and nothing stays visible", () => {
		const { store, handle, observers, motion } = setup();
		const node = {};
		handle.observe({ id: "a", node });
		const disconnect = handle.connect();
		observers.created[0].report([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
		disconnect();
		expect(observers.created[0].disconnected).toBe(true);
		expect(motion.isWatched()).toBe(false);
		expect(motion.stopCount()).toBe(1);
		expect(store.getPlayback("a")).toBe("still");
	});

	test("connecting again (React's strict mode remount) watches the same tiles again", () => {
		const { store, handle, observers } = setup();
		const node = {};
		handle.observe({ id: "a", node });
		handle.connect()();
		handle.connect();
		expect(observers.created).toHaveLength(2);
		expect(observers.created[1].observed.has(node)).toBe(true);
		observers.created[1].report([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
		expect(store.getPlayback("a")).toBe("loop");
	});

	test("without IntersectionObserver every observed tile counts as visible", () => {
		const store = new TilePlaybackStore({ cap: 4 });
		store.setOrder({ order: ["a", "b"] });
		const handle = createTilePlaybackHandle({
			store,
			createObserver: () => null,
			watchReducedMotion: () => () => {},
		});
		handle.observe({ id: "a", node: {} });
		handle.connect();
		handle.observe({ id: "b", node: {} });
		expect(store.getPlayback("a")).toBe("loop");
		expect(store.getPlayback("b")).toBe("loop");
	});

	test("the OS reduced-motion setting is read at connect and followed when it changes", () => {
		const { store, handle, observers, motion } = setup({ reduced: true });
		const node = {};
		handle.observe({ id: "a", node });
		handle.connect();
		observers.created[0].report([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
		expect(store.getPlayback("a")).toBe("still");
		motion.change(false);
		expect(store.getPlayback("a")).toBe("loop");
		motion.change(true);
		expect(store.getPlayback("a")).toBe("still");
	});
});

describe("visibility needs a visible area", () => {
	test("an edge-adjacent tile (a collapsed section clips it to nothing) is not visible", () => {
		const { store, handle, observers } = setup();
		const node = {};
		handle.observe({ id: "a", node });
		handle.connect();
		// IntersectionObserver reports isIntersecting for a zero-area, edge-adjacent rect.
		observers.created[0].report([{ target: node, isIntersecting: true, intersectionRatio: 0 }]);
		expect(store.getPlayback("a")).toBe("still");
		observers.created[0].report([{ target: node, isIntersecting: true, intersectionRatio: 0.4 }]);
		expect(store.getPlayback("a")).toBe("loop");
		observers.created[0].report([{ target: node, isIntersecting: true, intersectionRatio: 0 }]);
		expect(store.getPlayback("a")).toBe("still");
	});
});

/**
 * Puts a fake global in place for one test (Bun has no DOM) and returns the
 * function that puts the original back, or removes it if there was none.
 */
function stubGlobal({ name, value }: { name: string; value: unknown }): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	return () => {
		if (original) {
			Object.defineProperty(globalThis, name, original);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	};
}

describe("the real IntersectionObserver wiring", () => {
	class FakeElement {}

	function installFakeObserver() {
		const created: {
			callback: (entries: VisibilityEntry[]) => void;
			threshold: unknown;
			observed: object[];
			disconnected: boolean;
		}[] = [];
		class FakeIntersectionObserver {
			private readonly record: (typeof created)[number];
			// The platform's positional signature: new IntersectionObserver(callback, options).
			constructor(
				...[callback, options]: [
					callback: (entries: VisibilityEntry[]) => void,
					options?: { threshold?: unknown },
				]
			) {
				this.record = { callback, threshold: options?.threshold, observed: [], disconnected: false };
				created.push(this.record);
			}
			observe(node: object) {
				this.record.observed.push(node);
			}
			unobserve(node: object) {
				this.record.observed = this.record.observed.filter((entry) => entry !== node);
			}
			disconnect() {
				this.record.disconnected = true;
			}
		}
		const restoreObserver = stubGlobal({ name: "IntersectionObserver", value: FakeIntersectionObserver });
		const restoreElement = stubGlobal({ name: "Element", value: FakeElement });
		return {
			created,
			restore: () => {
				restoreObserver();
				restoreElement();
			},
		};
	}

	test("observes the tiles, reports a 0 to >0 change, and disconnects", () => {
		const fake = installFakeObserver();
		try {
			const store = new TilePlaybackStore({ cap: 4 });
			store.setOrder({ order: ["a"] });
			const handle = createTilePlaybackHandle({ store, watchReducedMotion: () => () => {} });
			const node = new FakeElement();
			handle.observe({ id: "a", node });
			const disconnect = handle.connect();
			expect(fake.created).toHaveLength(1);
			expect(fake.created[0].observed).toEqual([node]);
			// A threshold above 0, so the step from an edge-adjacent (ratio 0) to a
			// really visible tile produces a report; with [0] alone it would not.
			const threshold = fake.created[0].threshold;
			expect(Array.isArray(threshold) && threshold.some((value) => value > 0)).toBe(true);
			fake.created[0].callback([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
			expect(store.getPlayback("a")).toBe("loop");
			disconnect();
			expect(fake.created[0].disconnected).toBe(true);
		} finally {
			fake.restore();
		}
		expect("IntersectionObserver" in globalThis).toBe(false);
	});
});

describe("watchPrefersReducedMotion (the real media query)", () => {
	function installFakeMatchMedia(initial: boolean) {
		const queries: string[] = [];
		const listeners = new Set<() => void>();
		// The platform's positional signatures: addEventListener(type, listener).
		const list = {
			matches: initial,
			addEventListener: (...[type, listener]: [type: string, listener: () => void]) => {
				if (type === "change") listeners.add(listener);
			},
			removeEventListener: (...[type, listener]: [type: string, listener: () => void]) => {
				if (type === "change") listeners.delete(listener);
			},
		};
		const restore = stubGlobal({
			name: "window",
			value: {
				matchMedia: (query: string) => {
					queries.push(query);
					return list;
				},
			},
		});
		return {
			queries,
			listenerCount: () => listeners.size,
			change: (matches: boolean) => {
				list.matches = matches;
				for (const listener of [...listeners]) listener();
			},
			restore,
		};
	}

	test("reads the OS setting at once, follows its changes, and stops listening", () => {
		const fake = installFakeMatchMedia(true);
		try {
			const seen: boolean[] = [];
			const stop = watchPrefersReducedMotion((reduced) => seen.push(reduced));
			expect(fake.queries).toEqual(["(prefers-reduced-motion: reduce)"]);
			expect(seen).toEqual([true]);
			fake.change(false);
			fake.change(true);
			expect(seen).toEqual([true, false, true]);
			stop();
			expect(fake.listenerCount()).toBe(0);
			fake.change(false);
			expect(seen).toEqual([true, false, true]);
		} finally {
			fake.restore();
		}
	});

	test("without matchMedia (a server render) motion is not reduced", () => {
		const seen: boolean[] = [];
		watchPrefersReducedMotion((reduced) => seen.push(reduced))();
		expect(seen).toEqual([false]);
	});
});
