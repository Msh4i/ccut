"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
	ArrowDown01Icon,
	CloudUploadIcon,
	Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	type LinkImportBridge,
	getLinkImportBridge,
} from "@/media/link-import/bridge";
import { cn } from "@/utils/ui";

const subscribeNever = () => () => {};

/**
 * The desktop bridge for "Import from link", or null (web build, server render). Read on the
 * client only, so the server's markup (no bridge) and the first client render agree.
 */
export function useLinkImportBridge(): LinkImportBridge | null {
	const available = useSyncExternalStore(
		subscribeNever,
		() => getLinkImportBridge() !== null,
		() => false,
	);
	return useMemo(() => (available ? getLinkImportBridge() : null), [available]);
}

/**
 * The Media panel's Import button. Where "Import from link" is available (desktop) it is a
 * split button: the main part opens the file picker as before, the chevron offers "Import
 * file" and "Import from link". Elsewhere it is the plain button it always was.
 */
export function ImportMenuButton({
	disabled,
	onImportFile,
	onImportFromLink,
}: {
	disabled: boolean;
	onImportFile: () => void;
	onImportFromLink: (() => void) | null;
}) {
	const importButton = (
		<Button
			variant="outline"
			onClick={onImportFile}
			disabled={disabled}
			size="sm"
			className={cn(
				"items-center justify-center gap-1.5",
				onImportFromLink && "rounded-r-none",
			)}
		>
			<HugeiconsIcon icon={CloudUploadIcon} />
			Import
		</Button>
	);
	if (!onImportFromLink) return importButton;

	return (
		<div className="flex">
			{importButton}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						disabled={disabled}
						aria-label="More ways to import"
						className="rounded-l-none border-l-0 px-1.5"
					>
						<HugeiconsIcon icon={ArrowDown01Icon} />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={onImportFile}>
						<HugeiconsIcon icon={CloudUploadIcon} />
						Import file
					</DropdownMenuItem>
					<DropdownMenuItem onClick={onImportFromLink}>
						<HugeiconsIcon icon={Link01Icon} />
						Import from link
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
