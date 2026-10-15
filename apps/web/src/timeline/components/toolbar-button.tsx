import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/utils/ui";

export function ToolbarButton({
	icon,
	tooltip,
	label,
	onClick,
	onContextMenu,
	disabled,
	busy,
	isActive,
	buttonWrapper,
}: {
	icon: React.ReactNode;
	tooltip: string;
	/** Fixed accessible name for a toggle whose tooltip changes with its state. */
	label?: string;
	onClick?: ({ event }: { event: React.MouseEvent }) => void;
	onContextMenu?: (event: React.MouseEvent) => void;
	disabled?: boolean;
	/** Working: stays focusable (unlike `disabled`) but is announced as disabled. */
	busy?: boolean;
	isActive?: boolean;
	buttonWrapper?: (button: React.ReactElement) => React.ReactElement;
}) {
	const button = (
		<Button
			variant={isActive ? "secondary" : "text"}
			size="icon"
			disabled={disabled}
			aria-label={label ?? tooltip}
			aria-pressed={isActive}
			aria-disabled={busy || undefined}
			onClick={onClick ? (event) => onClick({ event }) : undefined}
			onContextMenu={onContextMenu}
			className={cn(
				"rounded-sm",
				disabled ? "cursor-not-allowed opacity-50" : "",
				busy ? "cursor-progress opacity-50" : "",
			)}
		>
			{icon}
		</Button>
	);
	const trigger = disabled ? (
		<span className="inline-flex">{button}</span>
	) : buttonWrapper ? (
		buttonWrapper(button)
	) : (
		button
	);

	return (
		<Tooltip delayDuration={200}>
			<TooltipTrigger asChild>{trigger}</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
