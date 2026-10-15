import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PhaseSection } from "@/animation/components/animation-tab";
import { PresetTileGrid, getTileId } from "@/animation/components/preset-tiles";
import type { PresetAnimations, PresetPhase } from "@/animation/presets";
import type { TileContent } from "@/animation/tiles/content";
import type { ElementType } from "@/timeline/types";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const TEXT: TileContent = {
	kind: "text",
	text: "Summer sale",
	fontFamily: '"Georgia", sans-serif',
	fontWeight: "bold",
	fontStyle: "normal",
	color: "#ffd166",
	needsLightBackdrop: false,
};
const POSTER = "data:image/jpeg;base64,AAAA";
const VIDEO: TileContent = { kind: "picture", src: POSTER, aspect: 16 / 9 };

function render({
	elementType = "text",
	content = TEXT,
	phase = "in",
	presetAnimations,
}: {
	elementType?: ElementType;
	content?: TileContent;
	phase?: PresetPhase;
	presetAnimations?: PresetAnimations;
}): string {
	return renderToStaticMarkup(
		<PresetTileGrid
			title={phase === "in" ? "In" : "Out"}
			phase={phase}
			elementType={elementType}
			content={content}
			presetAnimations={presetAnimations}
			duration={mediaTime({ ticks: 4 * TICKS_PER_SECOND })}
			playback={undefined}
			onChoose={() => {}}
		/>,
	);
}

/** Each tile button: whether it is pressed, and the text a screen reader names it by. */
function tiles(markup: string): { pressed: boolean; name: string; html: string }[] {
	return [...markup.matchAll(/<button[^>]*>.*?<\/button>/g)].map(([html]) => {
		const pressed = /aria-pressed="true"/.test(html);
		// The preview is aria-hidden; the name is the label after it.
		const label = /<span[^>]*>([^<]*)<\/span><\/button>$/.exec(html);
		return { pressed, name: label ? label[1] : "", html };
	});
}

describe("PresetTileGrid (static markup)", () => {
	test("a text element: a None tile plus one tile per preset, text-only ones included", () => {
		expect(tiles(render({})).map((tile) => tile.name)).toEqual([
			"None",
			"Fade",
			"From left",
			"From right",
			"From top",
			"From bottom",
			"Zoom",
			"Pop",
			"Typewriter",
			"Word reveal",
		]);
	});

	test("a video clip: no text-only presets", () => {
		const names = tiles(render({ elementType: "video", content: VIDEO })).map((tile) => tile.name);
		expect(names).toEqual(["None", "Fade", "From left", "From right", "From top", "From bottom", "Zoom", "Pop"]);
	});

	test("the Out grid uses the Out labels", () => {
		const names = tiles(render({ phase: "out" })).map((tile) => tile.name);
		expect(names.slice(0, 6)).toEqual(["None", "Fade", "To left", "To right", "To top", "To bottom"]);
	});

	test("the group is labelled by its phase", () => {
		expect(render({ phase: "out" })).toContain('role="group" aria-label="Out animation"');
	});

	test("with no preset, None is the pressed tile", () => {
		const pressed = tiles(render({})).filter((tile) => tile.pressed);
		expect(pressed.map((tile) => tile.name)).toEqual(["None"]);
	});

	test("the stored preset is the one pressed tile, in its own phase only", () => {
		const presetAnimations: PresetAnimations = {
			in: { id: "fade", duration: mediaTime({ ticks: TICKS_PER_SECOND }) },
			out: { id: "slide-left", duration: mediaTime({ ticks: TICKS_PER_SECOND }) },
		};
		expect(tiles(render({ presetAnimations })).filter((tile) => tile.pressed).map((tile) => tile.name)).toEqual([
			"Fade",
		]);
		expect(
			tiles(render({ presetAnimations, phase: "out" }))
				.filter((tile) => tile.pressed)
				.map((tile) => tile.name),
		).toEqual(["To left"]);
	});

	test("a stored preset this version does not know leaves None pressed, as before", () => {
		const presetAnimations = JSON.parse('{"in":{"id":"spin","duration":1000}}');
		expect(tiles(render({ presetAnimations })).filter((tile) => tile.pressed).map((tile) => tile.name)).toEqual([
			"None",
		]);
	});

	test("every tile is a button whose preview is hidden from screen readers and whose tooltip is the label", () => {
		for (const tile of tiles(render({}))) {
			expect(tile.html).toStartWith('<button type="button"');
			expect(tile.html).toContain('aria-hidden="true"');
			expect(tile.html).toContain(`title="${tile.name}"`);
			expect(tile.html).toMatch(/aria-pressed="(true|false)"/);
		}
	});

	test("text tiles show the element's text in its font, weight and colour", () => {
		const markup = render({});
		expect(tiles(markup)).toHaveLength(10);
		for (const tile of tiles(markup)) {
			expect(tile.html).toContain("font-family:&quot;Georgia&quot;, sans-serif");
			expect(tile.html).toContain("color:#ffd166");
			expect(tile.html).toContain("font-weight:bold");
		}
	});

	test("a still tile shows its preset half way: typewriter types half of the text, the rest keeps its place", () => {
		const typewriter = tiles(render({})).find((tile) => tile.name === "Typewriter");
		expect(typewriter?.html).toContain('>Summe</span><span class="invisible">r sale</span>');
		const wordReveal = tiles(render({})).find((tile) => tile.name === "Word reveal");
		expect(wordReveal?.html).toContain('>Summer</span><span class="invisible"> sale</span>');
		const none = tiles(render({})).find((tile) => tile.name === "None");
		expect(none?.html).toContain('>Summer sale</span><span class="invisible"></span>');
	});

	test("a still tile's pose comes from the preset: fade is half transparent, None at rest", () => {
		const all = tiles(render({}));
		expect(all.find((tile) => tile.name === "Fade")?.html).toContain("opacity:0.5");
		expect(all.find((tile) => tile.name === "None")?.html).toContain(
			"transform:translate(0%, 0%) scale(1);opacity:1",
		);
		// From left at half way: 1/8 of the way from just off the left edge.
		expect(all.find((tile) => tile.name === "From left")?.html).toContain(
			"transform:translate(-14.583%, 0%) scale(1)",
		);
	});

	test("dark text gets the light tile backdrop", () => {
		const dark = render({ content: { ...TEXT, color: "#000000", needsLightBackdrop: true } });
		const light = render({});
		expect(dark).toContain("bg-[hsl(0_0%_78%)]");
		expect(light).not.toContain("bg-[hsl(0_0%_78%)]");
	});

	test("clip tiles show the poster frame, in every tile", () => {
		const markup = render({ elementType: "video", content: VIDEO });
		for (const tile of tiles(markup)) {
			expect(tile.html).toContain(`src="${POSTER}"`);
			expect(tile.html).toContain('alt=""');
		}
	});

	test("a clip without a poster shows the placeholder box", () => {
		const markup = render({ elementType: "video", content: { kind: "picture", src: null, aspect: 16 / 9 } });
		expect(markup).not.toContain("<img");
		for (const tile of tiles(markup)) {
			expect(tile.html).toContain("lucide-image-off");
		}
	});

	test("the moving box is sized as a fraction of the tile, from the content's aspect", () => {
		expect(render({ elementType: "video", content: VIDEO })).toContain("width:62.5%;height:56.25%");
		expect(render({})).toContain("width:75%;height:40%");
	});

	test("tile ids are unique per phase and preset", () => {
		expect(getTileId({ phase: "in", presetId: "fade" })).not.toBe(getTileId({ phase: "out", presetId: "fade" }));
	});
});

/** The tiles in the tree `PresetTileGrid` returns: its children with a label and an onSelect. */
function tileHandlers(node: unknown): { label: string; select: () => void }[] {
	if (Array.isArray(node)) return node.flatMap(tileHandlers);
	if (!isValidElement<Record<string, unknown>>(node)) return [];
	const { label, onSelect, children } = node.props;
	if (typeof label === "string" && typeof onSelect === "function") {
		return [{ label, select: () => onSelect() }];
	}
	return tileHandlers(children);
}

describe("PresetTileGrid wiring (called directly: the grid itself has no hooks)", () => {
	function choicesOf({ phase, elementType }: { phase: PresetPhase; elementType: ElementType }) {
		const chosen: (string | undefined)[] = [];
		const tree = PresetTileGrid({
			title: "In",
			phase,
			elementType,
			content: elementType === "text" ? TEXT : VIDEO,
			presetAnimations: { in: { id: "zoom", duration: mediaTime({ ticks: TICKS_PER_SECOND }) } },
			duration: mediaTime({ ticks: 4 * TICKS_PER_SECOND }),
			playback: undefined,
			onChoose: (definition) => chosen.push(definition?.id),
		});
		const tiles = tileHandlers(tree);
		for (const tile of tiles) tile.select();
		return { labels: tiles.map((tile) => tile.label), chosen };
	}

	test("None chooses nothing; every other tile chooses its own preset", () => {
		expect(choicesOf({ phase: "in", elementType: "video" })).toEqual({
			labels: ["None", "Fade", "From left", "From right", "From top", "From bottom", "Zoom", "Pop"],
			chosen: [undefined, "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom", "pop"],
		});
	});

	test("the same in the Out grid, text-only presets included for text", () => {
		const { labels, chosen } = choicesOf({ phase: "out", elementType: "text" });
		expect(labels[2]).toBe("To left");
		expect(chosen).toEqual([
			undefined,
			"fade",
			"slide-left",
			"slide-right",
			"slide-up",
			"slide-down",
			"zoom",
			"pop",
			"typewriter",
			"word-reveal",
		]);
	});
});

describe("PhaseSection (static markup): the tiles replace the list, the duration stays below", () => {
	/** The section header has buttons of its own (collapse); the tiles are the pressable ones. */
	function presetTiles(markup: string) {
		return tiles(markup).filter((tile) => tile.html.includes("aria-pressed="));
	}

	function renderSection({ withDuration }: { withDuration: boolean }): string {
		return renderToStaticMarkup(
			<PhaseSection
				sectionKey="static-test:anim-in"
				title="In"
				phase="in"
				elementType="text"
				content={TEXT}
				presetAnimations={
					withDuration
						? { in: { id: "fade", duration: mediaTime({ ticks: TICKS_PER_SECOND / 2 }) } }
						: undefined
				}
				clipDuration={mediaTime({ ticks: 4 * TICKS_PER_SECOND })}
				playback={undefined}
				onChoose={() => {}}
				duration={
					withDuration
						? {
								seconds: 0.5,
								min: 0.1,
								max: 4,
								isLocked: false,
								defaultSeconds: 0.5,
								onPreview: () => {},
								onCommit: () => {},
								onReset: () => {},
							}
						: undefined
				}
			/>,
		);
	}

	test("the grid comes first, then the Duration field of the chosen preset", () => {
		const markup = renderSection({ withDuration: true });
		const grid = markup.indexOf('aria-label="In animation"');
		const durationField = markup.indexOf("In duration");
		expect(grid).toBeGreaterThan(-1);
		expect(durationField).toBeGreaterThan(grid);
		expect(presetTiles(markup)).toHaveLength(10);
	});

	test("without a preset there is no Duration field", () => {
		const markup = renderSection({ withDuration: false });
		expect(markup).not.toContain("In duration");
		expect(presetTiles(markup)).toHaveLength(10);
	});
});
