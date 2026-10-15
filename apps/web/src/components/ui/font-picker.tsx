"use client";

import { useState, useMemo, useRef, useEffect, useCallback, type CSSProperties } from "react";
import { List, type RowComponentProps } from "react-window";
import { toast } from "sonner";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getMissingFontFamilies, removeCustomFont } from "@/fonts/custom-fonts";
import { useCustomFontsStore } from "@/fonts/custom-fonts-store";
import { formatFontNameList, quoteFontFamily } from "@/fonts/font-family";
import { loadFullFont } from "@/fonts/google-fonts";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import {
	filterTurkishOnly,
	hasTurkishBadge,
	type TurkishSupport,
} from "@/fonts/turkish-support";
import type { FontAtlas, FontAtlasEntry } from "@/fonts/types";
import { useFontAtlas } from "@/fonts/use-font-atlas";
import { useFontImport } from "@/fonts/use-font-import";
import { useLocalStorage } from "@/services/storage/use-local-storage";
import { cn } from "@/utils/ui";
import { ChevronDown, Search, Trash2, TriangleAlert, Upload } from "lucide-react";
import { HugeiconsIcon } from "@hugeicons/react";
import { TextIcon } from "@hugeicons/core-free-icons";

const FONT_TABS = [
	{ key: "all", label: "All fonts" },
	{ key: "my-fonts", label: "My fonts" },
] as const;

type FontTab = (typeof FONT_TABS)[number]["key"];

const ROW_HEIGHT = 40;
const PREVIEW_SCALE = 0.8;
const LIST_WIDTH = 288;
const MAX_LIST_HEIGHT = 288;
const OVERSCAN = 15;

interface FontPickerProps {
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	className?: string;
}

export function FontPicker({
	defaultValue,
	onValueChange,
	className,
}: FontPickerProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [activeTab, setActiveTab] = useState<FontTab>("all");
	const [familyToDelete, setFamilyToDelete] = useState<string | null>(null);
	// Kept across opens and reloads; anything but a stored `true` means off.
	const [storedTurkishOnly, setStoredTurkishOnly] = useLocalStorage<boolean>({
		key: "font-picker-turkish-only",
		defaultValue: false,
	});
	const turkishOnly = storedTurkishOnly === true;
	const searchInputRef = useRef<HTMLInputElement>(null);
	const {
		atlas,
		status,
		fontNames,
		customFamilies,
		failedFamilies,
		turkishSupport,
		retry: handleRetry,
	} = useFontAtlas({ open });
	const customFonts = useCustomFontsStore((state) => state.fonts);
	const { isDragOver, isImporting, openFilePicker, fileInputProps, dragProps } =
		useFontImport();

	const isMyFontsTab = activeTab === "my-fonts";
	const customFamilySet = useMemo(
		() => new Set(customFamilies),
		[customFamilies],
	);

	// The toggle (and the filter) only exist once the list is loaded.
	const canFilterTurkish = !isMyFontsTab && turkishSupport !== null;
	const showsTurkishOnly = canFilterTurkish && turkishOnly;
	const filteredFonts = useMemo(() => {
		let names = isMyFontsTab ? customFamilies : fontNames;
		if (turkishOnly && !isMyFontsTab) {
			names = filterTurkishOnly({
				names,
				support: turkishSupport,
				customFamilies: customFamilySet,
				selected: defaultValue,
			});
		}
		if (!search) return names;
		const query = search.toLowerCase();
		return names.filter((name) => name.toLowerCase().includes(query));
	}, [
		isMyFontsTab,
		customFamilies,
		fontNames,
		search,
		turkishOnly,
		turkishSupport,
		customFamilySet,
		defaultValue,
	]);

	const isMissing = useMemo(
		() =>
			defaultValue !== undefined &&
			getMissingFontFamilies({
				families: [defaultValue],
				atlas,
				customFamilies: customFamilies.filter(
					(family) => !failedFamilies.has(family),
				),
			}).missing.length > 0,
		[defaultValue, atlas, customFamilies, failedFamilies],
	);

	const listHeight = Math.min(
		MAX_LIST_HEIGHT,
		filteredFonts.length * ROW_HEIGHT,
	);

	const handleSelect = useCallback(
		async ({ family }: { family: string }) => {
			if (!SYSTEM_FONTS.has(family) && !customFamilySet.has(family)) {
				const isLoaded = await loadFullFont({ family }).catch(() => false);
				if (!isLoaded) {
					toast.warning(
						`Could not load ${formatFontNameList({ names: [family] })}. A default font is used.`,
						{ id: "font-load-failed" },
					);
				}
			}
			onValueChange?.(family);
			setOpen(false);
		},
		[onValueChange, customFamilySet],
	);

	const handleDeleteRequest = useCallback(
		({ family }: { family: string }) => setFamilyToDelete(family),
		[],
	);

	const handleDeleteConfirm = async () => {
		const family = familyToDelete;
		setFamilyToDelete(null);
		if (!family) return;

		const ids = customFonts
			.filter((font) => font.family === family)
			.map((font) => font.id);
		const results = await Promise.allSettled(
			ids.map((id) => removeCustomFont({ id })),
		);
		const failed = results.filter((result) => result.status === "rejected");
		if (failed.length > 0) {
			console.error(`Failed to delete custom font "${family}":`, failed);
			toast.error(
				`Could not delete ${failed.length} of ${ids.length} styles of ${formatFontNameList({ names: [family] })}`,
			);
		}
	};

	useEffect(() => {
		if (!open) {
			setSearch("");
			setActiveTab("all");
		}
	}, [open]);

	const activeTabLabel =
		FONT_TABS.find((t) => t.key === activeTab)?.label.toLowerCase() ?? "";
	const showList = isMyFontsTab || status !== "loading";
	const styleCountToDelete = customFonts.filter(
		(font) => font.family === familyToDelete,
	).length;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				className={cn(
					"border-border bg-accent flex h-7 w-full cursor-pointer items-center justify-between gap-1 rounded-md border px-2.5 text-sm whitespace-nowrap focus-visible:border-primary focus-visible:ring-0 focus:outline-hidden",
					className,
				)}
				aria-label={
					isMissing
						? `${defaultValue}, font not found, a default font is shown`
						: undefined
				}
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<span
						className={cn(
							"[&_svg]:size-3.5 shrink-0",
							isMissing ? "text-caution" : "text-muted-foreground",
						)}
						title={
							isMissing
								? "Font not found. A default font is shown instead."
								: undefined
						}
					>
						{isMissing ? <TriangleAlert /> : <HugeiconsIcon icon={TextIcon} />}
					</span>
					<span
						className="truncate"
						style={{
							fontFamily: defaultValue
								? `${quoteFontFamily({ fontFamily: defaultValue })}, sans-serif`
								: undefined,
						}}
					>
						{defaultValue ?? "Select a font"}
					</span>
				</div>
				<ChevronDown className="size-3 shrink-0 opacity-50" />
			</PopoverTrigger>
			<PopoverContent
				className="relative w-72 p-0 overflow-hidden"
				align="start"
				side="left"
				{...dragProps}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					searchInputRef.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
				onInteractOutside={(event) => {
					// The delete confirmation is a separate overlay; keep the list open.
					if (familyToDelete !== null) event.preventDefault();
				}}
			>
				<input {...fileInputProps} />
				{isDragOver && (
					<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-primary bg-popover/90 text-sm">
						Drop font files to import
					</div>
				)}
				<div className="relative px-3 py-1.5">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 shrink-0 opacity-50" />
					<Input
						ref={searchInputRef}
						placeholder={`Search ${activeTabLabel}...`}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						size="xs"
						className="w-full pl-5 bg-transparent border-none! shadow-none!"
					/>
				</div>
				<div className="flex items-center border-b pr-3">
					<div className="flex px-3" role="tablist">
						{FONT_TABS.map((tab) => (
							<button
								key={tab.key}
								type="button"
								role="tab"
								aria-selected={activeTab === tab.key}
								className={cn(
									"px-3 py-1.5 text-xs border-b-2 -mb-px",
									activeTab === tab.key
										? "border-foreground text-foreground"
										: "border-transparent text-muted-foreground hover:text-foreground",
								)}
								onClick={() => setActiveTab(tab.key)}
							>
								{tab.label}
							</button>
						))}
					</div>
					{canFilterTurkish && (
						<button
							type="button"
							aria-pressed={turkishOnly}
							title="Only fonts that have all Turkish letters (ç ğ ı İ ö ş ü)"
							className={cn(
								"ml-auto rounded-sm border px-1.5 py-0.5 text-xs",
								turkishOnly
									? "border-foreground text-foreground"
									: "border-border text-muted-foreground hover:text-foreground",
							)}
							onClick={() => setStoredTurkishOnly({ value: !turkishOnly })}
						>
							Turkish only
						</button>
					)}
				</div>
				{isMyFontsTab && (
					<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
						<p className="text-xs text-muted-foreground">
							TTF, OTF, WOFF or WOFF2. Drop files here.
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={openFilePicker}
							disabled={isImporting}
						>
							<Upload />
							Import
						</Button>
					</div>
				)}
				{!isMyFontsTab && status === "loading" && (
					<div className="py-8 text-center text-sm text-muted-foreground">
						Loading fonts...
					</div>
				)}
				{!isMyFontsTab && status === "error" && (
					<div
						className="flex items-center justify-between gap-2 border-b px-3 py-2"
						role="status"
					>
						<p className="text-xs text-caution">
							Google fonts unavailable. Showing system and custom fonts.
						</p>
						<Button variant="outline" size="sm" onClick={handleRetry}>
							Retry
						</Button>
					</div>
				)}
				{showList && filteredFonts.length === 0 && (
					<div className="py-6 text-center text-sm text-muted-foreground">
						{isMyFontsTab && customFamilies.length === 0
							? "No custom fonts yet."
							: showsTurkishOnly
								? "No Turkish-ready font matches"
								: "No fonts found."}
					</div>
				)}
				{showList && filteredFonts.length > 0 && (
					<List
						rowCount={filteredFonts.length}
						rowHeight={ROW_HEIGHT}
						overscanCount={OVERSCAN}
						rowComponent={FontRow}
						rowProps={{
							atlas,
							filteredFonts,
							customFamilySet,
							failedFamilySet: failedFamilies,
							turkishSupport,
							selectedFont: defaultValue,
							onFontSelect: handleSelect,
							onFontDelete: handleDeleteRequest,
						}}
						style={{ height: listHeight, width: LIST_WIDTH }}
					/>
				)}
			</PopoverContent>
			<Dialog
				open={familyToDelete !== null}
				onOpenChange={(isOpen) => {
					if (!isOpen) setFamilyToDelete(null);
				}}
			>
				<DialogContent
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						searchInputRef.current?.focus();
					}}
				>
					<DialogHeader>
						<DialogTitle>Delete font</DialogTitle>
						<DialogDescription>
							{`Delete "${familyToDelete}" (${styleCountToDelete} ${styleCountToDelete === 1 ? "style" : "styles"})? Projects using it fall back to a default font until you import it again.`}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setFamilyToDelete(null)}>
							Cancel
						</Button>
						<Button variant="destructive" onClick={handleDeleteConfirm}>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Popover>
	);
}

function FontSpritePreview({ entry }: { entry: FontAtlasEntry }) {
	return (
		<div
			className="shrink-0"
			style={{
				width: entry.w,
				height: ROW_HEIGHT,
				backgroundColor: "currentColor",
				WebkitMaskImage: `url(/fonts/font-chunk-${entry.ch}.avif)`,
				WebkitMaskPosition: `-${entry.x}px -${entry.y}px`,
				WebkitMaskRepeat: "no-repeat",
				maskImage: `url(/fonts/font-chunk-${entry.ch}.avif)`,
				maskPosition: `-${entry.x}px -${entry.y}px`,
				maskRepeat: "no-repeat",
				transform: `scale(${PREVIEW_SCALE})`,
				transformOrigin: "left center",
			}}
		/>
	);
}

type FontRowProps = {
	atlas: FontAtlas | null;
	filteredFonts: string[];
	customFamilySet: Set<string>;
	failedFamilySet: Set<string>;
	turkishSupport: TurkishSupport | null;
	selectedFont: string | undefined;
	onFontSelect: (params: { family: string }) => void;
	onFontDelete: (params: { family: string }) => void;
};

function FontRow({
	index,
	style,
	atlas,
	filteredFonts,
	customFamilySet,
	failedFamilySet,
	turkishSupport,
	selectedFont,
	onFontSelect,
	onFontDelete,
}: RowComponentProps<FontRowProps>) {
	const fontName = filteredFonts[index];
	const entry = atlas?.fonts[fontName];
	const isSelected = fontName === selectedFont;
	const isCustomFont = customFamilySet.has(fontName);
	const isFailedFont = failedFamilySet.has(fontName);
	const isTurkish = hasTurkishBadge({
		family: fontName,
		support: turkishSupport,
		isCustom: isCustomFont,
	});
	// Only Google fonts have a pre-rendered sprite; system and custom fonts
	// are already available to the browser and are drawn live.
	const spriteEntry = isCustomFont || SYSTEM_FONTS.has(fontName) ? undefined : entry;

	return (
		<div
			style={style as CSSProperties}
			className={cn(
				"flex w-full items-center hover:bg-popover-hover",
				isSelected && "bg-popover-hover",
			)}
		>
			<button
				type="button"
				className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 outline-hidden"
				onClick={() => onFontSelect({ family: fontName })}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onFontSelect({ family: fontName });
					}
				}}
				disabled={isFailedFont}
				title={
					isFailedFont
						? "This font failed to load. Delete it and import it again."
						: undefined
				}
				aria-label={[
					fontName,
					isFailedFont && "failed to load",
					isTurkish && "has all Turkish letters",
				]
					.filter(Boolean)
					.join(", ")}
			>
				{isFailedFont && (
					<TriangleAlert className="size-4 shrink-0 text-caution" />
				)}
				<div className="min-w-0 overflow-hidden">
					{spriteEntry ? (
						<FontSpritePreview entry={spriteEntry} />
					) : (
						<span
							className="block truncate text-xl text-foreground/85"
							style={{ fontFamily: quoteFontFamily({ fontFamily: fontName }) }}
						>
							{fontName}
						</span>
					)}
				</div>
				{isTurkish && (
					<span
						className="ml-auto shrink-0 rounded-sm border border-border px-1 text-[10px] leading-4 text-muted-foreground"
						title="Has all Turkish letters (ç ğ ı İ ö ş ü)"
					>
						TR
					</span>
				)}
			</button>
			{isCustomFont && (
				<Button
					variant="ghost"
					size="icon"
					className="mr-2 text-muted-foreground hover:text-destructive"
					aria-label={`Delete ${fontName}`}
					onClick={() => onFontDelete({ family: fontName })}
				>
					<Trash2 />
				</Button>
			)}
		</div>
	);
}
