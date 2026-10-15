import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ExportOptions } from "@/export";
import type { SceneTracks } from "@/timeline";
import { buildStickerElement } from "@/timeline/element-utils";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { RendererManager } from "@/core/managers/renderer-manager";
import {
	STICKER_RETRY_AFTER_MS,
	loadStickerSource,
} from "@/services/renderer/nodes/sticker-node";
import {
	assertStickersLoadable,
	collectStickers,
	findUnloadableStickers,
	formatStickerExportError,
	preflightStickers,
} from "@/services/renderer/sticker-preflight";

// An export must not silently leave a sticker out of the video. Before it
// starts, every sticker on the timeline is loaded; one that cannot be loaded
// stops the export with a message that names it (the way an image does).

function sticker({ name, stickerId, hidden }: { name: string; stickerId: string; hidden?: boolean }) {
	return { type: "sticker", name, stickerId, ...(hidden === undefined ? {} : { hidden }) };
}
function track({ elements, hidden }: { elements: ReturnType<typeof sticker>[] | { type: string; name: string }[]; hidden?: boolean }) {
	return { elements, ...(hidden === undefined ? {} : { hidden }) };
}

describe("collectStickers", () => {
	test("finds the stickers of every visible track, overlay then main", () => {
		const tracks = {
			overlay: [
				track({ elements: [sticker({ name: "Fire", stickerId: "emoji:1f525" })] }),
				track({ elements: [sticker({ name: "Heart", stickerId: "icons:heart" })] }),
			],
			main: track({ elements: [sticker({ name: "Flag", stickerId: "flags:US" })] }),
		};
		expect(collectStickers({ tracks })).toEqual([
			{ stickerId: "emoji:1f525", names: ["Fire"] },
			{ stickerId: "icons:heart", names: ["Heart"] },
			{ stickerId: "flags:US", names: ["Flag"] },
		]);
	});

	test("skips what the export does not draw: hidden elements, hidden tracks, other element types", () => {
		const tracks = {
			overlay: [
				track({
					elements: [
						sticker({ name: "Hidden", stickerId: "emoji:1", hidden: true }),
						sticker({ name: "Shown", stickerId: "emoji:2", hidden: false }),
						{ type: "text", name: "Title" },
					],
				}),
				track({ hidden: true, elements: [sticker({ name: "In hidden track", stickerId: "emoji:3" })] }),
			],
			main: track({ elements: [] }),
		};
		expect(collectStickers({ tracks }).map((entry) => entry.stickerId)).toEqual(["emoji:2"]);
	});

	test("a sticker used several times is listed once, with each distinct name", () => {
		const tracks = {
			overlay: [
				track({
					elements: [
						sticker({ name: "Fire", stickerId: "emoji:1f525" }),
						sticker({ name: "Fire", stickerId: "emoji:1f525" }),
						sticker({ name: "My flame", stickerId: "emoji:1f525" }),
					],
				}),
			],
			main: track({ elements: [] }),
		};
		expect(collectStickers({ tracks })).toEqual([{ stickerId: "emoji:1f525", names: ["Fire", "My flame"] }]);
	});

	test("an empty timeline has none", () => {
		expect(collectStickers({ tracks: { overlay: [], main: track({ elements: [] }) } })).toEqual([]);
	});
});

describe("formatStickerExportError", () => {
	const failed = (...names: string[]) => names.map((name, index) => ({ stickerId: `emoji:${index}`, names: [name] }));

	test("one sticker", () => {
		expect(formatStickerExportError({ failed: failed("Heart") })).toBe(
			'Sticker "Heart" could not be loaded. Remove it or re-add it.',
		);
	});

	test("several stickers", () => {
		expect(formatStickerExportError({ failed: failed("Heart", "Fire") })).toBe(
			'Stickers "Heart", "Fire" could not be loaded. Remove them or re-add them.',
		);
	});

	test("the same name on two stickers is named once", () => {
		expect(formatStickerExportError({ failed: failed("Heart", "Heart") })).toBe(
			'Sticker "Heart" could not be loaded. Remove it or re-add it.',
		);
	});

	test("a long list is cut after five", () => {
		const message = formatStickerExportError({ failed: failed("A", "B", "C", "D", "E", "F", "G") });
		expect(message).toBe('Stickers "A", "B", "C", "D", "E" and 2 more could not be loaded. Remove them or re-add them.');
	});

	test("falls back to the sticker id when an element has no name", () => {
		expect(formatStickerExportError({ failed: [{ stickerId: "emoji:zzz", names: [] }] })).toBe(
			'Sticker "emoji:zzz" could not be loaded. Remove it or re-add it.',
		);
	});
});

describe("a damaged project (sticker ids and names that are not strings)", () => {
	const damaged = {
		overlay: [
			{
				elements: [
					{ type: "sticker", name: "Number id", stickerId: 123 },
					{ type: "sticker", name: "No id" },
					{ type: "sticker", name: "Null id", stickerId: null },
					{ type: "sticker", name: "Object id", stickerId: {} },
					{ type: "sticker", name: 42, stickerId: "emoji:1f525" },
					{ type: "sticker", stickerId: "emoji:1f525" },
				],
			},
		],
		main: { elements: [] },
	};

	test("collectStickers does not throw, and lists each damaged element under its type", () => {
		const found = collectStickers({ tracks: damaged });
		expect(found.map((entry) => entry.stickerId)).toEqual(["<number>", "<undefined>", "<null>", "<object>", "emoji:1f525"]);
		expect(found[0].names).toEqual(["Number id"]);
		expect(found[4].names).toEqual([]); // names that are not strings are left out
	});

	test("they count as stickers that cannot be loaded, named in the export error", async () => {
		await expect(assertStickersLoadable({ tracks: damaged, load: async ({ stickerId }) => (stickerId.startsWith("<") ? Promise.reject(new Error("no")) : {}) }))
			.rejects.toThrow(/"Number id", "No id", "Null id", "Object id"/);
	});

	test("with the real loader too: a damaged element stops the export instead of crashing the preflight", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		await expect(assertStickersLoadable({ tracks: damaged })).rejects.toThrow(/could not be loaded/);
		warn.mockRestore();
	});
});

describe("the export error stays short whatever the names are", () => {
	test("seven names of 10,000 characters", () => {
		const failed = Array.from({ length: 7 }, (_, index) => ({ stickerId: `emoji:${index}`, names: [`${index}${"n".repeat(10_000)}`] }));
		const message = formatStickerExportError({ failed });
		expect(message.length).toBeLessThan(700);
		expect(message).toContain("and 2 more");
	});

	test("an id of 10,000 characters used as the name", () => {
		const message = formatStickerExportError({ failed: [{ stickerId: `icons:${"x".repeat(10_000)}`, names: [] }] });
		expect(message.length).toBeLessThan(200);
	});
});

describe("findUnloadableStickers", () => {
	const tracks = {
		overlay: [
			track({
				elements: [
					sticker({ name: "Fire", stickerId: "emoji:ok" }),
					sticker({ name: "Broken", stickerId: "emoji:bad" }),
					sticker({ name: "Also broken", stickerId: "emoji:bad" }),
				],
			}),
		],
		main: track({ elements: [] }),
	};

	test("lists the stickers whose load fails, with every element name", async () => {
		const failed = await findUnloadableStickers({
			tracks,
			load: async ({ stickerId }) => {
				if (stickerId === "emoji:bad") throw new Error("nope");
				return {};
			},
		});
		expect(failed).toEqual([{ stickerId: "emoji:bad", names: ["Broken", "Also broken"] }]);
	});

	test("is empty when every sticker loads", async () => {
		expect(await findUnloadableStickers({ tracks, load: async () => ({}) })).toEqual([]);
	});

	test("loads all stickers at the same time, not one after another", async () => {
		const many = {
			overlay: [track({ elements: Array.from({ length: 10 }, (_, index) => sticker({ name: `S${index}`, stickerId: `emoji:${index}` })) })],
			main: track({ elements: [] }),
		};
		// performance.now(), not Date.now(): this file freezes Date.now for the cache tests,
		// and a frozen clock would make any elapsed-time check pass.
		const started = performance.now();
		await findUnloadableStickers({ tracks: many, load: () => new Promise((done) => setTimeout(() => done({}), 40)) });
		expect(performance.now() - started).toBeLessThan(250); // 10 x 40 ms in a row would be 400
	});
});

describe("preflightStickers (a cancel is heard while the stickers load)", () => {
	const tracks = {
		overlay: [track({ elements: [sticker({ name: "Fire", stickerId: "emoji:ok" }), sticker({ name: "Broken", stickerId: "emoji:bad" })] })],
		main: track({ elements: [] }),
	};
	const never = () => new Promise<unknown>(() => {});
	const POLL = 5;
	const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
	const failBad = async ({ stickerId }: { stickerId: string }) => (stickerId === "emoji:bad" ? Promise.reject(new Error("no")) : {});

	test("everything loads: ready", async () => {
		expect(await preflightStickers({ tracks, load: async () => ({}), isCancelled: () => false, pollMs: POLL })).toBe("ready");
	});

	test("without a cancel check it is the plain preflight", async () => {
		await expect(preflightStickers({ tracks, load: failBad })).rejects.toThrow('Sticker "Broken" could not be loaded.');
		expect(await preflightStickers({ tracks, load: async () => ({}) })).toBe("ready");
	});

	test("a sticker that never answers does not hold the cancel back", async () => {
		let calls = 0;
		// performance.now(), not Date.now(): this file freezes Date.now.
		const started = performance.now();
		const outcome = await preflightStickers({ tracks, load: never, isCancelled: () => ++calls > 3, pollMs: POLL });
		expect(outcome).toBe("cancelled");
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("the check stops once it has answered (no timer is left running)", async () => {
		let calls = 0;
		await preflightStickers({ tracks, load: never, isCancelled: () => ++calls > 2, pollMs: POLL });
		const settled = calls;
		await wait(POLL * 8);
		expect(calls).toBe(settled);
	});

	test("also stops after a normal finish", async () => {
		let calls = 0;
		await preflightStickers({ tracks, load: () => wait(POLL * 3).then(() => ({})), isCancelled: () => (calls++, false), pollMs: POLL });
		const settled = calls;
		await wait(POLL * 8);
		expect(calls).toBe(settled);
	});

	test("already cancelled: nothing is loaded at all", async () => {
		const requested: string[] = [];
		const outcome = await preflightStickers({
			tracks,
			load: async ({ stickerId }) => (requested.push(stickerId), {}),
			isCancelled: () => true,
			pollMs: POLL,
		});
		expect(outcome).toBe("cancelled");
		expect(requested).toEqual([]);
	});

	test("a sticker that fails after the user pressed Cancel ends as a cancel, not as an error", async () => {
		let calls = 0;
		// The first answer (before loading) is "no", every later one is "yes".
		const outcome = await preflightStickers({ tracks, load: failBad, isCancelled: () => ++calls > 1, pollMs: 1000 });
		expect(outcome).toBe("cancelled");
	});

	test("a sticker that fails with no cancel is still the sticker's error", async () => {
		await expect(preflightStickers({ tracks, load: failBad, isCancelled: () => false, pollMs: POLL })).rejects.toThrow(
			'Sticker "Broken" could not be loaded. Remove it or re-add it.',
		);
	});

	test("a load that fails after the cancel won leaves no unhandled rejection", async () => {
		let calls = 0;
		const outcome = await preflightStickers({
			tracks,
			load: () => wait(POLL * 6).then(() => Promise.reject(new Error("late failure"))),
			isCancelled: () => ++calls > 2,
			pollMs: POLL,
		});
		expect(outcome).toBe("cancelled");
		await wait(POLL * 12); // the late rejection happens now; an unhandled one would fail the run
	});
});

// --- with the real loader, through a fake <img> ---

const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
const originalNow = Date.now;
let failingUrls = new Set<string>();
let hangingUrls = new Set<string>();
let imagesCreated: string[] = [];
let clock = 5_000_000;

class FakeImage {
	naturalWidth = 64;
	naturalHeight = 64;
	onload: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	set src(url: string) {
		if (url === "") return;
		imagesCreated.push(url);
		if (hangingUrls.has(url)) return; // never answers: a stalled request
		queueMicrotask(() =>
			failingUrls.has(url) ? this.onerror?.(new Event("error")) : this.onload?.(new Event("load")),
		);
	}
}

beforeEach(() => {
	failingUrls = new Set();
	hangingUrls = new Set();
	imagesCreated = [];
	clock = 5_000_000;
	Date.now = () => clock;
	Object.defineProperty(globalThis, "Image", { configurable: true, writable: true, value: FakeImage });
});
afterEach(() => {
	if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
	else Reflect.deleteProperty(globalThis, "Image");
	Date.now = originalNow;
});

let counter = 0;
function freshTracks() {
	counter += 1;
	const good = `emoji:1f5${counter.toString(16)}`;
	const bad = `icons:export-missing-${counter}`;
	return {
		good,
		bad,
		badUrl: `/icons/phosphor/export-missing-${counter}.svg`,
		tracks: {
			overlay: [
				track({
					elements: [
						sticker({ name: "Fine", stickerId: good }),
						sticker({ name: "Missing icon", stickerId: bad }),
					],
				}),
			],
			main: track({ elements: [] }),
		},
	};
}

describe("assertStickersLoadable (the export preflight)", () => {
	test("stops with an error that names the sticker", async () => {
		const { tracks, badUrl } = freshTracks();
		failingUrls.add(badUrl);
		await expect(assertStickersLoadable({ tracks })).rejects.toThrow(
			'Sticker "Missing icon" could not be loaded. Remove it or re-add it.',
		);
	});

	test("passes when everything loads", async () => {
		const { tracks } = freshTracks();
		await expect(assertStickersLoadable({ tracks })).resolves.toBeUndefined();
	});

	test("two exports in a row give the same result, whatever the clock says", async () => {
		const { tracks, badUrl } = freshTracks();
		failingUrls.add(badUrl);
		const messages: string[] = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			clock += attempt === 1 ? STICKER_RETRY_AFTER_MS * 3 : 7;
			try {
				await assertStickersLoadable({ tracks });
				messages.push("passed");
			} catch (error) {
				messages.push(error instanceof Error ? error.message : String(error));
			}
		}
		expect(new Set(messages).size).toBe(1);
		expect(messages[0]).toContain("Missing icon");
	});

	test("really tries again each time: a preview failure a moment ago does not make the export fail", async () => {
		const { tracks, bad, badUrl } = freshTracks();
		failingUrls.add(badUrl);
		await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow(); // the preview saw it fail

		failingUrls.delete(badUrl); // fixed
		clock += 10; // ...well inside the preview's retry delay
		await expect(assertStickersLoadable({ tracks })).resolves.toBeUndefined();
	});

	test("after a passing preflight the export frames need no further requests", async () => {
		const { tracks, good } = freshTracks();
		await assertStickersLoadable({ tracks });
		const requests = imagesCreated.length;
		for (let frame = 0; frame < 100; frame++) {
			clock += 33;
			await loadStickerSource({ stickerId: good, retry: "never" });
		}
		expect(imagesCreated).toHaveLength(requests);
	});
});

// --- the manager: the error reaches the ExportError panel, before any work is done ---

describe("RendererManager.exportProject", () => {
	const options: ExportOptions = { format: "mp4", quality: "high", includeAudio: true };

	function managerFor({ tracks }: { tracks: object }) {
		const touched: string[] = [];
		// Object.create returns any: the fake only has what exportProject reads.
		const editor = Object.assign(Object.create(null), {
			scenes: {
				getActiveScene: () => {
					touched.push("scene");
					return { tracks };
				},
			},
			media: { getAssets: () => (touched.push("media"), []) },
			project: {
				getActive: () => ({ metadata: { name: "Film" }, settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } } }),
			},
			timeline: { getTotalDuration: () => 4000 },
		});
		// The manager only needs these four collaborators before the preflight.
		return { touched, manager: new RendererManager(editor) };
	}

	test("a sticker that cannot be loaded ends the export with its name in the error, before audio or encoding", async () => {
		const { tracks, badUrl } = freshTracks();
		failingUrls.add(badUrl);
		const progress: number[] = [];
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const { manager } = managerFor({ tracks });
		const result = await manager.exportProject({ options, onProgress: ({ progress: value }) => progress.push(value) });
		expect(result).toEqual({
			success: false,
			error: 'Sticker "Missing icon" could not be loaded. Remove it or re-add it.',
		});
		expect(progress).toEqual([]); // the audio stage (progress 0.05) was never reached
		consoleError.mockRestore();
	});

	test("Cancel is heard while a sticker is still loading, and it is a cancel, not an error", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const { tracks, badUrl } = freshTracks();
		hangingUrls.add(badUrl);
		const progress: number[] = [];
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 300);
		const { manager } = managerFor({ tracks });
		const started = performance.now();
		const result = await manager.exportProject({
			options,
			onProgress: ({ progress: value }) => progress.push(value),
			signal: controller.signal,
		});
		clearTimeout(timer);
		expect(result).toEqual({ success: false, cancelled: true });
		expect(progress).toEqual([]);
		expect(performance.now() - started).toBeLessThan(3000); // the stalled load would take 10 s
		expect(consoleError).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	test("with loadable stickers the export goes on past the preflight", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const { good } = freshTracks();
		const element = {
			...buildStickerElement({ stickerId: good, name: "Fine", startTime: ZERO_MEDIA_TIME, intrinsicWidth: 64, intrinsicHeight: 64 }),
			id: "element-1",
		};
		const realTracks: SceneTracks = {
			overlay: [{ id: "graphics", name: "Graphics", type: "graphic", elements: [element], hidden: false }],
			main: { id: "main", name: "Main", type: "video", elements: [], muted: false, hidden: false },
			audio: [],
		};
		const { manager } = managerFor({ tracks: realTracks });
		const result = await manager.exportProject({ options: { ...options, includeAudio: false } });
		// Past the preflight the export builds the scene and the encoder, and this
		// test runtime has no OffscreenCanvas: that is the exact point it stops at.
		// (A refused sticker would have been a different, sticker error.)
		expect(result).toEqual({ success: false, error: "OffscreenCanvas is not defined" });
		consoleError.mockRestore();
	});
});
