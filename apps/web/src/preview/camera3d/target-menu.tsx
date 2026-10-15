"use client";

import { Fragment } from "react";
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
	targetMenuSections,
	type TargetMenuItem,
	type TargetMenuItemId,
} from "@/tracking/camera3d/ui/menu-model";

const REASON_CLASS = "text-muted-foreground text-xs font-normal";

/**
 * The target's right-click menu (AE spec section 4) drawn from the model.
 * Disabled items cannot take focus, so the reasons are written as text
 * under their section (or once at the top) where everyone can read them.
 */
export function TargetMenuContent({
	items,
	container,
	onChoose,
}: {
	items: readonly TargetMenuItem[];
	container: HTMLElement | null;
	onChoose: (id: TargetMenuItemId) => void;
}) {
	const { commonReason, sections } = targetMenuSections(items);
	return (
		<ContextMenuContent className="w-72" container={container} aria-label="Track Camera">
			{commonReason ? (
				<ContextMenuLabel inset className={REASON_CLASS}>
					{commonReason}
				</ContextMenuLabel>
			) : null}
			{sections.map((section, index) => (
				<Fragment key={section.items[0].group}>
					{index > 0 ? <ContextMenuSeparator /> : null}
					{section.items.map((item) => (
						<ContextMenuItem
							key={item.id}
							inset
							disabled={!item.enabled}
							variant={item.destructive ? "destructive" : "default"}
							textRight={item.hint ?? undefined}
							onSelect={() => onChoose(item.id)}
						>
							{item.label}
						</ContextMenuItem>
					))}
					{section.reasons.map((reason) => (
						<ContextMenuLabel key={reason} inset className={REASON_CLASS}>
							{reason}
						</ContextMenuLabel>
					))}
				</Fragment>
			))}
		</ContextMenuContent>
	);
}
