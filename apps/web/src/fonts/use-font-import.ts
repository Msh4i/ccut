import { toast } from "sonner";
import { importFontFiles, summarizeImportFailures } from "@/fonts/custom-fonts";
import { useCustomFontsStore } from "@/fonts/custom-fonts-store";
import { formatFontNameList } from "@/fonts/font-family";
import { useFileUpload } from "@/media/use-file-upload";

/** File picker and drop handling for custom fonts, with one toast per batch. */
export function useFontImport() {
	const isImporting = useCustomFontsStore((state) => state.isImporting);

	const upload = useFileUpload({
		accept: ".ttf,.otf,.woff,.woff2",
		multiple: true,
		onFilesSelected: async (files) => {
			const results = await importFontFiles({ files });

			const failure = summarizeImportFailures({ results });
			if (failure) {
				toast.error(failure.title, { description: failure.description });
			}

			const added = results.flatMap((result) =>
				result.ok ? [result.font.family] : [],
			);
			if (added.length > 0) {
				toast.success(
					added.length === 1
						? `Added ${formatFontNameList({ names: added })}`
						: `Added ${added.length} fonts`,
				);
			}
		},
	});

	return { ...upload, isImporting };
}
