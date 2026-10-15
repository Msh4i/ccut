"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { getStemsBridge } from "@/services/stems/bridge";
import { getSeparatedStemsCache } from "@/timeline/beats/use-beat-detection";

const formatMegabytes = ({ bytes }: { bytes: number }) =>
	bytes < 1024 * 1024 ? "under 1 MB" : `${Math.round(bytes / (1024 * 1024))} MB`;

/** Upkeep for Auto hits (the separated stems on disk, the separator itself), out of its menu. */
export function AutoHitsSettings() {
	const [cachedBytes, setCachedBytes] = useState<number | null>(null);
	const [hasBridge] = useState(() => typeof window !== "undefined" && getStemsBridge() !== null);

	useEffect(() => {
		let current = true;
		void getSeparatedStemsCache()
			?.totalBytes()
			.then((bytes) => current && setCachedBytes(bytes))
			.catch(() => current && setCachedBytes(null));
		return () => {
			current = false;
		};
	}, []);

	const clearStems = useCallback(async () => {
		try {
			await getSeparatedStemsCache()?.clear();
			setCachedBytes(0);
			toast.success("Separated stems cleared");
		} catch (error) {
			console.error("Clearing the stem cache failed:", error);
			toast.error("Could not clear the separated stems");
		}
	}, []);

	const removeSeparator = useCallback(async () => {
		const bridge = getStemsBridge();
		if (!bridge) return;
		// The main process asks for the confirmation itself (a declined removal answers not ok).
		if (await bridge.removeEngine()) {
			toast.success("The stem separator was removed");
		} else {
			toast.error("The stem separator was not removed (cancelled, busy, or not installed)");
		}
	}, []);

	return (
		<Section>
			<SectionHeader>
				<SectionTitle>Auto hits</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col items-start gap-2">
				<Button variant="outline" size="sm" disabled={!cachedBytes} onClick={() => void clearStems()}>
					Clear separated stems
					{cachedBytes ? (
						<span className="text-muted-foreground ml-2 text-xs">
							{formatMegabytes({ bytes: cachedBytes })}
						</span>
					) : null}
				</Button>
				{hasBridge && (
					<Button variant="outline" size="sm" onClick={() => void removeSeparator()}>
						Remove the stem separator...
					</Button>
				)}
			</SectionContent>
		</Section>
	);
}
