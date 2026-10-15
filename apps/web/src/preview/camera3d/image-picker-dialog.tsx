"use client";

import Image from "next/image";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export interface PickableImage {
	id: string;
	name: string;
	url?: string;
	thumbnailUrl?: string;
}

/** "Create Image...": choose one of the project's images; a click creates the layer. */
export function ImagePickerDialog({
	open,
	images,
	onOpenChange,
	onPick,
}: {
	open: boolean;
	images: readonly PickableImage[];
	onOpenChange: (open: boolean) => void;
	onPick: (mediaId: string) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create Image</DialogTitle>
					<DialogDescription>
						Choose an image of this project. It is placed on the target as a 3D layer.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<ul className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto" aria-label="Project images">
						{images.map((image) => {
							const src = image.thumbnailUrl ?? image.url;
							return (
								<li key={image.id}>
									<button
										type="button"
										className="hover:border-primary focus-visible:ring-ring flex w-full cursor-pointer flex-col overflow-hidden rounded-sm border text-left focus-visible:ring-2 focus-visible:outline-hidden"
										onClick={() => onPick(image.id)}
									>
										<span className="bg-accent relative block h-16 w-full">
											{src ? (
												<Image src={src} alt="" fill sizes="10rem" className="object-cover" unoptimized />
											) : null}
										</span>
										<span className="text-muted-foreground truncate px-1.5 py-1 text-xs">
											{image.name}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
