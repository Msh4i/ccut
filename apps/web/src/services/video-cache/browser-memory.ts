import { usePerformanceStore } from "./performance-store";
import type { MemorySource } from "./service";

/** How often the frame cache reads the machine's memory and recomputes its budget. */
export const MEMORY_READING_INTERVAL_MS = 2000;
/**
 * A reading slower than this is no reading: a stuck bridge call must not
 * keep the cache's tick busy (it would never shrink on pressure again).
 */
export const MEMORY_READING_TIMEOUT_MS = 1500;

/** `promise`, or `fallback` when it takes longer than `ms`. A late rejection is swallowed. */
export function withTimeout<T>({
	promise,
	ms,
	fallback,
}: {
	promise: Promise<T>;
	ms: number;
	fallback: T;
}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * `window.ccutSystem.memoryInfo()` of the desktop bridge (Electron main
 * process, workstream P-h). Everything is checked at runtime: no bridge (web
 * build, an older desktop build) or no such function is no reading (null).
 * What the function returns is validated by the cache (`validateReading`).
 */
export async function readBridgeMemory({ host }: { host: unknown }): Promise<unknown> {
	if (typeof host !== "object" || host === null) return null;
	const bridge: unknown = Reflect.get(host, "ccutSystem");
	if (typeof bridge !== "object" || bridge === null) return null;
	const memoryInfo: unknown = Reflect.get(bridge, "memoryInfo");
	if (typeof memoryInfo !== "function") return null;
	const reading: unknown = await Reflect.apply(memoryInfo, bridge, []);
	return reading;
}

/** `navigator.deviceMemory` in GiB (Chromium, rounded and capped by the browser), or null. */
export function readDeviceMemory({ host }: { host: unknown }): number | null {
	if (typeof host !== "object" || host === null) return null;
	const value: unknown = Reflect.get(host, "deviceMemory");
	return typeof value === "number" ? value : null;
}

/** The app's memory source: the bridge, the Performance setting, a 2 s timer. */
export function createBrowserMemorySource(): MemorySource {
	return {
		readMemory: () =>
			withTimeout({
				promise: readBridgeMemory({ host: typeof window === "undefined" ? null : window }),
				ms: MEMORY_READING_TIMEOUT_MS,
				fallback: null,
			}),
		mode: () => usePerformanceStore.getState().mode,
		deviceMemoryGiB: () =>
			readDeviceMemory({ host: typeof navigator === "undefined" ? null : navigator }),
		schedule: (tick) => {
			if (typeof window === "undefined") return () => {};
			const timer = window.setInterval(tick, MEMORY_READING_INTERVAL_MS);
			return () => window.clearInterval(timer);
		},
	};
}
