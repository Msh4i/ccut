/**
 * Alpha mattes for clips: the smart (AI) cutout and the brush cutout. A matte is a small 8-bit
 * picture (255 = keep, 0 = remove) that is multiplied into the clip's alpha, after the colour
 * key, in the one place the texture is built (`keyedSourceTexture`). It is NOT part of the
 * project JSON: sources register themselves here per element and the renderer asks for the
 * matte of a source second.
 */
export type Matte = {
	width: number;
	height: number;
	/** width * height bytes, row by row, 0 = remove, 255 = keep. */
	data: Uint8Array;
	/** Changes whenever `data` does: part of the texture's content hash. */
	hash: string;
};

export type MatteKind = "ai" | "brush";

export interface MatteSource {
	/** The matte for this second of the clip's SOURCE media, or null (nothing to apply). */
	/** `clipTime`: clip-local time (media ticks), `sourceSeconds`: the second of the source media. */
	lookup({ sourceSeconds, clipTime }: { sourceSeconds: number; clipTime: number }): Matte | null;
}

const sources = new Map<string, Map<MatteKind, MatteSource>>();
let revision = 0;

/** Changes whenever a source is added or removed: the preview redraws a paused frame then. */
export function getMatteRevision(): number {
	return revision;
}

export function registerMatteSource({
	elementId,
	kind,
	source,
}: {
	elementId: string;
	kind: MatteKind;
	source: MatteSource;
}): void {
	const forElement = sources.get(elementId) ?? new Map<MatteKind, MatteSource>();
	forElement.set(kind, source);
	sources.set(elementId, forElement);
	revision += 1;
}

export function unregisterMatteSource({
	elementId,
	kind,
}: {
	elementId: string;
	kind: MatteKind;
}): void {
	const forElement = sources.get(elementId);
	if (!forElement) return;
	if (forElement.delete(kind)) revision += 1;
	if (forElement.size === 0) sources.delete(elementId);
}

export function hasMatteSource({ elementId, kind }: { elementId: string; kind: MatteKind }): boolean {
	return sources.get(elementId)?.has(kind) ?? false;
}

/** Every matte that applies to the element at this source second (AI first, then brush). */
export function lookupMattes({
	elementId,
	sourceSeconds,
	clipTime,
	kinds,
}: {
	elementId: string | undefined;
	sourceSeconds: number;
	clipTime: number;
	kinds: readonly MatteKind[];
}): Matte[] {
	if (!elementId) return [];
	const forElement = sources.get(elementId);
	if (!forElement) return [];
	const found: Matte[] = [];
	for (const kind of kinds) {
		const matte = forElement.get(kind)?.lookup({ sourceSeconds, clipTime });
		if (matte) found.push(matte);
	}
	return found;
}

/** Multiplies the mattes into the alpha channel of RGBA `pixels` (bilinear upscale of each matte). */
export function applyMattes({
	pixels,
	width,
	height,
	mattes,
}: {
	pixels: Uint8ClampedArray;
	width: number;
	height: number;
	mattes: readonly Matte[];
}): void {
	for (const matte of mattes) {
		const { width: mw, height: mh, data } = matte;
		if (mw < 1 || mh < 1 || data.length < mw * mh) continue;
		const scaleX = mw / width;
		const scaleY = mh / height;
		for (let y = 0; y < height; y++) {
			const fy = Math.min(Math.max((y + 0.5) * scaleY - 0.5, 0), mh - 1);
			const y0 = Math.floor(fy);
			const y1 = Math.min(y0 + 1, mh - 1);
			const wy = fy - y0;
			for (let x = 0; x < width; x++) {
				const fx = Math.min(Math.max((x + 0.5) * scaleX - 0.5, 0), mw - 1);
				const x0 = Math.floor(fx);
				const x1 = Math.min(x0 + 1, mw - 1);
				const wx = fx - x0;
				const top = (data[y0 * mw + x0] ?? 0) * (1 - wx) + (data[y0 * mw + x1] ?? 0) * wx;
				const bottom = (data[y1 * mw + x0] ?? 0) * (1 - wx) + (data[y1 * mw + x1] ?? 0) * wx;
				const keep = (top * (1 - wy) + bottom * wy) / 255;
				const index = (y * width + x) * 4 + 3;
				pixels[index] = Math.round((pixels[index] ?? 0) * keep);
			}
		}
	}
}

export function matteHash({ mattes }: { mattes: readonly Matte[] }): string {
	return mattes.map((matte) => `${matte.width}x${matte.height}:${matte.hash}`).join("|");
}

/** Element param that turns the smart (AI) cutout on for a clip. */
export const SMART_CUTOUT_ENABLED_KEY = "smartCutout.enabled";

/** The kinds of matte that apply to a clip with these stored params. */
export function matteKindsFor({
	params,
}: {
	params: Record<string, unknown> | undefined;
}): readonly MatteKind[] {
	return params?.[SMART_CUTOUT_ENABLED_KEY] === true ? ["ai", "brush"] : ["brush"];
}
