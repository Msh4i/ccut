import { ImageOff } from "lucide-react";
import Image from "next/image";
import { safeResolveStickerId } from "@/stickers/resolver";

/**
 * A sticker element on the timeline: its image and name. When the sticker id
 * cannot be resolved the image is replaced by a placeholder; the element keeps
 * its name, so it can still be found, selected and deleted. The props are
 * `unknown` because they come from a saved project: a damaged one may hold
 * anything, and a render must never throw.
 */
export function StickerElementContent({
	element,
}: {
	element: { name: unknown; stickerId: unknown };
}) {
	const name = typeof element.name === "string" ? element.name : "";
	const src = safeResolveStickerId({
		stickerId: element.stickerId,
		options: { width: 20, height: 20 },
	});

	return (
		<div className="flex size-full items-center gap-2 pl-2">
			{src ? (
				<Image
					src={src}
					// Decorative: the name beside it already says what it is.
					alt=""
					className="size-4 shrink-0"
					width={20}
					height={20}
					unoptimized
				/>
			) : (
				<ImageOff
					role="img"
					aria-label="Missing sticker"
					className="size-4 shrink-0 text-white/70"
				/>
			)}
			<span className="truncate text-xs text-white">{name}</span>
		</div>
	);
}
