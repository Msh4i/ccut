import { useState, useMemo, useCallback, useEffect } from "react";
import {
	getCachedFontAtlas,
	loadFontAtlas,
	clearFontAtlasCache,
} from "@/fonts/google-fonts";
import {
	groupCustomFamilies,
	useCustomFontsStore,
} from "@/fonts/custom-fonts-store";
import type { FontAtlas } from "@/fonts/types";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import {
	getCachedTurkishSupport,
	loadTurkishSupport,
	type TurkishSupport,
} from "@/fonts/turkish-support";

type Status = "idle" | "loading" | "error";

export function useFontAtlas({ open }: { open: boolean }) {
	const [atlas, setAtlas] = useState<FontAtlas | null>(() =>
		getCachedFontAtlas(),
	);
	const [status, setStatus] = useState<Status>(() =>
		getCachedFontAtlas() ? "idle" : "loading",
	);

	useEffect(() => {
		if (!open || atlas) return;

		setStatus("loading");
		loadFontAtlas().then((data) => {
			if (data) {
				setAtlas(data);
				setStatus("idle");
			} else {
				setStatus("error");
			}
		});
	}, [open, atlas]);

	// Optional extra: when the list is unavailable the picker simply shows no badge.
	const [turkishSupport, setTurkishSupport] = useState<TurkishSupport | null>(
		() => getCachedTurkishSupport(),
	);
	useEffect(() => {
		if (!open || turkishSupport) return;
		loadTurkishSupport().then((support) => {
			if (support) setTurkishSupport(support);
		});
	}, [open, turkishSupport]);

	const retry = useCallback(() => {
		clearFontAtlasCache();
		setStatus("loading");
		loadFontAtlas().then((data) => {
			if (data) {
				setAtlas(data);
				setStatus("idle");
			} else {
				setStatus("error");
			}
		});
	}, []);

	const customFonts = useCustomFontsStore((state) => state.fonts);
	const { families: customFamilies, failed: failedFamilies } = useMemo(
		() => groupCustomFamilies({ fonts: customFonts }),
		[customFonts],
	);

	// Without the Google catalog the list still has the fonts that need none.
	const fontNames = useMemo(
		() =>
			[
				...new Set([
					...Object.keys(atlas?.fonts ?? {}),
					...SYSTEM_FONTS,
					...customFamilies,
				]),
			].sort(),
		[atlas, customFamilies],
	);

	return {
		atlas,
		status,
		fontNames,
		customFamilies,
		failedFamilies,
		turkishSupport,
		retry,
	};
}
