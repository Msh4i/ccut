import type {
	PreviewOverlayInstance,
	PreviewOverlaySourceResult,
} from "@/preview/overlays";
import { CameraTrackerOverlay } from "./camera-tracker-overlay";

/**
 * Track Camera's preview overlay: one viewport-wide instance above the
 * transform handles. The wrapper lets every pointer event through; the
 * overlay itself only takes them while the tracked clip's Tracking tab is
 * open (its track points layer) and on the banner's buttons.
 */
const CAMERA_TRACKER_OVERLAY: PreviewOverlayInstance = {
	id: "camera-tracker",
	mount: { kind: "viewport" },
	plane: "over-interaction",
	pointerEvents: "none",
	zIndex: 10,
	render: () => <CameraTrackerOverlay />,
};

export const CAMERA_TRACKER_OVERLAY_SOURCE: PreviewOverlaySourceResult = {
	definitions: [],
	instances: [CAMERA_TRACKER_OVERLAY],
};
