import { Button } from "@/components/ui/button";
import { bannerAnnouncement, type BannerModel } from "@/tracking/camera3d/ui/banner-model";
import { cn } from "@/utils/ui";

const TONES: Record<BannerModel["kind"], string> = {
	analyzing: "bg-secondary/95 border-secondary-border text-secondary-foreground",
	solving: "bg-background/95 border-caution/45 text-caution",
	failed: "bg-background/95 border-destructive/50 text-destructive",
	stale: "bg-background/95 border-caution/45 text-caution",
};

/**
 * AE's banner over the footage. The polite live region is always mounted
 * and only holds the phase or message text, so a screen reader hears each
 * phase change once, not every percent.
 */
export function CameraTrackerBanner({
	banner,
	onCancel,
	onAction,
}: {
	banner: BannerModel | null;
	onCancel: () => void;
	onAction: () => void;
}) {
	return (
		<div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center px-2">
			<p role="status" aria-live="polite" className="sr-only">
				{bannerAnnouncement(banner)}
			</p>
			{banner ? (
				<div
					className={cn(
						"pointer-events-auto flex max-w-full items-center gap-2.5 rounded-md border py-1 pr-1 pl-3 text-sm shadow-lg",
						banner.kind === "failed" && "pr-3",
						TONES[banner.kind],
					)}
				>
					<span className="truncate" aria-hidden="true">
						{banner.text}
					</span>
					{banner.kind === "analyzing" || banner.kind === "solving" ? (
						<>
							<div
								role="progressbar"
								aria-label="Track Camera progress"
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={banner.percent}
								className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-white/15"
							>
								<div className="h-full bg-current" style={{ width: `${banner.percent}%` }} />
							</div>
							<span className="shrink-0 tabular-nums" aria-hidden="true">
								{banner.percent}%
							</span>
							<Button
								variant="outline"
								size="sm"
								className="text-foreground"
								aria-label="Cancel Track Camera"
								onClick={onCancel}
							>
								Cancel
							</Button>
						</>
					) : null}
					{banner.kind === "stale" ? (
						<Button variant="outline" size="sm" className="text-foreground" onClick={onAction}>
							{banner.actionLabel}
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
