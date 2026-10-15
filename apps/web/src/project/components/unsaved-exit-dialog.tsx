import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/**
 * Shown when "Exit project" could not store the latest changes. Escape, a
 * click outside and the close button all mean "keep editing".
 */
export function UnsavedExitDialog({
	isOpen,
	onLeave,
	onStay,
}: {
	isOpen: boolean;
	onLeave: () => void;
	onStay: () => void;
}) {
	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) onStay();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Your latest changes are not saved</DialogTitle>
					<DialogDescription>
						The project could not be saved, so leaving now would lose your
						latest changes. Free some browser storage and try again, or leave
						anyway.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={onStay}>
						Keep editing
					</Button>
					<Button variant="destructive" onClick={onLeave}>
						Leave anyway
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
