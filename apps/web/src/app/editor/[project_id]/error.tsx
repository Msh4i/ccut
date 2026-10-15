"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/** What the console gets: the error itself, which the page does not show. */
export function reportEditorError({ error }: { error: Error }): void {
	console.error("The editor stopped because of an error:", error);
}

/** What focusing the heading needs (an HTMLElement has it). */
export function focusErrorHeading({
	heading,
}: {
	heading: { focus: (options: FocusOptions) => void } | null;
}): void {
	heading?.focus({ preventScroll: true });
}

/**
 * Shown when something in the editor throws while rendering. Without it the
 * whole editor tree is removed and the window goes blank.
 */
export default function EditorError({
	error,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const headingRef = useRef<HTMLHeadingElement>(null);

	useEffect(() => {
		reportEditorError({ error });
	}, [error]);

	// The page replaces the editor, so focus would otherwise be lost with it.
	useEffect(() => {
		focusErrorHeading({ heading: headingRef.current });
	}, []);

	return (
		<div
			role="alert"
			className="bg-background flex h-screen flex-col items-center justify-center gap-4 p-6 text-center"
		>
			<div className="flex flex-col gap-2">
				<h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
					Something went wrong
				</h1>
				<p className="text-muted-foreground max-w-sm text-sm text-balance">
					The editor stopped because of an unexpected problem. Reload to try
					again, or go back to your projects.
				</p>
			</div>
			<div className="flex items-center gap-2">
				{/* A reload, not reset(): the editor keeps state outside React. */}
				<Button onClick={() => window.location.reload()}>Reload</Button>
				<Button asChild variant="outline">
					<Link href="/projects">Back to projects</Link>
				</Button>
			</div>
		</div>
	);
}
