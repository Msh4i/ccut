import {
	type CustomFontEntry,
	useCustomFontsStore,
} from "@/fonts/custom-fonts-store";
import {
	MAX_FONT_FILE_BYTES,
	NOT_A_FONT_REASON,
	detectFontFormat,
	parseFontFile,
} from "@/fonts/font-file";
import { formatFontNameList } from "@/fonts/font-family";
import { loadFontAtlas, loadFonts } from "@/fonts/google-fonts";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import type {
	CustomFontFormat,
	CustomFontMeta,
	CustomFontRecord,
	CustomFontStyle,
	FontAtlas,
} from "@/fonts/types";
import { raceWithTimeout } from "@/fonts/with-timeout";
import { customFontsStorage } from "@/services/storage/custom-fonts-storage";
import {
	evaluateStorageCapacity,
	isStorageQuotaExceededError,
	readStorageQuotaStatus,
} from "@/services/storage/quota";
import { generateUUID } from "@/utils/id";

export const MAX_CUSTOM_FONTS = 200;
export const MAX_FONTS_PER_BATCH = 50;
export const MAX_TOTAL_FONT_BYTES = 256 * 1024 * 1024;
const REGISTRATION_TIMEOUT_MS = 5000;
const MAGIC_SNIFF_BYTES = 12;

export type FontImportResult =
	| { ok: true; fileName: string; font: CustomFontMeta }
	| { ok: false; fileName: string; reason: string };

export interface ProjectFontsReport {
	/** Used but installed nowhere. */
	missing: string[];
	/** Used, but the Google catalog is unavailable so they cannot be classified. */
	unverified: string[];
	/** Google fonts that could not be loaded. */
	failed: string[];
	/** The font library could not be read from IndexedDB. */
	customFontsUnreadable: boolean;
	/** The font library is still being read, so custom fonts cannot be judged. */
	customFontsLoading: boolean;
	/** Stored custom fonts the browser rejected at startup. */
	brokenCustomFonts: string[];
}

const faces = new Map<string, FontFace>();
let registration: Promise<void> | null = null;

export function buildFontKey({
	family,
	weight,
	style,
}: {
	family: string;
	weight: number;
	style: CustomFontStyle;
}): string {
	return `${family.toLowerCase()}|${weight}|${style}`;
}

function lowerCaseSet({ names }: { names: Iterable<string> }): Set<string> {
	return new Set([...names].map((name) => name.toLowerCase()));
}

/**
 * A custom family that shares a name with a system or Google font would
 * shadow it (CSS family names are case-insensitive), so it is stored under a
 * deterministic suffixed name. All variants of one family get the same name.
 */
export function resolveFamilyCollision({
	family,
	atlas,
}: {
	family: string;
	atlas: FontAtlas;
}): string {
	const taken = lowerCaseSet({
		names: [...SYSTEM_FONTS, ...Object.keys(atlas.fonts)],
	});
	return taken.has(family.toLowerCase()) ? `${family} (Custom)` : family;
}

/**
 * Splits the families a project uses that are not system or custom fonts.
 * With the Google catalog they are `missing`; without it nothing can be told
 * apart from a Google font, so they are `unverified`.
 */
export function getMissingFontFamilies({
	families,
	atlas,
	customFamilies,
}: {
	families: string[];
	atlas: FontAtlas | null;
	customFamilies: string[];
}): { missing: string[]; unverified: string[] } {
	const known = lowerCaseSet({ names: [...SYSTEM_FONTS, ...customFamilies] });
	const unknown = families.filter((family) => !known.has(family.toLowerCase()));
	if (!atlas) return { missing: [], unverified: unknown };

	const google = lowerCaseSet({ names: Object.keys(atlas.fonts) });
	return {
		missing: unknown.filter((family) => !google.has(family.toLowerCase())),
		unverified: [],
	};
}

/**
 * Registers custom fonts, then classifies the families a project uses BEFORE
 * any network request, so a name that is not a catalog font (deleted or from
 * another machine) is only reported and never sent to Google. Never throws.
 */
export async function prepareProjectFonts({
	families,
}: {
	families: unknown[];
}): Promise<ProjectFontsReport> {
	const names = [...new Set(families)].filter(
		(family): family is string => typeof family === "string" && family !== "",
	);

	const isReady = await ensureCustomFontsRegistered();
	const { fonts, loadError } = useCustomFontsStore.getState();
	const atlas = await loadFontAtlas();

	// Without the stored library every custom name would look missing.
	const { missing, unverified } =
		loadError || !isReady
			? { missing: [], unverified: [] }
			: getMissingFontFamilies({
					families: names,
					atlas,
					customFamilies: fonts.filter((f) => !f.failed).map((f) => f.family),
				});

	const { failed } = await loadFonts({
		families: names.filter((family) => !missing.includes(family)),
	});

	return {
		missing,
		unverified,
		failed,
		customFontsUnreadable: loadError,
		customFontsLoading: !isReady,
		brokenCustomFonts: [
			...new Set(fonts.filter((f) => f.failed).map((f) => f.family)),
		],
	};
}

const FONT_FORMATS: readonly CustomFontFormat[] = [
	"ttf",
	"otf",
	"woff",
	"woff2",
];
const MAX_FILE_NAME_LENGTH = 255;

/**
 * Stored records are untrusted: nothing is copied over as is. The size comes
 * from the bytes themselves, so a bad `size` cannot defeat the library cap.
 */
function toMeta({ record }: { record: CustomFontRecord }): CustomFontMeta {
	return {
		id: record.id,
		family: record.family,
		weight: record.weight,
		style: record.style,
		format: FONT_FORMATS.find((format) => format === record.format) ?? "ttf",
		fileName:
			typeof record.fileName === "string"
				? record.fileName.slice(0, MAX_FILE_NAME_LENGTH)
				: "",
		size: record.data.byteLength,
		addedAt: record.addedAt,
	};
}

function createFace({
	family,
	weight,
	style,
	data,
}: Pick<CustomFontRecord, "family" | "weight" | "style" | "data">): FontFace {
	return new FontFace(family, data, { weight: String(weight), style });
}

function isStoredRecord(value: unknown): value is CustomFontRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"family" in value &&
		typeof value.family === "string" &&
		value.family !== "" &&
		"weight" in value &&
		typeof value.weight === "number" &&
		Number.isFinite(value.weight) &&
		"style" in value &&
		(value.style === "normal" || value.style === "italic") &&
		"addedAt" in value &&
		typeof value.addedAt === "number" &&
		"data" in value &&
		value.data instanceof ArrayBuffer
	);
}

async function registerStoredFonts(): Promise<void> {
	let stored: unknown[];
	try {
		stored = await customFontsStorage.list();
	} catch (error) {
		console.error("Failed to read custom fonts:", error);
		useCustomFontsStore.setState({ loadError: true });
		registration = null;
		return;
	}

	const records = stored
		.filter(isStoredRecord)
		.sort((a, b) => a.addedAt - b.addedAt);
	if (records.length < stored.length) {
		// Only logged, not shown to the user (known gap).
		console.warn(
			`Skipped ${stored.length - records.length} invalid custom font record(s).`,
		);
	}

	const results = await Promise.allSettled(
		records.map(async (record) => {
			const face = createFace(record);
			await face.load();
			document.fonts.add(face);
			faces.set(record.id, face);
		}),
	);

	// A rejected font stays in the list, flagged, so it can be seen and deleted.
	const fonts = records.map((record, i): CustomFontEntry => {
		const result = results[i];
		if (result.status === "fulfilled") return toMeta({ record });
		console.warn(
			`Custom font "${record.family}" failed to load:`,
			result.reason,
		);
		return { ...toMeta({ record }), failed: true };
	});
	useCustomFontsStore.setState((state) => {
		// Merge by id: a registration that finishes after its timeout must not
		// wipe what the store gained meanwhile.
		const known = new Set(fonts.map((font) => font.id));
		return {
			fonts: [...fonts, ...state.fonts.filter((font) => !known.has(font.id))],
			version: state.version + 1,
			loadError: false,
		};
	});
}

/**
 * Registers every stored font with the browser once. Never throws. Resolves
 * true when registration has finished (check `loadError` for a failed read)
 * and false when it is still running after a few seconds: it then carries on
 * in the background, so callers must not treat the store as complete.
 */
export async function ensureCustomFontsRegistered(): Promise<boolean> {
	registration ??= registerStoredFonts();
	try {
		const result = await raceWithTimeout({
			promise: registration,
			ms: REGISTRATION_TIMEOUT_MS,
		});
		return !result.timedOut;
	} catch (error) {
		console.error("Custom font registration failed:", error);
		useCustomFontsStore.setState({ loadError: true });
		registration = null;
		return true;
	}
}

async function importFontFile({
	file,
	fonts,
	atlas,
}: {
	file: File;
	fonts: CustomFontEntry[];
	atlas: FontAtlas;
}): Promise<FontImportResult> {
	const fail = (reason: string): FontImportResult => ({
		ok: false,
		fileName: file.name,
		reason,
	});

	if (fonts.length >= MAX_CUSTOM_FONTS) {
		return fail(`Font limit reached (${MAX_CUSTOM_FONTS}). Delete one first.`);
	}
	if (file.size === 0) return fail("The file is empty.");
	if (file.size > MAX_FONT_FILE_BYTES) {
		return fail(`Larger than ${MAX_FONT_FILE_BYTES / 1024 / 1024} MB.`);
	}
	const storedBytes = fonts.reduce((sum, font) => sum + font.size, 0);
	if (storedBytes + file.size > MAX_TOTAL_FONT_BYTES) {
		return fail(
			`Font library is full (${MAX_TOTAL_FONT_BYTES / 1024 / 1024} MB). Delete fonts first.`,
		);
	}

	const capacity = evaluateStorageCapacity({
		requiredBytes: file.size,
		quotaStatus: await readStorageQuotaStatus(),
	});
	if (!capacity.canStore) return fail("Not enough browser storage.");

	// Check the magic bytes before reading the whole file into memory.
	const head = await file.slice(0, MAGIC_SNIFF_BYTES).arrayBuffer();
	if (!detectFontFormat({ buffer: head })) return fail(NOT_A_FONT_REASON);

	const buffer = await file.arrayBuffer();
	const parsed = parseFontFile({ fileName: file.name, buffer });
	if (!parsed.ok) return fail(parsed.reason);

	const { weight, style, format } = parsed;
	const family = resolveFamilyCollision({ family: parsed.family, atlas });
	const key = buildFontKey({ family, weight, style });
	if (fonts.some((font) => buildFontKey(font) === key)) {
		return fail(
			`"${family}" ${weight} ${style} is already imported. Delete it first to replace it.`,
		);
	}

	// The browser's font sanitizer is the real gate: nothing is stored or
	// registered unless it accepts the file.
	let face: FontFace;
	try {
		face = createFace({ family, weight, style, data: buffer });
		await face.load();
	} catch {
		return fail("The browser could not load this font. It may be corrupted.");
	}

	const record: CustomFontRecord = {
		schema: 1,
		id: generateUUID(),
		family,
		weight,
		style,
		format,
		fileName: file.name,
		size: buffer.byteLength,
		addedAt: Date.now(),
		data: buffer,
	};
	try {
		await customFontsStorage.save({ record });
	} catch (error) {
		return fail(
			isStorageQuotaExceededError({ error })
				? "Not enough browser storage."
				: "Could not save the font to browser storage.",
		);
	}

	document.fonts.add(face);
	faces.set(record.id, face);
	return { ok: true, fileName: file.name, font: toMeta({ record }) };
}

/**
 * Imports files one at a time; every file gets its own result and the store is
 * updated once for the whole batch. Refuses to run without the Google catalog,
 * since a name that collides with a Google font could not be told apart.
 */
export async function importFontFiles({
	files,
}: {
	files: File[];
}): Promise<FontImportResult[]> {
	const rejectAll = (reason: string): FontImportResult[] =>
		files.map((file) => ({ ok: false, fileName: file.name, reason }));

	if (useCustomFontsStore.getState().isImporting) {
		return rejectAll("Another font import is still running.");
	}

	useCustomFontsStore.setState({ isImporting: true });
	const added: CustomFontMeta[] = [];
	try {
		// Without the whole library the count, size and duplicate checks are void.
		if (!(await ensureCustomFontsRegistered())) {
			return rejectAll("Fonts are still loading, try again.");
		}
		if (useCustomFontsStore.getState().loadError) {
			return rejectAll("Custom fonts could not be read from browser storage.");
		}
		const atlas = await loadFontAtlas();
		if (!atlas) return rejectAll("Font catalog unavailable, try again.");

		const results: FontImportResult[] = [];
		for (const [index, file] of files.entries()) {
			if (index >= MAX_FONTS_PER_BATCH) {
				results.push({
					ok: false,
					fileName: file.name,
					reason: `Only ${MAX_FONTS_PER_BATCH} files can be imported at once.`,
				});
				continue;
			}

			try {
				const result = await importFontFile({
					file,
					atlas,
					fonts: [...useCustomFontsStore.getState().fonts, ...added],
				});
				if (result.ok) added.push(result.font);
				results.push(result);
			} catch (error) {
				console.error(`Failed to import font "${file.name}":`, error);
				results.push({
					ok: false,
					fileName: file.name,
					reason: "The file could not be read.",
				});
			}
		}
		return results;
	} finally {
		useCustomFontsStore.setState((state) =>
			added.length === 0
				? { isImporting: false }
				: {
						isImporting: false,
						fonts: [...state.fonts, ...added],
						version: state.version + 1,
					},
		);
	}
}

/** One title and description for every rejected file of a batch, or null. */
export function summarizeImportFailures({
	results,
}: {
	results: FontImportResult[];
}): { title: string; description: string } | null {
	const failures = results.filter(
		(result): result is Extract<FontImportResult, { ok: false }> => !result.ok,
	);
	if (failures.length === 0) return null;

	const reasons = [...new Set(failures.map((failure) => failure.reason))];
	return {
		title: `Could not import ${failures.length} ${failures.length === 1 ? "file" : "files"}`,
		description: `${formatFontNameList({ names: failures.map((failure) => failure.fileName) })}. ${reasons.slice(0, 3).join(" ")}`,
	};
}

export async function removeCustomFont({ id }: { id: string }): Promise<void> {
	await customFontsStorage.remove({ id });

	const face = faces.get(id);
	if (face) document.fonts.delete(face);
	faces.delete(id);
	useCustomFontsStore.setState((state) => ({
		fonts: state.fonts.filter((font) => font.id !== id),
		version: state.version + 1,
	}));
}
