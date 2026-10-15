/**
 * Dev-only playback HUD (browser glue; the numbers come from `session.ts`).
 *
 * Off by default. Turn it on in the devtools console with
 *   localStorage["ccut.playbackHud"] = "1"   (stays on after a reload)
 * or
 *   window.__playbackHud = true              (this window only; false forces it off)
 * then press Play. A small overlay at the top left shows the last second and
 * the fps of every 5 s since Play; `__playbackHudDump()` prints (and returns)
 * the whole table for copy-paste. Rows also count the effect passes of each
 * draw (no effect time: nothing measures the GPU time of the passes) and the
 * failed draws; the last preview render error is shown on its own line.
 *
 * While the flag is off the preview only reads the flag: no observer, timer,
 * overlay or global function exists.
 */
import {
	type HudProbe,
	type HudGpuErrors,
	PlaybackSession,
	formatGpuErrors,
	formatLastRenderError,
	formatRow,
	formatSummary,
	frameSampleFromProbes,
	parseHudFlag,
} from "./session";
import { videoCache } from "@/services/video-cache/service";
import { type CacheMemorySnapshot, formatCacheMemoryLine } from "./cache-memory";
import { type HudBitmapStats, type HudDisplaySize, formatLeversLine } from "./levers-line";
import { playbackLevers } from "@/services/playback-levers/store";

declare global {
	interface Window {
		__playbackHud?: boolean;
		__playbackHudDump?: () => string;
	}
}

const STORAGE_KEY = "ccut.playbackHud";
const FLAG_RECHECK_MS = 1000;
const OVERLAY_REFRESH_MS = 500;
const HEAP_SAMPLE_MS = 1000;

let storageCache: { value: string | null; readAtMs: number } | null = null;

function readStorageFlag(): string | null {
	try {
		return window.localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

/** Cheap enough for every animation frame: localStorage is read once a second. */
export function isPlaybackHudEnabled(): boolean {
	if (typeof window === "undefined") return false;
	const windowFlag: unknown = window.__playbackHud;
	if (windowFlag === true || windowFlag === false) {
		return parseHudFlag({ windowFlag, storageValue: null });
	}
	const now = performance.now();
	if (!storageCache || now - storageCache.readAtMs > FLAG_RECHECK_MS) {
		storageCache = { value: readStorageFlag(), readAtMs: now };
	}
	return parseHudFlag({ windowFlag, storageValue: storageCache.value });
}

/** `performance.memory.usedJSHeapSize` (Chromium only), else null. */
function readHeapBytes(): number | null {
	const memory: unknown = Reflect.get(performance, "memory");
	if (typeof memory !== "object" || memory === null) return null;
	const used: unknown = Reflect.get(memory, "usedJSHeapSize");
	return typeof used === "number" ? used : null;
}

/** One per window (`playbackHud`); exported so tests can have a fresh one. */
export class PlaybackHudRecorder {
	private active = false;
	private session: PlaybackSession | null = null;
	private lastSession: { session: PlaybackSession; endMs: number } | null = null;
	private observer: PerformanceObserver | null = null;
	private heapTimer: ReturnType<typeof setInterval> | null = null;
	private overlayTimer: ReturnType<typeof setInterval> | null = null;
	private overlay: HTMLDivElement | null = null;
	/** Message of the last failed preview draw while the HUD was on. */
	private lastRenderError: string | null = null;
	/** The GPU device's uncaptured errors, as last read by the preview. */
	private gpuErrors: HudGpuErrors | null = null;
	private cacheMemory: CacheMemorySnapshot | null = null;
	/** Compositor frame size of the last preview draw while the HUD was on. */
	private displaySize: HudDisplaySize | null = null;
	/** Compositor upload counters of the last preview draw while the HUD was on. */
	private bitmapStats: HudBitmapStats | null = null;

	private leversLine(): string {
		return formatLeversLine({
			levers: playbackLevers(),
			display: this.displaySize,
			bitmap: this.bitmapStats,
			workers: videoCache.getWorkerStats(),
		});
	}

	/** The frame cache's budget and use; rates since the previous sample. */
	private cacheMemoryLine(): string {
		const current = { atMs: performance.now(), ...videoCache.getMemoryStats() };
		const line = formatCacheMemoryLine({ current, previous: this.cacheMemory });
		this.cacheMemory = current;
		return line;
	}

	/** Every preview tick while the flag is on. */
	tick({ playing, nowMs }: { playing: boolean; nowMs: number }): void {
		if (!this.active) this.activate();
		if (playing && !this.session) {
			this.startSession({ nowMs });
		} else if (!playing && this.session) {
			this.stopSession({ nowMs });
		}
	}

	/** Every preview tick while the flag is off: tears the HUD down once. */
	deactivate(): void {
		if (!this.active) return;
		this.active = false;
		this.stopSession({ nowMs: performance.now() });
		if (this.overlayTimer !== null) clearInterval(this.overlayTimer);
		this.overlayTimer = null;
		this.overlay?.remove();
		this.overlay = null;
		if (window.__playbackHudDump === this.dump) {
			delete window.__playbackHudDump;
		}
	}

	recordFrame({
		before,
		after,
		effectPasses,
	}: {
		before: HudProbe;
		after: HudProbe;
		/** Effect passes of the frame that was drawn (`effectPassesOfFrame`). */
		effectPasses: number;
	}): void {
		this.session?.addFrame(frameSampleFromProbes({ before, after, effectPasses }));
	}

	/** The compositor frame size of a preview draw (only called while the HUD is on). */
	recordDisplaySize(size: HudDisplaySize): void {
		this.displaySize = size;
	}

	/**
	 * A preview draw left no picture (it failed even without effects): the frame
	 * size of the last draw that did is out of date and is not shown as current.
	 */
	recordNotDrawn(): void {
		this.displaySize = null;
	}

	/** The compositor's upload counters after a preview draw (only called while the HUD is on). */
	recordBitmapStats(stats: HudBitmapStats): void {
		this.bitmapStats = { reused: stats.reused, created: stats.created, staging: stats.staging };
	}

	/** A preview draw failed or was drawn without its effects (only called while the HUD is on). */
	recordRenderError({ message, nowMs }: { message: string; nowMs: number }): void {
		this.lastRenderError = message;
		this.session?.addRenderError({ atMs: nowMs });
	}

	/** The GPU device's error count after a preview draw (only called while the HUD is on). */
	recordGpuErrorStats(stats: HudGpuErrors | null): void {
		this.gpuErrors = stats;
	}

	dump = (): string => {
		const { lastRenderError, gpuErrors } = this;
		const text = this.session
			? formatSummary({
					session: this.session,
					nowMs: performance.now(),
					lastRenderError,
					gpuErrors,
				})
			: this.lastSession
				? formatSummary({
						session: this.lastSession.session,
						nowMs: this.lastSession.endMs,
						lastRenderError,
						gpuErrors,
					})
				: `Ccut playback HUD: no playback recorded yet (press Play with the HUD on).\n${formatLastRenderError(lastRenderError)}\n${formatGpuErrors(gpuErrors)}`;
		const withCache = `${text}\n${this.cacheMemoryLine()}\n${this.leversLine()}`;
		console.log(withCache);
		return withCache;
	};

	private activate(): void {
		this.active = true;
		window.__playbackHudDump = this.dump;
		this.overlay = document.createElement("div");
		Object.assign(this.overlay.style, {
			position: "fixed",
			top: "8px",
			left: "8px",
			zIndex: "2147483647",
			pointerEvents: "none",
			background: "rgba(0, 0, 0, 0.78)",
			color: "#b6f7b0",
			font: "11px/1.4 ui-monospace, monospace",
			whiteSpace: "pre",
			padding: "6px 8px",
			borderRadius: "4px",
			maxWidth: "96vw",
			overflow: "hidden",
		});
		document.body.appendChild(this.overlay);
		this.overlayTimer = setInterval(() => this.refreshOverlay(), OVERLAY_REFRESH_MS);
		this.refreshOverlay();
	}

	private startSession({ nowMs }: { nowMs: number }): void {
		const session = new PlaybackSession({ startMs: nowMs });
		this.session = session;
		try {
			this.observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					session.addLongTask({ startMs: entry.startTime, durationMs: entry.duration });
				}
			});
			this.observer.observe({ type: "longtask", buffered: false });
		} catch {
			this.observer = null;
		}
		const sampleHeap = () => {
			const usedBytes = readHeapBytes();
			if (usedBytes !== null) session.addHeap({ atMs: performance.now(), usedBytes });
		};
		sampleHeap();
		this.heapTimer = setInterval(sampleHeap, HEAP_SAMPLE_MS);
	}

	private stopSession({ nowMs }: { nowMs: number }): void {
		this.observer?.disconnect();
		this.observer = null;
		if (this.heapTimer !== null) clearInterval(this.heapTimer);
		this.heapTimer = null;
		if (this.session) {
			this.lastSession = { session: this.session, endMs: nowMs };
		}
		this.session = null;
	}

	private refreshOverlay(): void {
		if (!this.overlay) return;
		const live = this.session;
		const shown = live ?? this.lastSession?.session ?? null;
		const nowMs = live ? performance.now() : (this.lastSession?.endMs ?? 0);
		if (!shown) {
			this.overlay.textContent = [
				"playback HUD: press Play (__playbackHudDump() prints the table)",
				formatLastRenderError(this.lastRenderError),
				formatGpuErrors(this.gpuErrors),
				this.leversLine(),
			].join("\n");
			return;
		}
		const buckets = shown.rows({ bucketSeconds: 5, nowMs });
		this.overlay.textContent = [
			`playback HUD ${live ? "(playing)" : "(last playback)"}: __playbackHudDump() prints the table`,
			`last 1 s: ${formatRow(shown.lastWindow({ nowMs, windowMs: 1000 }))}`,
			`fps per 5 s since play: ${buckets.map((row) => row.fps.toFixed(1)).join(" | ")}`,
			`restarts per 5 s:       ${buckets.map((row) => row.restarts).join(" | ")}`,
			`long tasks per 5 s:     ${buckets.map((row) => row.longTasks).join(" | ")}`,
			formatLastRenderError(this.lastRenderError),
			formatGpuErrors(this.gpuErrors),
			this.cacheMemoryLine(),
			this.leversLine(),
		].join("\n");
	}
}

export const playbackHud = new PlaybackHudRecorder();
