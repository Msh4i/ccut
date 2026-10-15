import { converter, parse } from "culori";
import { resolveAnimationPathValueAtTime } from "@/animation/resolve";
import type { ElementAnimations } from "@/animation/types";
import type { ParamValues } from "@/params";

/**
 * Colour key ("chroma key") of a clip: the pixels close to a picked colour
 * become transparent. The key works on the chroma (hue and saturation) of the
 * pixel, not on its brightness, so shadows on a green screen are keyed too.
 * Preview and export both turn the decoded frame into a keyed texture here.
 */
export const CHROMA_KEY_PARAM_KEYS = {
	enabled: "chromaKey.enabled",
	color: "chromaKey.color",
	tolerance: "chromaKey.tolerance",
	softness: "chromaKey.softness",
	spill: "chromaKey.spill",
	invert: "chromaKey.invert",
} as const;

export const CHROMA_KEY_DEFAULTS = {
	enabled: false,
	color: "#00ff00",
	tolerance: 30,
	softness: 20,
	spill: 50,
	invert: false,
} as const;

export interface ChromaKeySettings {
	/** The key colour, 0 to 255 per channel. */
	color: { r: number; g: number; b: number };
	/** 0 to 100: how far from the key colour a pixel is still fully keyed out. */
	tolerance: number;
	/** 0 to 100: the width of the soft edge between keyed out and kept. */
	softness: number;
	/** 0 to 100: how much of the key colour's cast is taken out of the kept pixels. */
	spill: number;
	/** Keeps the keyed colour and removes everything else. */
	invert: boolean;
}

const toRgb = converter("rgb");

/** A CSS colour as 0 to 255 channels, or null when it cannot be read. */
export function parseKeyColor({
	color,
}: {
	color: string;
}): { r: number; g: number; b: number } | null {
	const parsed = parse(color);
	const rgb = parsed ? toRgb(parsed) : null;
	if (!rgb) return null;
	const channel = (value: number | undefined) =>
		Math.round(Math.max(0, Math.min(1, value ?? 0)) * 255);
	return { r: channel(rgb.r), g: channel(rgb.g), b: channel(rgb.b) };
}

function clampPercent({ value, fallback }: { value: unknown; fallback: number }): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.min(100, value))
		: fallback;
}

/**
 * The key settings of a clip at `localTime`: its stored params with their
 * keyframes applied. Null when the key is off or its colour is unreadable.
 * Old clips have none of these params and read as off.
 */
export function resolveChromaKeyAtTime({
	params,
	animations,
	localTime,
}: {
	params: ParamValues | undefined;
	animations: ElementAnimations | undefined;
	localTime: number;
}): ChromaKeySettings | null {
	if (params?.[CHROMA_KEY_PARAM_KEYS.enabled] !== true) {
		return null;
	}

	const numberAt = ({ key, fallback }: { key: string; fallback: number }): number => {
		const stored = params[key];
		return clampPercent({
			value: resolveAnimationPathValueAtTime({
				animations,
				propertyPath: key,
				localTime: Math.max(0, localTime),
				fallbackValue: typeof stored === "number" ? stored : fallback,
			}),
			fallback,
		});
	};
	const storedColor = params[CHROMA_KEY_PARAM_KEYS.color];
	const color = parseKeyColor({
		color: resolveAnimationPathValueAtTime({
			animations,
			propertyPath: CHROMA_KEY_PARAM_KEYS.color,
			localTime: Math.max(0, localTime),
			fallbackValue:
				typeof storedColor === "string" ? storedColor : CHROMA_KEY_DEFAULTS.color,
		}),
	});
	if (!color) return null;

	return {
		color,
		tolerance: numberAt({ key: CHROMA_KEY_PARAM_KEYS.tolerance, fallback: CHROMA_KEY_DEFAULTS.tolerance }),
		softness: numberAt({ key: CHROMA_KEY_PARAM_KEYS.softness, fallback: CHROMA_KEY_DEFAULTS.softness }),
		spill: numberAt({ key: CHROMA_KEY_PARAM_KEYS.spill, fallback: CHROMA_KEY_DEFAULTS.spill }),
		invert: params[CHROMA_KEY_PARAM_KEYS.invert] === true,
	};
}

/** Identity of a settings value, for texture cache keys (the numbers are rounded to what changes the pixels). */
export function chromaKeyHash({ settings }: { settings: ChromaKeySettings }): string {
	const { color, tolerance, softness, spill, invert } = settings;
	return `${color.r},${color.g},${color.b}:${tolerance.toFixed(2)}:${softness.toFixed(2)}:${spill.toFixed(2)}:${invert ? 1 : 0}`;
}

/**
 * The pixel's chroma with its brightness taken out (every channel divided by
 * the brightest one, but by at least MIN_SCALE so near-black noise is not
 * blown up): a shadowed green screen has the same normalised chroma as a lit
 * one.
 */
const MIN_SCALE = 0.08;
function normalisedChromaOf({ r, g, b }: { r: number; g: number; b: number }) {
	const scale = Math.max(r, g, b, MIN_SCALE);
	return chromaOf({ r: r / scale, g: g / scale, b: b / scale });
}

function chromaOf({ r, g, b }: { r: number; g: number; b: number }) {
	// BT.601, r g b in 0..1; cb and cr in -0.5..0.5.
	return {
		cb: -0.168736 * r - 0.331264 * g + 0.5 * b,
		cr: 0.5 * r - 0.418688 * g - 0.081312 * b,
	};
}

/** The widest chroma distance the tolerance can reach (a share of the full chroma range). */
const MAX_TOLERANCE_DISTANCE = 0.6;
const MAX_SOFT_DISTANCE = 0.4;

/**
 * Keys RGBA pixels in place. A pixel's alpha follows its chroma distance to the
 * key: 0 inside the tolerance, rising to its own alpha across the softness.
 * Kept pixels have the key colour's cast taken out by `spill`. `invert` keeps
 * the keyed colour instead. Pure and deterministic: the same pixels and
 * settings give the same result in preview and export.
 */
export function applyChromaKey({
	data,
	settings,
}: {
	data: Uint8ClampedArray;
	settings: ChromaKeySettings;
}): void {
	const keyRgb = {
		r: settings.color.r / 255,
		g: settings.color.g / 255,
		b: settings.color.b / 255,
	};
	const key = normalisedChromaOf(keyRgb);
	const rawKey = chromaOf(keyRgb);
	const keyLength = Math.hypot(rawKey.cb, rawKey.cr);
	const direction =
		keyLength > 1e-6 ? { cb: rawKey.cb / keyLength, cr: rawKey.cr / keyLength } : null;
	const tolerance = (settings.tolerance / 100) * MAX_TOLERANCE_DISTANCE;
	const soft = Math.max((settings.softness / 100) * MAX_SOFT_DISTANCE, 1e-6);
	const spill = settings.spill / 100;

	for (let index = 0; index < data.length; index += 4) {
		const alpha = data[index + 3];
		if (alpha === 0) continue;
		const r = data[index] / 255;
		const g = data[index + 1] / 255;
		const b = data[index + 2] / 255;
		const { cb, cr } = chromaOf({ r, g, b });
		const lit = normalisedChromaOf({ r, g, b });
		const distance = Math.hypot(lit.cb - key.cb, lit.cr - key.cr);
		let keep = Math.max(0, Math.min(1, (distance - tolerance) / soft));
		if (settings.invert) keep = 1 - keep;
		data[index + 3] = Math.round(alpha * keep);

		if (spill > 0 && direction && keep > 0 && !settings.invert) {
			const along = cb * direction.cb + cr * direction.cr;
			if (along > 0) {
				const y = 0.299 * r + 0.587 * g + 0.114 * b;
				const nextCb = cb - spill * along * direction.cb;
				const nextCr = cr - spill * along * direction.cr;
				data[index] = Math.round(Math.max(0, Math.min(1, y + 1.402 * nextCr)) * 255);
				data[index + 1] = Math.round(
					Math.max(0, Math.min(1, y - 0.344136 * nextCb - 0.714136 * nextCr)) * 255,
				);
				data[index + 2] = Math.round(Math.max(0, Math.min(1, y + 1.772 * nextCb)) * 255);
			}
		}
	}
}
