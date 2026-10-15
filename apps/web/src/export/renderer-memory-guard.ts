/**
 * The export's guard against Chromium's limit on a renderer's writable memory (8 GiB, `RLIMIT_DATA`):
 * a renderer that reaches it is killed and the window stays black. The desktop app reports the
 * renderer's own figure (`rendererDataBytes` of `window.ccutSystem.memoryInfo()`); the guard reads
 * it every few frames, asks the video cache to give back what it can once the figure is high, and
 * stops the export with a clear message before the limit, never after.
 */

const GiB = 1024 ** 3;

/** Chromium's limit on a renderer's writable memory (the kernel log: `VmData ... exceed data ulimit`). */
export const RENDERER_DATA_LIMIT_BYTES = 8 * GiB;
/** From here the guard gives back what the video cache can spare. */
export const RENDERER_RELIEF_BYTES = 4.5 * GiB;
/** From here the export stops: the rest of the limit is room for one more reading interval (about +0.3 GiB/s was measured). */
export const RENDERER_CEILING_BYTES = 6 * GiB;
/** Frames between two readings. */
export const GUARD_CHECK_EVERY_FRAMES = 10;

export class ExportMemoryLimitError extends Error {
	constructor({ usedBytes, seconds, totalSeconds }: { usedBytes: number; seconds: number; totalSeconds: number }) {
		super(
			`Export stopped at ${seconds.toFixed(1)} s of ${totalSeconds.toFixed(1)} s: memory limit. ` +
				`The editor window was using ${(usedBytes / GiB).toFixed(1)} GiB of the ${RENDERER_DATA_LIMIT_BYTES / GiB} GiB it may use. ` +
				"Nothing was saved; the project is unchanged. Close other apps and export again, or export the project in two parts.",
		);
		this.name = "ExportMemoryLimitError";
	}
}

/** The renderer's writable memory in bytes, or null where the app cannot tell (the web build, an older desktop build). */
export async function readRendererDataBytes({ host }: { host: unknown }): Promise<number | null> {
	if (typeof host !== "object" || host === null) return null;
	const bridge: unknown = Reflect.get(host, "ccutSystem");
	if (typeof bridge !== "object" || bridge === null) return null;
	const memoryInfo: unknown = Reflect.get(bridge, "memoryInfo");
	if (typeof memoryInfo !== "function") return null;
	const reading: unknown = await Reflect.apply(memoryInfo, bridge, []);
	if (typeof reading !== "object" || reading === null) return null;
	const bytes: unknown = Reflect.get(reading, "rendererDataBytes");
	return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

export type ExportMemoryGuard = (frame: { index: number; frameCount: number; seconds: number; totalSeconds: number }) => Promise<void>;

/**
 * A guard for one export. `read` failing or answering null leaves the export alone (a reading is
 * never worth stopping an export for). `relieve` gives memory back; it is called at every reading
 * above `RENDERER_RELIEF_BYTES`.
 */
export function createExportMemoryGuard({
	read,
	relieve,
	reliefBytes = RENDERER_RELIEF_BYTES,
	ceilingBytes = RENDERER_CEILING_BYTES,
}: {
	read: () => Promise<number | null>;
	relieve: () => void;
	reliefBytes?: number;
	ceilingBytes?: number;
}): ExportMemoryGuard {
	return async ({ index, seconds, totalSeconds }) => {
		if (index % GUARD_CHECK_EVERY_FRAMES !== 0) return;
		let usedBytes: number | null = null;
		try {
			usedBytes = await read();
		} catch {
			return;
		}
		if (usedBytes === null) return;
		if (usedBytes >= ceilingBytes) {
			throw new ExportMemoryLimitError({ usedBytes, seconds, totalSeconds });
		}
		if (usedBytes >= reliefBytes) relieve();
	};
}
