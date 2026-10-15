/**
 * Checks and light normalisation for third-party SVG files that ship as
 * stickers. A sticker is drawn through `<img>` and then copied onto the export
 * canvas, so it must be a self-contained, inert SVG with a namespace and a
 * viewBox (without a namespace `<img>` refuses to render it).
 */

const SVG_ROOT_PATTERN = /<svg\b[^>]*>/;
const VIEW_BOX_PATTERN = /\bviewBox\s*=\s*"([^"]*)"/;
const SVG_NAMESPACE = 'xmlns="http://www.w3.org/2000/svg"';

const FORBIDDEN_CONTENT: { pattern: RegExp; reason: string }[] = [
	{ pattern: /<\s*(script|foreignObject|iframe|embed|object)\b/i, reason: "active content" },
	{ pattern: /\son[a-z]+\s*=/i, reason: "event handler attribute" },
	{ pattern: /javascript:/i, reason: "javascript: URL" },
	{ pattern: /@import/i, reason: "CSS @import" },
	{ pattern: /\bhref\s*=\s*["'](?!#)/i, reason: "external href" },
	{ pattern: /url\(\s*["']?(?!#)/i, reason: "external url()" },
];

/**
 * The elements the shipped sets use (measured over all 4,732 SVGs) plus plain
 * shapes. Anything else (style, text, image, a, animate, set ...) is refused:
 * a sticker is a picture, not a document.
 */
const ALLOWED_ELEMENTS = new Set([
	"svg",
	"g",
	"defs",
	"path",
	"circle",
	"ellipse",
	"rect",
	"line",
	"polyline",
	"polygon",
	"use",
	"clipPath",
	"mask",
	"stop",
	"linearGradient",
	"radialGradient",
	"marker",
	"filter",
	"feColorMatrix",
	"feBlend",
	"feFlood",
	"feOffset",
	"feGaussianBlur",
]);

/** Real files nest about 6 deep. */
const MAX_NESTING_DEPTH = 64;
/** Real files have up to 672 elements. */
const MAX_ELEMENTS = 5_000;
/**
 * What a file may draw once every <use> is expanded. Real files stay in the
 * low thousands; a chain of groups that each use the one before reaches 2^40
 * from about 80 <use> elements, so the count of elements alone cannot stop it.
 */
const MAX_EXPANDED_ELEMENTS = 100_000;
/** Plain `name:value` pairs: the six styles of the shipped flags and nothing that can hold a function call. */
const SAFE_STYLE = /^(?:-?[a-z][a-z-]*:(?:[\w #.%-]|&quot;)+;?)+$/i;
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const USE_REFERENCE = /\s(?:xlink:)?href\s*=\s*(?:"#([^"]*)"|'#([^']*)')/i;
const ID_ATTRIBUTE = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

const COMMENT = /<!--[\s\S]*?-->/g;
const STRAY_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i;
const ONLY_WHITESPACE = /^\s*$/;
/** One tag: attributes must be name="value" (or 'value'); values hold no "<". */
const TAG_TOKEN =
	/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'))?)*)\s*(\/?)>/y;

export interface SvgViewBox {
	minX: number;
	minY: number;
	width: number;
	height: number;
}

function readRootTag({ svg }: { svg: string }): string | null {
	return SVG_ROOT_PATTERN.exec(svg)?.[0] ?? null;
}

export function readSvgViewBox({ svg }: { svg: string }): SvgViewBox | null {
	const root = readRootTag({ svg });
	const raw = root ? VIEW_BOX_PATTERN.exec(root)?.[1] : undefined;
	if (raw === undefined) {
		return null;
	}

	const parts = raw.trim().split(/[\s,]+/).map(Number);
	if (parts.length !== 4 || !parts.every(Number.isFinite)) {
		return null;
	}
	const [minX, minY, width, height] = parts;
	return { minX, minY, width, height };
}

/**
 * Walks the markup tag by tag: it must be well formed (every tag closed in
 * order, attributes quoted), use only allowed elements, nest sanely, and hold
 * no text, DOCTYPE, ENTITY, CDATA or processing instruction.
 */
function checkStructure({ svg, label }: { svg: string; label: string }): void {
	const markup = svg.trim().replace(COMMENT, "");
	if (/<[!?]/.test(markup)) {
		throw new Error(`${label}: contains a DOCTYPE, CDATA or processing instruction`);
	}
	if (STRAY_ENTITY.test(markup)) {
		throw new Error(`${label}: contains an entity reference`);
	}
	// Character references and CSS escapes can spell "url(" past every other check.
	if (markup.includes("&#")) {
		throw new Error(`${label}: contains a character reference`);
	}
	if (markup.includes("\\")) {
		throw new Error(`${label}: contains a backslash`);
	}

	const open: string[] = [];
	const nodes: SvgNode[] = [];
	const openNodes: number[] = [];
	let position = 0;
	let sawRoot = false;
	// Each round consumes at least one character, so `markup.length` rounds are enough.
	for (let round = 0; round <= markup.length && position < markup.length; round++) {
		const next = markup.indexOf("<", position);
		const text = markup.slice(position, next === -1 ? markup.length : next);
		if (!ONLY_WHITESPACE.test(text)) {
			throw new Error(`${label}: contains text outside tags`);
		}
		if (next === -1) {
			position = markup.length;
			break;
		}

		TAG_TOKEN.lastIndex = next;
		const tag = TAG_TOKEN.exec(markup);
		if (!tag) {
			throw new Error(`${label}: malformed markup near "${markup.slice(next, next + 30)}"`);
		}
		const [, closing, name, attributes, selfClosing] = tag;
		position = TAG_TOKEN.lastIndex;

		if (closing) {
			if (open.pop() !== name) {
				throw new Error(`${label}: closing tag </${name}> does not match`);
			}
			openNodes.pop();
			continue;
		}
		if (!ALLOWED_ELEMENTS.has(name)) {
			throw new Error(`${label}: element <${name}> is not allowed`);
		}
		if (open.length === 0) {
			if (sawRoot || name !== "svg") {
				throw new Error(`${label}: expected a single <svg> root`);
			}
			sawRoot = true;
		}
		checkStyleAttributes({ attributes, label });
		const node: SvgNode = {
			id: ID_ATTRIBUTE.exec(attributes)?.slice(1).find(Boolean) ?? null,
			children: [],
			useTarget:
				name === "use"
					? (USE_REFERENCE.exec(attributes)?.slice(1).find(Boolean) ?? null)
					: null,
		};
		nodes.push(node);
		if (nodes.length > MAX_ELEMENTS) {
			throw new Error(`${label}: has too many elements`);
		}
		if (openNodes.length > 0) {
			nodes[openNodes[openNodes.length - 1]].children.push(nodes.length - 1);
		}
		if (!selfClosing) {
			open.push(name);
			openNodes.push(nodes.length - 1);
			if (open.length > MAX_NESTING_DEPTH) {
				throw new Error(`${label}: elements are nested too deep`);
			}
		}
	}

	if (open.length > 0) {
		throw new Error(`${label}: <${open[open.length - 1]}> is never closed`);
	}

	checkExpansion({ nodes, label });
}

interface SvgNode {
	id: string | null;
	children: number[];
	useTarget: string | null;
}

function checkStyleAttributes({
	attributes,
	label,
}: {
	attributes: string;
	label: string;
}): void {
	for (const match of attributes.matchAll(STYLE_ATTRIBUTE)) {
		const value = match[1] ?? match[2] ?? "";
		if (!SAFE_STYLE.test(value)) {
			throw new Error(`${label}: has a style attribute that is not plain name:value pairs`);
		}
	}
}

/**
 * How many elements the file draws once every <use> is replaced by what it
 * points at. Refused when that is absurd (a bomb) or when a use leads back to
 * itself.
 */
function checkExpansion({
	nodes,
	label,
}: {
	nodes: SvgNode[];
	label: string;
}): void {
	const byId = new Map<string, number>();
	nodes.forEach((node, index) => {
		if (node.id !== null && !byId.has(node.id)) {
			byId.set(node.id, index);
		}
	});

	const sizes = new Map<number, number>();
	const visiting = new Set<number>();

	function sizeOf(index: number): number {
		const known = sizes.get(index);
		if (known !== undefined) {
			return known;
		}
		if (visiting.has(index)) {
			throw new Error(`${label}: a <use> leads back to itself (a reference loop)`);
		}
		visiting.add(index);
		const node = nodes[index];
		let size = 1;
		for (const child of node.children) {
			size += sizeOf(child);
		}
		const target = node.useTarget === null ? undefined : byId.get(node.useTarget);
		if (target !== undefined) {
			size += sizeOf(target);
		}
		visiting.delete(index);
		if (size > MAX_EXPANDED_ELEMENTS) {
			throw new Error(`${label}: expands to too many elements`);
		}
		sizes.set(index, size);
		return size;
	}

	for (let index = 0; index < nodes.length; index++) {
		sizeOf(index);
	}
}

/** Throws when `svg` is not a safe, self-contained, renderable SVG. */
export function validateSvgAsset({
	svg,
	label,
}: {
	svg: string;
	label: string;
}): void {
	const trimmed = svg.trim();
	if (!trimmed.startsWith("<svg") || !trimmed.endsWith("</svg>")) {
		throw new Error(`${label}: not a complete SVG document`);
	}

	const root = readRootTag({ svg: trimmed });
	if (!root?.includes(SVG_NAMESPACE)) {
		throw new Error(`${label}: root element has no ${SVG_NAMESPACE}`);
	}

	const viewBox = readSvgViewBox({ svg: trimmed });
	if (!viewBox || viewBox.width <= 0 || viewBox.height <= 0) {
		throw new Error(`${label}: missing or empty viewBox`);
	}

	for (const { pattern, reason } of FORBIDDEN_CONTENT) {
		if (pattern.test(trimmed)) {
			throw new Error(`${label}: contains ${reason}`);
		}
	}

	checkStructure({ svg: trimmed, label });
}

function setRootAttribute({
	root,
	name,
	value,
}: {
	root: string;
	name: "width" | "height";
	value: string;
}): string {
	const existing = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
	return existing.test(root)
		? root.replace(existing, ` ${name}="${value}"`)
		: root.replace("<svg", `<svg ${name}="${value}"`);
}

/**
 * Sets the root width and height. The renderer rasterises a sticker at its
 * intrinsic size (the image's natural size) and scales the result, so a small
 * intrinsic size makes a large sticker soft. Everything else stays untouched.
 */
export function withSvgSize({
	svg,
	size,
}: {
	svg: string;
	size: number;
}): string {
	if (!Number.isFinite(size) || size <= 0) {
		throw new Error(`Invalid SVG size: ${size}`);
	}
	const root = readRootTag({ svg });
	if (!root) {
		throw new Error("Not an SVG: no <svg> root element");
	}

	const value = String(size);
	// Missing attributes are inserted right after "<svg", so set height first
	// to end up with width before height.
	let resized = setRootAttribute({ root, name: "height", value });
	resized = setRootAttribute({ root: resized, name: "width", value });
	// A function, not a string: "$&" or "$'" in the tag must stay literal.
	return svg.replace(root, () => resized);
}
