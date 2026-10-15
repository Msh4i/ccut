import * as opencutWasm from "opencut-wasm";

/**
 * Uncaptured GPU errors the device recorded instead of panicking
 * (rust/crates/gpu/src/context.rs; each distinct message is also logged once
 * to the console by the wasm side).
 */
export type GpuErrorStats = { count: number; lastMessage: string | null };

/** The wasm export's result; null when it does not have that shape. */
export function parseGpuErrorStats(value: unknown): GpuErrorStats | null {
	if (typeof value !== "object" || value === null) return null;
	const count: unknown = Reflect.get(value, "count");
	const lastMessage: unknown = Reflect.get(value, "lastMessage");
	if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
		return null;
	}
	if (lastMessage !== null && typeof lastMessage !== "string") return null;
	return { count, lastMessage };
}

/**
 * The device's GPU error stats (`getGpuErrorStats`, rust/wasm/src/gpu.rs), or
 * null when this wasm build has no such export: the vendored package only has
 * it once it is rebuilt from this Rust, so it is looked up, not imported by
 * name. Never throws (it runs after every preview draw).
 */
export function readGpuErrorStats({
	wasm = opencutWasm,
}: { wasm?: object } = {}): GpuErrorStats | null {
	const read: unknown = Reflect.get(wasm, "getGpuErrorStats");
	if (typeof read !== "function") return null;
	try {
		const stats: unknown = Reflect.apply(read, wasm, []);
		return parseGpuErrorStats(stats);
	} catch {
		return null;
	}
}
