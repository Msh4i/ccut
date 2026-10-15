import { STEM_LABELS, STEM_NAMES, type StemName } from "@/services/stems/types";

/**
 * What the one "Auto hits" button listens to and marks. The choice is sticky (kept between
 * runs and restarts): left click runs it, the menu only changes it.
 */
export type MarkerMode = "hits" | "beats";

export const MARKER_MODES: ReadonlyArray<{ mode: MarkerMode; label: string; hint: string }> = [
	{ mode: "hits", label: "Every hit", hint: "any rhythm" },
	{ mode: "beats", label: "Beat grid", hint: "one steady tempo" },
];

export type StemChoice = { stem: StemName; mode: MarkerMode };

export const DEFAULT_STEM_CHOICE: StemChoice = { stem: "drums", mode: "hits" };

export function parseStem(value: unknown): StemName {
	return STEM_NAMES.find((name) => name === value) ?? DEFAULT_STEM_CHOICE.stem;
}

export function parseMarkerMode(value: unknown): MarkerMode {
	return value === "beats" || value === "hits" ? value : DEFAULT_STEM_CHOICE.mode;
}

/**
 * zustand persist `merge`: every stored field is read through its parser, so a value from a
 * newer or hand-edited app never reaches the detector, and one bad field keeps the other.
 */
export function mergePersistedChoice<TState extends StemChoice>({
	persisted,
	current,
}: {
	persisted: unknown;
	current: TState;
}): TState {
	const read = (key: string): unknown =>
		typeof persisted === "object" && persisted !== null ? Reflect.get(persisted, key) : undefined;
	return { ...current, stem: parseStem(read("stem")), mode: parseMarkerMode(read("mode")) };
}

/** The button's name and tooltip stem: "Auto hits: Drums", "Auto beat grid: Vocals". */
export function stemChoiceLabel({ choice }: { choice: StemChoice }): string {
	const what = choice.mode === "hits" ? "Auto hits" : "Auto beat grid";
	return `${what}: ${STEM_LABELS[choice.stem]}`;
}
