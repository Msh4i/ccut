"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import type { PinNotice, PinNoticeAction } from "../camera/pin-view";

/**
 * The notices of "Stick to scene" (plan section d, "SINIR DURUMLARI"): plain
 * text, yellow, the element is left as it was. The region is always mounted so
 * a screen reader announces a notice when it appears.
 */
export function PinNotices({
	notices,
	onAction,
	actionsDisabled = false,
}: {
	notices: readonly PinNotice[];
	onAction: ({ action }: { action: PinNoticeAction }) => void;
	/** A notice's action starts a run: not while one is in flight. */
	actionsDisabled?: boolean;
}) {
	return (
		<div role="status" aria-live="polite" className="flex flex-col gap-1.5">
			{notices.map((notice) => (
				<div
					key={notice.id}
					className="bg-caution/10 flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs"
				>
					<HugeiconsIcon
						icon={Alert02Icon}
						size={14}
						className="text-caution mt-px shrink-0"
						aria-hidden="true"
					/>
					<span className="min-w-0 flex-1">{notice.text}</span>
					{notice.action ? (
						<Button
							variant="outline"
							size="sm"
							className="shrink-0"
							disabled={actionsDisabled}
							onClick={() => {
								if (notice.action) onAction({ action: notice.action });
							}}
						>
							{notice.action.label}
						</Button>
					) : null}
				</div>
			))}
		</div>
	);
}
