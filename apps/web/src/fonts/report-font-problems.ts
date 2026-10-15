import { toast } from "sonner";
import { prepareProjectFonts } from "@/fonts/custom-fonts";
import { formatFontNameList } from "@/fonts/font-family";
import type { SceneTracks } from "@/timeline";
import { getElementFontFamilies } from "@/timeline/element-utils";

let brokenFontsAnnounced = false;

/**
 * Makes the fonts of a project ready (project open, export) and tells the user
 * what could not be: at most one toast per kind, with a fixed id so repeated
 * opens or exports replace it instead of stacking. Never throws, so fonts can
 * never stop a project from opening.
 */
export async function prepareAndReportFonts({
	scenes,
}: {
	scenes: { tracks: SceneTracks }[];
}): Promise<void> {
	try {
		const report = await prepareProjectFonts({
			families: scenes.flatMap((scene) =>
				getElementFontFamilies({ tracks: scene.tracks }),
			),
		});

		if (report.customFontsUnreadable) {
			toast.warning("Custom fonts could not be read from browser storage", {
				id: "fonts-unreadable",
			});
		}
		if (report.customFontsLoading) {
			toast.warning("Custom fonts are still loading", {
				id: "fonts-loading",
				description:
					"Text using them may show a default font until they finish.",
			});
		}
		if (report.brokenCustomFonts.length > 0 && !brokenFontsAnnounced) {
			brokenFontsAnnounced = true;
			toast.warning("Some custom fonts could not be loaded", {
				id: "fonts-broken",
				description: `${formatFontNameList({ names: report.brokenCustomFonts })}. Delete them in My fonts, then import them again.`,
			});
		}
		if (report.missing.length > 0) {
			toast.warning("Some fonts are missing", {
				id: "fonts-missing",
				description: `${formatFontNameList({ names: report.missing })}. Text using them is shown in a default font until you import them again.`,
			});
		}
		if (report.unverified.length > 0) {
			toast.warning(
				`Could not verify fonts: ${formatFontNameList({ names: report.unverified })}`,
				{ id: "fonts-unverified" },
			);
		}
		if (report.failed.length > 0) {
			toast.warning(
				`Could not load: ${formatFontNameList({ names: report.failed })}. A default font is used.`,
				{ id: "fonts-failed" },
			);
		}
	} catch (error) {
		console.warn("Fonts could not be prepared:", error);
		toast.warning("Some fonts could not be prepared", {
			id: "fonts-prepare-failed",
		});
	}
}
