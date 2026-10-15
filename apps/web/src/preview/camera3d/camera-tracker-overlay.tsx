"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { toast } from "sonner";
import { useActionHandler } from "@/actions/use-action-handler";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { registerCanceller } from "@/editor/cancel-interaction";
import { useEditor } from "@/editor/use-editor";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import type { Vec3 } from "@/scene3d/types";
import type { VideoElement } from "@/timeline";
import {
	getCameraTrackerApi,
	useCameraTrackerSession,
	type CameraTrackerApi,
	type DecodedCameraTracker,
} from "@/tracking/camera3d/session";
import { buildBanner } from "@/tracking/camera3d/ui/banner-model";
import type { Point2 } from "@/tracking/camera3d/ui/delaunay";
import { pointInPolygon } from "@/tracking/camera3d/ui/hit-test";
import {
	contextMenuSubject,
	dragGesture,
	pointKeyAction,
	pressGesture,
	releaseGesture,
	showHoverTarget,
	trackCameraPlan,
	type Gesture,
} from "@/tracking/camera3d/ui/interaction";
import {
	buildTargetMenu,
	hasCameraForClipAt,
	menuCommand,
	type TargetMenuItemId,
} from "@/tracking/camera3d/ui/menu-model";
import {
	buildOverlayScene,
	hoverAt,
	pressRole,
	selectionHitAt,
	selectionTarget,
	trackIdsInRegion,
	type Hover,
} from "@/tracking/camera3d/ui/overlay-scene";
import { useCameraPointsStore } from "@/tracking/camera3d/ui/points-store";
import {
	keepSelectable,
	selectInRegion,
	selectOnClick,
	type Selection,
} from "@/tracking/camera3d/ui/selection";
import {
	movedTargetCenter,
	resizedTargetSize,
	targetFromPoints,
	targetMoveOffset,
	targetOutline,
} from "@/tracking/camera3d/ui/target";
import {
	callEngine,
	createTrackedLayers,
	runCameraTracker,
} from "@/tracking/components/camera3d/camera-tracker-actions";
import { isTypableDOMElement } from "@/utils/browser";
import { CameraPointsView } from "./camera-points-view";
import { CameraTrackerBanner } from "./camera-tracker-banner";
import { ImagePickerDialog } from "./image-picker-dialog";
import { buildPointsDrawing } from "./points-drawing";
import { TargetMenuContent } from "./target-menu";

/** The properties tab id of the video clip's Tracking tab (`registry.tsx`). */
export const CAMERA_TRACKER_TAB_ID = "tracking";

/** Pointer distance (screen pixels) within which a "+" marker is hit. */
const POINT_HIT_PX = 6;
/** The target's centre area (moved by dragging, resized by Alt-dragging), as a share of its radius. */
const MOVE_HANDLE_FACTOR = 0.5;

/**
 * Track Camera over the preview: the banner (always), the `track-camera`
 * action and Esc-to-cancel (always), and the track points layer while the
 * tracked video clip is selected with its Tracking tab open.
 */
export function CameraTrackerOverlay() {
	const editor = useEditor();
	const selectedRefs = useEditor((e) => e.selection.getSelectedElements());
	useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);
	const activeVideoTab = usePropertiesStore((state) => state.activeTabPerType.video);
	const phase = useCameraTrackerSession((state) => state.phase);
	const outcomes = useCameraTrackerSession((state) => state.outcomes);
	const api = getCameraTrackerApi();

	const selected = editor.timeline.getElementsWithTracks({ elements: selectedRefs });
	const single = selected.length === 1 ? selected[0] : null;
	const clip =
		single?.element.type === "video" && activeVideoTab === CAMERA_TRACKER_TAB_ID
			? single.element
			: null;
	const decoded = clip && api ? api.decoded({ elementId: clip.id }) : null;

	useActionHandler(
		"track-camera",
		() => {
			const current = getCameraTrackerApi();
			const plan = trackCameraPlan({
				selected: editor.timeline
					.getElementsWithTracks({ elements: editor.selection.getSelectedElements() })
					.map(({ element }) => element),
				apiReady: current !== null,
				phase: useCameraTrackerSession.getState().phase,
			});
			if (plan.kind === "message" || !current) {
				if (plan.kind === "message") toast.info(plan.message);
				return;
			}
			usePropertiesStore
				.getState()
				.setActiveTab({ elementType: "video", tabId: CAMERA_TRACKER_TAB_ID });
			void runCameraTracker({ api: current, elementId: plan.elementId, mode: "track" });
		},
		undefined,
	);

	// Esc stops a running analysis or solve (the editor's cancel-interaction pattern)
	const running = phase.phase !== "idle";
	useEffect(() => {
		if (!running) return;
		return registerCanceller({ fn: () => getCameraTrackerApi()?.cancel() });
	}, [running]);

	const banner = buildBanner({
		phase,
		active: clip
			? { elementId: clip.id, data: decoded?.data ?? null, outcome: outcomes[clip.id] }
			: null,
	});

	return (
		<div className="absolute inset-0">
			{clip && decoded && api ? (
				<CameraPointsLayer key={clip.id} clip={clip} decoded={decoded} api={api} />
			) : null}
			<CameraTrackerBanner
				banner={banner}
				onCancel={() => api?.cancel()}
				onAction={() => {
					if (!api || !clip || banner?.kind !== "stale") return;
					void runCameraTracker({
						api,
						elementId: clip.id,
						mode: banner.action === "resolve" ? "resolve" : "track",
					});
				}}
			/>
		</div>
	);
}

type TargetDrag =
	| { kind: "move"; offset: Vec3; center: Vec3 }
	| { kind: "resize"; size: number };

interface PointerState {
	hover: Hover;
	/** On the selection's target (right-click opens its menu). */
	inSelectionTarget: boolean;
	/** On its centre area (drag moves, Alt-drag resizes). */
	inMoveHandle: boolean;
}

const NO_POINTER: PointerState = {
	hover: { trackId: null, triangleIds: null, triangle: null },
	inSelectionTarget: false,
	inMoveHandle: false,
};

const IDLE: Gesture = { kind: "idle" };

function CameraPointsLayer({
	clip,
	decoded,
	api,
}: {
	clip: VideoElement;
	decoded: DecodedCameraTracker;
	api: CameraTrackerApi;
}) {
	const viewport = usePreviewViewport();
	const time = useEditor((e) => e.playback.getCurrentTime());
	const canvasWidth = useEditor((e) => e.project.getActive().settings.canvasSize.width);
	const canvasHeight = useEditor((e) => e.project.getActive().settings.canvasSize.height);
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const images = useEditor((e) => e.media.getAssets().filter((asset) => asset.type === "image"));
	const busy = useCameraTrackerSession((state) => state.phase.phase !== "idle");
	const selection = useCameraPointsStore((state) => state.selectionFor({ elementId: clip.id }));
	const centerOverride = useCameraPointsStore((state) =>
		state.elementId === clip.id ? state.centerOverride : null,
	);
	const [pointer, setPointer] = useState<PointerState>(NO_POINTER);
	const [gesture, setGesture] = useState<Gesture>(IDLE);
	const [drag, setDrag] = useState<TargetDrag | null>(null);
	const [picking, setPicking] = useState(false);
	const releaseCancellerRef = useRef<(() => void) | null>(null);
	// a gesture's Esc canceller must not outlive the layer (clip deselected mid-drag)
	useEffect(
		() => () => {
			releaseCancellerRef.current?.();
			releaseCancellerRef.current = null;
		},
		[],
	);

	const { data, tracks: featureTracks, solve, deleted } = decoded;
	const scene = useMemo(
		() =>
			buildOverlayScene({
				decoded: { elementId: clip.id, data, tracks: featureTracks, solve, deleted },
				clip,
				time,
				canvasWidth,
				canvasHeight,
			}),
		[clip, data, featureTracks, solve, deleted, time, canvasWidth, canvasHeight],
	);
	const view = scene?.view ?? null;
	const settings = data.settings;
	const select = (next: Selection) =>
		useCameraPointsStore.getState().select({ elementId: clip.id, selection: next });

	// the solve's world changed (re-solve, ground plane): a dragged centre no longer means anything
	const storedSolve = data.solve;
	useEffect(() => {
		useCameraPointsStore.getState().resetTargetCenter();
	}, [storedSolve]);

	// deleted points, or points the new solve dropped, leave the selection
	useEffect(() => {
		const kept = keepSelectable({
			selection,
			selectable: (id) => !deleted.has(id) && (scene?.solved.has(id) ?? false),
		});
		if (kept !== selection) {
			useCameraPointsStore.getState().select({ elementId: clip.id, selection: kept });
		}
	}, [selection, deleted, scene, clip.id]);

	// Esc clears the point selection; Delete / Backspace deletes the points, not the clip
	const hasSelection = selection.length > 0;
	useEffect(() => {
		if (!hasSelection) return;
		return registerCanceller({
			fn: () => useCameraPointsStore.getState().select({ elementId: clip.id, selection: [] }),
		});
	}, [hasSelection, clip.id]);
	useEffect(() => {
		if (!hasSelection) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (useKeybindingsStore.getState().overlayDepth > 0) return;
			const active = document.activeElement;
			const action = pointKeyAction({
				key: event.key,
				hasSelection: true,
				isTyping: active instanceof HTMLElement && isTypableDOMElement({ element: active }),
				ctrl: event.ctrlKey,
				meta: event.metaKey,
				alt: event.altKey,
			});
			if (action !== "delete") return;
			event.preventDefault();
			event.stopPropagation();
			const trackIds = useCameraPointsStore.getState().selectionFor({ elementId: clip.id });
			callEngine(() => api.deletePoints({ elementId: clip.id, trackIds }));
			useCameraPointsStore.getState().select({ elementId: clip.id, selection: [] });
		};
		// capture on window: before the editor's shortcut listener on document
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [hasSelection, api, clip.id]);

	if (!scene) return null;

	const targetSize = drag?.kind === "resize" ? drag.size : settings.targetSize;
	const selTarget = view
		? selectionTarget({
				selection,
				solved: scene.solved,
				view,
				targetSize,
				centerOverride: drag?.kind === "move" ? drag.center : centerOverride,
			})
		: null;
	const selOutline = selTarget && view ? targetOutline({ target: selTarget, view }) : null;
	const moveHandle =
		selTarget && view
			? targetOutline({ target: selTarget, view, radiusFactor: MOVE_HANDLE_FACTOR })
			: null;
	const idle = gesture.kind === "idle" && drag === null;
	const hoveredIds = pointer.hover.triangleIds;
	const showHover =
		idle &&
		showHoverTarget({
			hoveredIds,
			selection,
			pointerInSelectionTarget: pointer.inSelectionTarget,
		});
	const hoverTarget =
		showHover && view && hoveredIds
			? targetFromPoints({
					points: hoveredIds.flatMap((id) => {
						const position = scene.solved.get(id);
						return position ? [position] : [];
					}),
					camera: view,
					targetSize: settings.targetSize,
				})
			: null;
	const toOverlay = (point: Point2) =>
		viewport.canvasToOverlay({ canvasX: point.x, canvasY: point.y });
	const drawing = buildPointsDrawing({
		scene,
		selection,
		hoverTriangle: showHover ? pointer.hover.triangle : null,
		target: showHover ? hoverTarget : selTarget,
		gesture,
		toOverlay,
	});
	const interactive = view !== null;
	const subject = idle
		? contextMenuSubject({
				pointerInSelectionTarget: pointer.inSelectionTarget,
				hoveredIds,
				selection,
			})
		: null;
	const menuItems = buildTargetMenu({
		apiReady: true,
		hasSolve: solve !== null,
		busy,
		selectedCount: selection.length,
		hasCameraAtPlayhead: tracks
			? hasCameraForClipAt({ tracks, sourceElementId: clip.id, time })
			: false,
		imageCount: images.length,
	});

	const pointRadius = viewport.screenPixelsToLogicalThreshold({ screenPixels: POINT_HIT_PX }).x;
	const canvasAt = (event: React.PointerEvent) =>
		viewport.screenToCanvas({ clientX: event.clientX, clientY: event.clientY });
	const endInteraction = () => {
		setGesture(IDLE);
		setDrag(null);
		releaseCancellerRef.current?.();
		releaseCancellerRef.current = null;
	};
	const armCanceller = () => {
		releaseCancellerRef.current?.();
		releaseCancellerRef.current = registerCanceller({
			fn: () => {
				releaseCancellerRef.current = null;
				setGesture(IDLE);
				setDrag(null);
			},
		});
	};

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (viewport.handlePanPointerDown({ event })) return;
		if (event.button !== 0) return;
		const at = canvasAt(event);
		if (!at) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const role = pressRole({ at, alt: event.altKey, moveHandle });
		if (role === "resize-target") {
			setDrag({ kind: "resize", size: settings.targetSize });
		} else if (role === "move-target" && selTarget && view) {
			const offset = targetMoveOffset({ target: selTarget, view, canvasPoint: at });
			if (!offset) return;
			setDrag({ kind: "move", offset, center: selTarget.center });
		} else {
			setGesture(
				pressGesture({
					at,
					screen: { x: event.clientX, y: event.clientY },
					shift: event.shiftKey,
					alt: event.altKey,
				}),
			);
		}
		armCanceller();
	};

	const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		if (viewport.handlePanPointerMove({ event })) return;
		const at = canvasAt(event);
		if (!at) return;
		if (drag && selTarget && view) {
			if (drag.kind === "move") {
				const center = movedTargetCenter({ target: selTarget, view, canvasPoint: at, offset: drag.offset });
				if (center) setDrag({ ...drag, center });
			} else {
				const size = resizedTargetSize({ target: selTarget, view, canvasPoint: at });
				if (size !== null) setDrag({ kind: "resize", size });
			}
			return;
		}
		if (gesture.kind !== "idle") {
			setGesture(dragGesture({ gesture, at, screen: { x: event.clientX, y: event.clientY } }));
			return;
		}
		setPointer({
			hover: hoverAt({ scene, at, pointRadius }),
			inSelectionTarget: selOutline !== null && pointInPolygon({ polygon: selOutline, p: at }),
			inMoveHandle: moveHandle !== null && pointInPolygon({ polygon: moveHandle, p: at }),
		});
	};

	const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
		if (viewport.handlePanPointerUp({ event })) return;
		if (drag) {
			if (drag.kind === "move") {
				useCameraPointsStore.getState().moveTarget({ center: drag.center });
			} else if (Math.round(drag.size) !== settings.targetSize) {
				const size = Math.round(drag.size);
				callEngine(() =>
					api.updateSettings({ elementId: clip.id, patch: { targetSize: size } }),
				);
			}
			endInteraction();
			return;
		}
		const end = releaseGesture(gesture);
		endInteraction();
		if (end.kind === "click") {
			select(
				selectOnClick({
					selection,
					hit: selectionHitAt({ scene, at: end.at, pointRadius }),
					shift: end.shift,
				}),
			);
		} else if (end.kind === "rect" || end.kind === "polygon") {
			const trackIds = trackIdsInRegion({
				scene,
				region:
					end.kind === "rect"
						? { kind: "rect", from: end.from, to: end.to }
						: { kind: "polygon", polygon: end.polygon },
			});
			select(selectInRegion({ selection, trackIds, shift: end.shift }));
		}
	};

	const choose = ({ itemId, mediaId }: { itemId: TargetMenuItemId; mediaId?: string }) => {
		if (!selTarget) return;
		const command = menuCommand({
			itemId,
			elementId: clip.id,
			target: selTarget,
			selection,
			frame: scene.frame,
			mediaId,
		});
		switch (command.kind) {
			case "pick-image":
				setPicking(true);
				return;
			case "create":
				createTrackedLayers({ api, args: command.args });
				return;
			case "ground-plane":
				callEngine(() => api.setGroundPlane({ elementId: clip.id, target: command.target }));
				useCameraPointsStore.getState().resetTargetCenter();
				return;
			case "delete":
				callEngine(() => api.deletePoints({ elementId: clip.id, trackIds: command.trackIds }));
				select([]);
				return;
		}
	};

	const cursor = viewport.isPanning
		? "grabbing"
		: drag?.kind === "resize"
			? "ew-resize"
			: drag?.kind === "move" || pointer.inMoveHandle
				? "move"
				: "default";

	return (
		<>
			<CameraPointsView drawing={drawing} />
			{interactive ? (
				<ContextMenu
					onOpenChange={(open) => {
						// AE: right-clicking a hovered triangle selects its points first
						if (open && subject?.kind === "triangle") select(subject.trackIds);
					}}
				>
					<ContextMenuTrigger asChild disabled={subject === null}>
						<div
							className="absolute inset-0 select-none"
							role="application"
							aria-label="Track points"
							style={{ pointerEvents: "auto", cursor }}
							onPointerDown={onPointerDown}
							onPointerMove={onPointerMove}
							onPointerUp={onPointerUp}
							onPointerCancel={endInteraction}
							onPointerLeave={() => {
								if (idle) setPointer(NO_POINTER);
							}}
						/>
					</ContextMenuTrigger>
					<TargetMenuContent
						items={menuItems}
						container={
							document.fullscreenElement instanceof HTMLElement
								? document.fullscreenElement
								: null
						}
						onChoose={(itemId) => choose({ itemId })}
					/>
				</ContextMenu>
			) : null}
			<ImagePickerDialog
				open={picking}
				images={images}
				onOpenChange={setPicking}
				onPick={(mediaId) => {
					setPicking(false);
					choose({ itemId: "create-image", mediaId });
				}}
			/>
		</>
	);
}
