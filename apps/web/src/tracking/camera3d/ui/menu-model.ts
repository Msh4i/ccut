import type { Target } from "@/scene3d/types";
import type { SceneTracks } from "@/timeline";
import { addMediaTime, type MediaTime } from "@/wasm";
import {
	CAMERA_TRACKER_NOT_READY_MESSAGE,
	type CreatableLayerKind,
	type CreateTrackedLayersArgs,
} from "../session";
import type { Selection } from "./selection";

/**
 * AE's right-click menu on the target (spec section 4). "Create Shadow
 * Catcher, Camera and Light" is not offered: Ccut has no lights or shadows
 * (P2).
 */

export type TargetMenuItemId =
	| "create-text"
	| "create-solid"
	| "create-null"
	| "create-image"
	| "create-multiple-text"
	| "create-multiple-solid"
	| "create-multiple-null"
	| "set-ground-plane"
	| "delete-points";

export interface TargetMenuItem {
	id: TargetMenuItemId;
	label: string;
	enabled: boolean;
	/** Why the item is disabled; `null` when it is enabled. */
	reason: string | null;
	/** Short text drawn on the right (the point count, "across time"). */
	hint: string | null;
	destructive: boolean;
	/** Consecutive items of a group are drawn together, with a separator between groups. */
	group: "create" | "multiple" | "scene" | "delete";
}

export const MENU_REASONS = {
	noSolve: "Solve the camera first.",
	busy: "Wait until Track Camera finishes.",
	noSelection: "Select track points first.",
	multiple: "Select two or more track points to create one layer per point.",
	noImage: "Add an image to the project to create an image layer.",
} as const;

/** What blocks every item, in order of precedence; `null` when the menu is usable. */
function blockingReason({
	apiReady,
	hasSolve,
	busy,
	selectedCount,
}: {
	apiReady: boolean;
	hasSolve: boolean;
	busy: boolean;
	selectedCount: number;
}): string | null {
	if (!apiReady) return CAMERA_TRACKER_NOT_READY_MESSAGE;
	if (!hasSolve) return MENU_REASONS.noSolve;
	if (busy) return MENU_REASONS.busy;
	if (selectedCount < 1) return MENU_REASONS.noSelection;
	return null;
}

export function buildTargetMenu({
	apiReady,
	hasSolve,
	busy,
	selectedCount,
	hasCameraAtPlayhead,
	imageCount,
}: {
	apiReady: boolean;
	hasSolve: boolean;
	busy: boolean;
	selectedCount: number;
	hasCameraAtPlayhead: boolean;
	imageCount: number;
}): TargetMenuItem[] {
	const blocked = blockingReason({ apiReady, hasSolve, busy, selectedCount });
	const suffix = hasCameraAtPlayhead ? "" : " and Camera";
	const item = ({
		id,
		label,
		group,
		reason = null,
		hint = null,
		destructive = false,
	}: {
		id: TargetMenuItemId;
		label: string;
		group: TargetMenuItem["group"];
		reason?: string | null;
		hint?: string | null;
		destructive?: boolean;
	}): TargetMenuItem => {
		const why = blocked ?? reason;
		return { id, label, enabled: why === null, reason: why, hint, destructive, group };
	};
	const multipleReason = selectedCount >= 2 ? null : MENU_REASONS.multiple;
	const count = selectedCount >= 2 ? String(selectedCount) : null;
	return [
		item({ id: "create-text", label: `Create Text${suffix}`, group: "create" }),
		item({ id: "create-solid", label: `Create Solid${suffix}`, group: "create" }),
		item({ id: "create-null", label: `Create Null${suffix}`, group: "create" }),
		item({
			id: "create-image",
			label: `Create Image${suffix}...`,
			group: "create",
			reason: imageCount > 0 ? null : MENU_REASONS.noImage,
		}),
		item({
			id: "create-multiple-text",
			label: "Create Multiple Text Layers",
			group: "multiple",
			reason: multipleReason,
			hint: count,
		}),
		item({
			id: "create-multiple-solid",
			label: "Create Multiple Solids",
			group: "multiple",
			reason: multipleReason,
			hint: count,
		}),
		item({
			id: "create-multiple-null",
			label: "Create Multiple Nulls",
			group: "multiple",
			reason: multipleReason,
			hint: count,
		}),
		item({ id: "set-ground-plane", label: "Set Ground Plane and Origin", group: "scene" }),
		item({
			id: "delete-points",
			label: "Delete Selected Points",
			group: "delete",
			// P1 deletes whole feature tracks (architecture 2.3)
			hint: "across time",
			destructive: true,
		}),
	];
}

export interface TargetMenuSection {
	items: TargetMenuItem[];
	/** Why items of this section are disabled, each reason once. */
	reasons: string[];
}

/**
 * The menu as drawn: consecutive items of a group form a section with its
 * reasons under it; a reason that disables every item is said once, at the
 * top, instead of under each section.
 */
export function targetMenuSections(items: readonly TargetMenuItem[]): {
	commonReason: string | null;
	sections: TargetMenuSection[];
} {
	const first = items[0]?.reason ?? null;
	const commonReason =
		first !== null && items.every((item) => item.reason === first) ? first : null;
	const sections: TargetMenuSection[] = [];
	for (const item of items) {
		const last = sections[sections.length - 1];
		if (last && last.items[0].group === item.group) {
			last.items.push(item);
		} else {
			sections.push({ items: [item], reasons: [] });
		}
	}
	if (commonReason === null) {
		for (const section of sections) {
			section.reasons = [
				...new Set(section.items.flatMap((item) => (item.reason ? [item.reason] : []))),
			];
		}
	}
	return { commonReason, sections };
}

const LAYER_KIND: Partial<Record<TargetMenuItemId, CreatableLayerKind>> = {
	"create-text": "text",
	"create-solid": "solid",
	"create-null": "null",
	"create-image": "image",
	"create-multiple-text": "text",
	"create-multiple-solid": "solid",
	"create-multiple-null": "null",
};

export type MenuCommand =
	| { kind: "create"; args: CreateTrackedLayersArgs }
	| { kind: "pick-image" }
	| { kind: "ground-plane"; target: Target }
	| { kind: "delete"; trackIds: Selection };

/** What a chosen item asks the engine to do (Create Image... first opens the picker). */
export function menuCommand({
	itemId,
	elementId,
	target,
	selection,
	frame,
	mediaId,
}: {
	itemId: TargetMenuItemId;
	elementId: string;
	target: Target;
	selection: Selection;
	frame: number;
	mediaId?: string;
}): MenuCommand {
	if (itemId === "set-ground-plane") return { kind: "ground-plane", target };
	if (itemId === "delete-points") return { kind: "delete", trackIds: selection };
	if (itemId === "create-image" && mediaId === undefined) return { kind: "pick-image" };
	const multiple = itemId.startsWith("create-multiple-");
	const args: CreateTrackedLayersArgs = {
		elementId,
		kind: LAYER_KIND[itemId] ?? null,
		multiple,
		target,
		trackIds: selection,
		frame,
	};
	return {
		kind: "create",
		args: itemId === "create-image" ? { ...args, mediaId } : args,
	};
}

/**
 * Whether a camera layer made from this clip covers `time` (AE drops "and
 * Camera" from the menu then). Hidden cameras and hidden camera tracks do
 * not count: they do not drive the 3D layers.
 */
export function hasCameraForClipAt({
	tracks,
	sourceElementId,
	time,
}: {
	tracks: SceneTracks;
	sourceElementId: string;
	time: MediaTime;
}): boolean {
	for (const track of tracks.overlay) {
		if (track.type !== "camera" || track.hidden) continue;
		for (const element of track.elements) {
			if (element.sourceElementId !== sourceElementId || element.hidden) continue;
			const end = addMediaTime({ a: element.startTime, b: element.duration });
			if (time >= element.startTime && time < end) return true;
		}
	}
	return false;
}
