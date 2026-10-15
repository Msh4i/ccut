"use client";

import { videoCache } from "@/services/video-cache/service";
import { prerollRequestFor, videoClipsOf } from "@/services/video-cache/preroll-scene";
import { getMatteRevision } from "@/background/matte/matte-registry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useDeepCompareEffect from "use-deep-compare-effect";
import { useEditor } from "@/editor/use-editor";
import { useCustomFontsStore } from "@/fonts/custom-fonts-store";
import { useRafLoop } from "@/hooks/use-raf-loop";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { onRenderPerfFrameComplete } from "@/diagnostics/render-perf";
import {
	isPlaybackHudEnabled,
	playbackHud,
} from "@/diagnostics/playback-hud/recorder";
import { toast } from "sonner";
import {
	PREVIEW_RENDER_ERROR_TOAST_ID,
	previewEffectFailures,
	previewFrameTolerance,
	previewGpuErrors,
	previewRenderErrors,
	shouldRenderPreview,
} from "@/preview/render-gate";
import { drawPreviewScene, hudSinkFor, readPlaybackProbe } from "@/preview/preview-draw";
import { type PreviewNoticeSink, settlePreviewDraw } from "@/preview/settle-draw";
import { readGpuErrorStats } from "@/services/renderer/gpu-errors";
import { previewSourceDensity } from "@/services/renderer/source-scale";
import { previewRenderScale } from "@/services/renderer/compositor/scale-frame";
import { playbackLevers } from "@/services/playback-levers/store";
import { TICKS_PER_SECOND } from "@/wasm";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { PreviewOverlayLayer } from "./overlay-layer";
import { PreviewInteractionOverlay } from "./preview-interaction-overlay";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import type {
	PreviewOverlayControl,
	PreviewOverlayInstance,
} from "@/preview/overlays";
import { PreviewContextMenu } from "./context-menu";
import { PreviewToolbar } from "./toolbar";
import {
	PreviewViewportProvider,
	usePreviewViewportState,
} from "./preview-viewport";

/** The preview's notices: one toast with a fixed id (a new one replaces it) and one console line. */
const previewNotices: PreviewNoticeSink = {
	show: ({ level, title, description, duration }) => {
		const show = level === "error" ? toast.error : toast.warning;
		show(title, { id: PREVIEW_RENDER_ERROR_TOAST_ID, description, duration });
	},
	dismiss: () => {
		toast.dismiss(PREVIEW_RENDER_ERROR_TOAST_ID);
	},
	logError: ({ label, error }) => {
		console.error(label, error);
	},
};

function usePreviewSize() {
	const canvasSize = useEditor(
		(e) => e.project.getActive()?.settings.canvasSize,
	);

	return {
		width: canvasSize?.width,
		height: canvasSize?.height,
	};
}

function normalizeWheelDelta({
	delta,
	deltaMode,
	pageSize,
}: {
	delta: number;
	deltaMode: number;
	pageSize: number;
}): number {
	if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
		return delta * 16;
	}

	if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
		return delta * pageSize;
	}

	return delta;
}

export function PreviewPanel({
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const { toggleFullscreen } = useFullscreen({ containerRef });
	const handleContainerRef = useCallback((node: HTMLDivElement | null) => {
		containerRef.current = node;
		setContainer(node);
	}, []);

	return (
		<div
			ref={handleContainerRef}
			className="panel bg-background relative flex size-full min-h-0 min-w-0 flex-col rounded-sm border"
		>
			<PreviewCanvas
				container={container}
				onToggleFullscreen={toggleFullscreen}
				overlayControls={overlayControls}
				overlayInstances={overlayInstances}
				onOverlayVisibilityChange={onOverlayVisibilityChange}
			/>
			<RenderTreeController />
		</div>
	);
}

function RenderTreeController() {
	const editor = useEditor();
	const tracks = useEditor(
		(e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const activeProject = useEditor((e) => e.project.getActive());

	const { width, height } = usePreviewSize();
	// Importing or deleting a font changes how text renders without touching
	// the tracks, so the scene must be rebuilt for the preview to follow.
	const customFontsVersion = useCustomFontsStore((state) => state.version);

	useDeepCompareEffect(() => {
		if (!activeProject) return;

		const duration = editor.timeline.getTotalDuration();
		editor.renderer.setPreviewScene({
			params: {
				tracks,
				mediaAssets,
				duration,
				canvasSize: { width, height },
				background: activeProject.settings.background,
				isPreview: true,
			},
		});
	}, [
		tracks,
		mediaAssets,
		activeProject?.settings.background,
		width,
		height,
		customFontsVersion,
	]);

	return null;
}

function PreviewCanvas({
	container,
	onToggleFullscreen,
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	container: HTMLElement | null;
	onToggleFullscreen: () => void;
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const canvasMountRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastSceneRef = useRef<RootNode | null>(null);
	const matteRevisionRef = useRef(getMatteRevision());
	// Compositor draw serial right after the preview's own last draw: the
	// exporter and the snapshot renderers draw into the same canvas.
	const lastOwnSerialRef = useRef(-1);
	// Video frame tolerance of the preview's last draw (see `shouldRenderPreview`).
	const lastMaxStaleSecondsRef = useRef(0);
	// Source density of the preview's last draw (see `previewSourceDensity`).
	const lastSourceDensityRef = useRef<number | null>(null);
	// Compositor scale of the preview's last draw (see `previewRenderScale`).
	const lastRenderScaleRef = useRef(1);
	const renderingRef = useRef(false);
	const lastPrerollMsRef = useRef(0);
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const viewportSize = useContainerSize({ containerRef: viewportRef });
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const renderTree = useEditor((e) => e.renderer.getRenderTree());
	const viewport = usePreviewViewportState({
		canvasHeight: nativeHeight,
		canvasWidth: nativeWidth,
		viewportHeight: viewportSize.height,
		viewportRef,
		viewportWidth: viewportSize.width,
	});
	const { canPan, panByScreenDelta, scaleZoom } = viewport;
	// The scene's width on screen (CSS px), read by the draw loop without
	// recreating it on every zoom step.
	const sceneCssWidthRef = useCommittedRef(viewport.sceneWidth);

	const renderer = useMemo(() => {
		return new CanvasRenderer({
			width: nativeWidth,
			height: nativeHeight,
			fps: activeProject.settings.fps,
		});
	}, [nativeWidth, nativeHeight, activeProject.settings.fps]);

	// Mount the compositor's output canvas directly into the preview. wgpu
	// renders straight into this element, so there is no intermediate copy —
	// the container div owns positioning/styling, the canvas itself fills it.
	useEffect(() => {
		const mount = canvasMountRef.current;
		if (!mount) return;
		const outputCanvas = renderer.getOutputCanvas();
		outputCanvas.style.display = "block";
		outputCanvas.style.width = "100%";
		outputCanvas.style.height = "100%";
		mount.appendChild(outputCanvas);
		return () => {
			if (outputCanvas.parentElement === mount) {
				mount.removeChild(outputCanvas);
			}
		};
	}, [renderer]);

	const render = useCallback(() => {
		if (!renderTree || renderingRef.current) return;

		// A cutout was added or removed: draw the paused frame again.
		const matteRevision = getMatteRevision();
		if (matteRevisionRef.current !== matteRevision) {
			matteRevisionRef.current = matteRevision;
			lastSceneRef.current = null;
		}

		const isPlaying = editor.playback.getIsPlaying();
		const hudEnabled = isPlaybackHudEnabled();
		if (hudEnabled) {
			playbackHud.tick({ playing: isPlaying, nowMs: performance.now() });
		} else {
			playbackHud.deactivate();
		}

		const renderTime = Math.min(
			editor.playback.getCurrentTime(),
			editor.timeline.getLastFrameTime(),
		);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);
		const frame = Math.floor(renderTime / ticksPerFrame);
		// While playing, a video frame the decoder has not delivered yet may be
		// replaced by a slightly older one instead of stalling the draw; paused
		// seeks (and the exporter, which never comes through here) stay exact.
		const isScrubbing = editor.playback.getIsScrubbing();
		// The next clips' decoders start before the playhead gets there (a cut would show late otherwise);
		// scrubbing and exporting release what was opened ahead. Every 100 ms is often enough.
		const nowMs = performance.now();
		if (nowMs - lastPrerollMsRef.current >= 100) {
			lastPrerollMsRef.current = nowMs;
			if (!isScrubbing && !editor.project.getExportState().isExporting) {
				const request = prerollRequestFor({
					clips: videoClipsOf({ root: renderTree }),
					timeSeconds: editor.playback.getCurrentTime() / TICKS_PER_SECOND,
					playing: isPlaying,
				});
				void videoCache.prefetchClips({ ...request, allowWorker: true });
			} else {
				void videoCache.prefetchClips({ clips: [], allowWorker: true });
			}
		}
		const maxStaleSeconds = previewFrameTolerance({ isPlaying, isScrubbing });
		// While playing or scrubbing, video frames are drawn at about their size
		// on screen; paused (null) at full resolution, as an export would.
		const sourceDensity = previewSourceDensity({
			isPlaying,
			isScrubbing,
			sceneCssWidth: sceneCssWidthRef.current,
			canvasWidth: renderer.width,
			devicePixelRatio: window.devicePixelRatio,
		});
		// The display-size lever: composite at about the size on screen while
		// playing or scrubbing; paused (density null) it is 1, full size.
		const renderScale = previewRenderScale({
			displayResolution: playbackLevers().displayResolution,
			sourceDensity,
		});

		if (
			!shouldRenderPreview({
				isExporting: editor.project.getExportState().isExporting,
				frame,
				lastFrame: lastFrameRef.current,
				scene: renderTree,
				lastScene: lastSceneRef.current,
				compositorSerial: wasmCompositor.getDrawSerial(),
				lastOwnSerial: lastOwnSerialRef.current,
				maxStaleSeconds,
				lastMaxStaleSeconds: lastMaxStaleSecondsRef.current,
				sourceDensity,
				lastSourceDensity: lastSourceDensityRef.current,
				renderScale,
				lastRenderScale: lastRenderScaleRef.current,
			})
		) {
			return;
		}

		renderingRef.current = true;
		lastSceneRef.current = renderTree;
		lastFrameRef.current = frame;
		lastMaxStaleSecondsRef.current = maxStaleSeconds;
		lastSourceDensityRef.current = sourceDensity;
		lastRenderScaleRef.current = renderScale;
		const before = hudEnabled ? readPlaybackProbe() : null;
		// Not again with the effects that failed for this scene (until an edit).
		const effectsFirst = previewEffectFailures.tryEffects(renderTree);
		drawPreviewScene({
			renderer,
			scene: renderTree,
			time: renderTime,
			preview: { sourceDensity, renderScale },
			maxStaleSeconds,
			effectsFirst,
			isExporting: () => editor.project.getExportState().isExporting,
		}).then((result) => {
			lastOwnSerialRef.current = result.serial;
			renderingRef.current = false;
			// window.__renderPerf summaries count preview draws as frames too.
			onRenderPerfFrameComplete();
			settlePreviewDraw({
				result,
				scene: renderTree,
				effectsFirst,
				nowMs: performance.now(),
				projectId: editor.project.getActive()?.metadata.id,
				gpuStats: readGpuErrorStats(),
				memory: previewEffectFailures,
				reporter: previewRenderErrors,
				gpuWatcher: previewGpuErrors,
				notices: previewNotices,
				hud: before ? hudSinkFor({ before, renderer }) : null,
			});
		});
	}, [
		renderer,
		renderTree,
		editor.playback,
		editor.timeline,
		editor.project,
		sceneCssWidthRef,
	]);

	useRafLoop(render);

	useEffect(() => {
		const container = viewportRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let pendingPanDeltaX = 0;
		let pendingPanDeltaY = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;
		let panRafId: ReturnType<typeof requestAnimationFrame> | null = null;

		const onWheel = (event: WheelEvent) => {
			const normalizedDeltaX = normalizeWheelDelta({
				delta: event.deltaX,
				deltaMode: event.deltaMode,
				pageSize: container.clientWidth,
			});
			const normalizedDeltaY = normalizeWheelDelta({
				delta: event.deltaY,
				deltaMode: event.deltaMode,
				pageSize: container.clientHeight,
			});
			const isZoomGesture = event.ctrlKey || event.metaKey;
			if (isZoomGesture) {
				event.preventDefault();
				pendingZoomDelta += normalizedDeltaY;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const cappedDelta =
							Math.sign(pendingZoomDelta) *
							Math.min(Math.abs(pendingZoomDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);

						scaleZoom({ factor: zoomFactor });
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}

				return;
			}

			if (!canPan) {
				return;
			}

			if (normalizedDeltaX === 0 && normalizedDeltaY === 0) {
				return;
			}

			event.preventDefault();
			pendingPanDeltaX += normalizedDeltaX;
			pendingPanDeltaY += normalizedDeltaY;

			if (panRafId === null) {
				panRafId = requestAnimationFrame(() => {
					panByScreenDelta({
						deltaX: pendingPanDeltaX,
						deltaY: pendingPanDeltaY,
					});
					pendingPanDeltaX = 0;
					pendingPanDeltaY = 0;
					panRafId = null;
				});
			}
		};

		container.addEventListener("wheel", onWheel, {
			capture: true,
			passive: false,
		});

		return () => {
			container.removeEventListener("wheel", onWheel, {
				capture: true,
			});
			if (zoomRafId !== null) {
				cancelAnimationFrame(zoomRafId);
			}
			if (panRafId !== null) {
				cancelAnimationFrame(panRafId);
			}
		};
	}, [canPan, panByScreenDelta, scaleZoom]);

	return (
		<PreviewViewportProvider value={viewport}>
			<div className="flex size-full min-h-0 min-w-0 flex-col">
				<div className="flex min-h-0 min-w-0 flex-1 p-2 pb-0">
					<ContextMenu>
						<ContextMenuTrigger asChild>
							<div
								ref={viewportRef}
								className="relative flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden"
							>
							<div
								ref={canvasMountRef}
								className="absolute block border"
								style={{
									left: viewport.sceneLeft,
									top: viewport.sceneTop,
									width: viewport.sceneWidth,
									height: viewport.sceneHeight,
									background:
										activeProject.settings.background.type === "blur"
											? "transparent"
											: activeProject?.settings.background.color,
								}}
							/>
								<PreviewOverlayLayer
									instances={overlayInstances}
									plane="under-interaction"
								/>
								<PreviewInteractionOverlay />
								<PreviewOverlayLayer
									instances={overlayInstances}
									plane="over-interaction"
								/>
							</div>
						</ContextMenuTrigger>
						<PreviewContextMenu
							onToggleFullscreen={onToggleFullscreen}
							container={container}
							overlayControls={overlayControls}
							onOverlayVisibilityChange={onOverlayVisibilityChange}
						/>
					</ContextMenu>
				</div>
				<PreviewToolbar onToggleFullscreen={onToggleFullscreen} />
			</div>
		</PreviewViewportProvider>
	);
}
