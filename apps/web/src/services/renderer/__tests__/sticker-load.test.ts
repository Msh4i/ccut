import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Transform } from "@/rendering";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { RootNode } from "@/services/renderer/nodes/root-node";
import {
	STICKER_RETRY_AFTER_MS,
	StickerNode,
	loadStickerSource,
	loadStickerSourceOrNull,
} from "@/services/renderer/nodes/sticker-node";
import { resolveRenderTree } from "@/services/renderer/resolve";

// A sticker that cannot be loaded (a bad id, a missing file, a transient
// failure, a request that never answers) costs only that sticker in preview:
// not the frame, and not for the rest of the session. In export it stops the
// export with an error (see sticker-export.test.ts). Only <img> loading is
// replaced here.

const IDENTITY: Transform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};

const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
const originalNow = Date.now;
let imagesCreated: string[] = [];
let failingUrls = new Set<string>();
let hangingUrls = new Set<string>();
let clock = 1_000_000;

class FakeImage {
	naturalWidth = 512;
	naturalHeight = 512;
	onload: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	set src(url: string) {
		if (url === "") return;
		imagesCreated.push(url);
		if (hangingUrls.has(url)) return;
		queueMicrotask(() =>
			failingUrls.has(url)
				? this.onerror?.(new Event("error"))
				: this.onload?.(new Event("load")),
		);
	}
}

beforeEach(() => {
	imagesCreated = [];
	failingUrls = new Set();
	hangingUrls = new Set();
	clock = 1_000_000;
	Date.now = () => clock;
	Object.defineProperty(globalThis, "Image", {
		configurable: true,
		writable: true,
		value: FakeImage,
	});
});

afterEach(() => {
	if (originalImage) {
		Object.defineProperty(globalThis, "Image", originalImage);
	} else {
		Reflect.deleteProperty(globalThis, "Image");
	}
	Date.now = originalNow;
});

let nextId = 0;
/** A fresh sticker id per test: the caches are module-level. */
function freshIds() {
	nextId += 1;
	return {
		good: `emoji:1f60${nextId.toString(16)}`,
		bad: `icons:no-such-icon-${nextId}`,
		badUrl: `/icons/phosphor/no-such-icon-${nextId}.svg`,
	};
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("loadStickerSource", () => {
	test("loads once and shares the result", async () => {
		const { good } = freshIds();
		const [first, second] = await Promise.all([
			loadStickerSource({ stickerId: good }),
			loadStickerSource({ stickerId: good }),
		]);
		expect(first).toBe(second);
		await loadStickerSource({ stickerId: good });
		expect(imagesCreated).toHaveLength(1);
		expect(first.width).toBe(512);
	});

	test("a failed load rejects", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow(/Failed to load sticker/);
	});

	test("an image that never answers is given up on, with a timeout error", async () => {
		const { bad, badUrl } = freshIds();
		hangingUrls.add(badUrl);
		await expect(loadStickerSource({ stickerId: bad, timeoutMs: 30 })).rejects.toThrow(/Timed out/);
		// ...and counted as a failure like any other.
		await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow(/Timed out/);
		expect(imagesCreated).toHaveLength(1);
	});

	test("a failure does not stick: after the retry delay the sticker loads again", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow();

		failingUrls.delete(badUrl); // the transient problem is gone
		clock += STICKER_RETRY_AFTER_MS + 1;
		const source = await loadStickerSource({ stickerId: bad });
		expect(source.width).toBe(512);
		expect(imagesCreated).toHaveLength(2);

		// And the success is cached from then on.
		await loadStickerSource({ stickerId: bad });
		expect(imagesCreated).toHaveLength(2);
	});

	test("a sticker that keeps failing is not re-requested on every frame", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow();

		for (let frame = 0; frame < 120; frame++) {
			clock += 16; // ~2 s of 60 fps playback, well inside the delay
			await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow();
		}
		expect(imagesCreated).toHaveLength(1);

		clock += STICKER_RETRY_AFTER_MS; // one retry per delay, not per frame
		await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow();
		expect(imagesCreated).toHaveLength(2);
	});

	test("retry 'never' (export) rejects with the stored failure however much time passes", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow();
		failingUrls.delete(badUrl);

		clock += STICKER_RETRY_AFTER_MS * 10;
		await expect(loadStickerSource({ stickerId: bad, retry: "never" })).rejects.toThrow(/Failed to load sticker/);
		expect(imagesCreated).toHaveLength(1);
	});

	test("retry 'now' (the export preflight) tries again at once, and a success clears the failure", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		await expect(loadStickerSource({ stickerId: bad })).rejects.toThrow();

		clock += 10; // far inside the delay
		await expect(loadStickerSource({ stickerId: bad, retry: "now" })).rejects.toThrow();
		expect(imagesCreated).toHaveLength(2);

		failingUrls.delete(badUrl);
		const source = await loadStickerSource({ stickerId: bad, retry: "now" });
		expect(source.width).toBe(512);
		// No failure is left behind: the default mode now simply returns the cached image.
		await loadStickerSource({ stickerId: bad, retry: "never" });
		expect(imagesCreated).toHaveLength(3);
	});

	test("one failing sticker does not affect another", async () => {
		const ids = freshIds();
		failingUrls.add(ids.badUrl);
		await expect(loadStickerSource({ stickerId: ids.bad })).rejects.toThrow();
		await expect(loadStickerSource({ stickerId: ids.good })).resolves.toMatchObject({ width: 512 });
	});
});

describe("loadStickerSourceOrNull (a preview frame)", () => {
	test("returns the source when it loads", async () => {
		const { good } = freshIds();
		await expect(loadStickerSourceOrNull({ stickerId: good })).resolves.toMatchObject({ width: 512 });
	});

	test("returns null for a failure and warns once per sticker", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		for (let frame = 0; frame < 5; frame++) {
			clock += 16;
			expect(await loadStickerSourceOrNull({ stickerId: bad })).toBeNull();
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(bad);
		expect(imagesCreated).toHaveLength(1);
		warn.mockRestore();
	});

	test("after the delay the retry runs in the background: the frame gets null at once, never waits", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		expect(await loadStickerSourceOrNull({ stickerId: bad })).toBeNull();

		hangingUrls.add(badUrl); // the retry will not answer until its (short, test-only) timeout
		failingUrls.delete(badUrl);
		clock += STICKER_RETRY_AFTER_MS + 1;

		const started = performance.now();
		expect(await loadStickerSourceOrNull({ stickerId: bad, timeoutMs: 120 })).toBeNull();
		expect(performance.now() - started).toBeLessThan(100); // it did not wait for the retry
		expect(imagesCreated).toHaveLength(2); // the retry did start

		// Frames while it is in flight neither wait for it nor start another.
		for (let frame = 0; frame < 10; frame++) {
			clock += 16;
			expect(await loadStickerSourceOrNull({ stickerId: bad, timeoutMs: 120 })).toBeNull();
		}
		expect(imagesCreated).toHaveLength(2);

		// Let the retry time out here, so no timer outlives the test.
		await new Promise((done) => setTimeout(done, 200));
		warn.mockRestore();
	});

	test("once the background retry succeeds, the next frame has the sticker", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		expect(await loadStickerSourceOrNull({ stickerId: bad })).toBeNull();

		failingUrls.delete(badUrl);
		clock += STICKER_RETRY_AFTER_MS + 1;
		expect(await loadStickerSourceOrNull({ stickerId: bad })).toBeNull(); // starts the retry
		await settle();
		expect(await loadStickerSourceOrNull({ stickerId: bad })).toMatchObject({ width: 512 });
		expect(imagesCreated).toHaveLength(2);
		warn.mockRestore();
	});

	test("a background retry that fails starts a new delay, not a request storm", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		expect(await loadStickerSourceOrNull({ stickerId: bad })).toBeNull();

		clock += STICKER_RETRY_AFTER_MS + 1;
		expect(await loadStickerSourceOrNull({ stickerId: bad })).toBeNull(); // retry #1 starts
		await settle(); // ...and fails
		for (let frame = 0; frame < 60; frame++) {
			clock += 16;
			expect(await loadStickerSourceOrNull({ stickerId: bad })).toBeNull();
		}
		await settle();
		expect(imagesCreated).toHaveLength(2);
		warn.mockRestore();
	});
});

function stickerNode({ stickerId }: { stickerId: string }) {
	return new StickerNode({
		stickerId,
		intrinsicWidth: 512,
		intrinsicHeight: 512,
		duration: 4000,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: IDENTITY,
		opacity: 1,
	});
}

function graphicNode() {
	return new GraphicNode({
		definitionId: "rectangle",
		params: {},
		duration: 4000,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: IDENTITY,
		opacity: 1,
	});
}

function renderer({ strictSources = false }: { strictSources?: boolean } = {}): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), {
		width: 1920,
		height: 1080,
		strictSources,
	});
}

describe("resolveRenderTree in preview with a sticker that cannot load", () => {
	test("resolves the frame; the bad sticker is skipped and the others still resolve", async () => {
		const { bad, badUrl, good } = freshIds();
		failingUrls.add(badUrl);
		const warn = spyOn(console, "warn").mockImplementation(() => {});

		const badSticker = stickerNode({ stickerId: bad });
		const goodSticker = stickerNode({ stickerId: good });
		const shape = graphicNode();
		const root = new RootNode().add(badSticker).add(goodSticker).add(shape);

		await resolveRenderTree({ node: root, renderer: renderer(), time: 0 });

		expect(badSticker.resolved).toBeNull();
		expect(goodSticker.resolved).not.toBeNull();
		expect(shape.resolved).not.toBeNull();
		warn.mockRestore();
	});

	test("an invalid id (emoji:zzz) resolves the frame too", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		failingUrls.add("/emoji/fluent-flat/unknown.svg");
		const sticker = stickerNode({ stickerId: "emoji:zzz" });
		const shape = graphicNode();
		await resolveRenderTree({
			node: new RootNode().add(sticker).add(shape),
			renderer: renderer(),
			time: 0,
		});
		expect(sticker.resolved).toBeNull();
		expect(shape.resolved).not.toBeNull();
		warn.mockRestore();
	});

	test("warns once per sticker id, not once per frame", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		const warn = spyOn(console, "warn").mockImplementation(() => {});

		for (let frame = 0; frame < 5; frame++) {
			clock += 16;
			await resolveRenderTree({
				node: new RootNode().add(stickerNode({ stickerId: bad })),
				renderer: renderer(),
				time: 0,
			});
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(bad);
		warn.mockRestore();
	});

	test("a sticker that was fixed comes back on a later frame", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		const warn = spyOn(console, "warn").mockImplementation(() => {});

		const first = stickerNode({ stickerId: bad });
		await resolveRenderTree({ node: new RootNode().add(first), renderer: renderer(), time: 0 });
		expect(first.resolved).toBeNull();

		failingUrls.delete(badUrl);
		clock += STICKER_RETRY_AFTER_MS + 1;
		const retrying = stickerNode({ stickerId: bad });
		await resolveRenderTree({ node: new RootNode().add(retrying), renderer: renderer(), time: 0 });
		expect(retrying.resolved).toBeNull(); // this frame did not wait for the retry
		await settle();

		const later = stickerNode({ stickerId: bad });
		await resolveRenderTree({ node: new RootNode().add(later), renderer: renderer(), time: 0 });
		expect(later.resolved).not.toBeNull();
		warn.mockRestore();
	});
});

describe("resolveRenderTree in export (strictSources)", () => {
	test("a sticker that cannot load stops the render with a readable error instead of being skipped", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		const sticker = stickerNode({ stickerId: bad });
		await expect(
			resolveRenderTree({
				node: new RootNode().add(sticker),
				renderer: renderer({ strictSources: true }),
				time: 0,
			}),
		).rejects.toThrow(`Sticker "${bad}" could not be loaded. Remove it or re-add it.`);
		expect(sticker.resolved).toBeNull();
	});

	test("it never retries on a timer: still the same error long after the delay, and no new request", async () => {
		const { bad, badUrl } = freshIds();
		failingUrls.add(badUrl);
		const run = () =>
			resolveRenderTree({
				node: new RootNode().add(stickerNode({ stickerId: bad })),
				renderer: renderer({ strictSources: true }),
				time: 0,
			});
		await expect(run()).rejects.toThrow(/could not be loaded/);
		failingUrls.delete(badUrl);
		clock += STICKER_RETRY_AFTER_MS * 20;
		await expect(run()).rejects.toThrow(/could not be loaded/);
		expect(imagesCreated).toHaveLength(1);
	});

	test("a sticker that loads resolves exactly as in preview", async () => {
		const { good } = freshIds();
		const sticker = stickerNode({ stickerId: good });
		await resolveRenderTree({
			node: new RootNode().add(sticker),
			renderer: renderer({ strictSources: true }),
			time: 0,
		});
		expect(sticker.resolved).not.toBeNull();
		expect(sticker.resolved?.sourceWidth).toBe(512);
	});
});

/** A node whose id is not a string: the data of a damaged project, which the types do not model. */
function damagedStickerNode({ stickerId }: { stickerId: unknown }) {
	const node = stickerNode({ stickerId: "emoji:placeholder" });
	Object.assign(node.params, { stickerId });
	return node;
}

describe("a stickerId that is not a string (a damaged project)", () => {
	const BAD_IDS: [string, unknown][] = [
		["number", 123],
		["null", null],
		["undefined", undefined],
		["object", {}],
		["array", []],
		["boolean", true],
	];

	for (const [kind, stickerId] of BAD_IDS) {
		test(`${kind}: preview skips the sticker and still draws the frame`, async () => {
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			const sticker = damagedStickerNode({ stickerId });
			const shape = graphicNode();
			await resolveRenderTree({ node: new RootNode().add(sticker).add(shape), renderer: renderer(), time: 0 });
			expect(sticker.resolved).toBeNull();
			expect(shape.resolved).not.toBeNull();
			warn.mockRestore();
		});

		test(`${kind}: export stops with a readable error`, async () => {
			const sticker = damagedStickerNode({ stickerId });
			await expect(
				resolveRenderTree({ node: new RootNode().add(sticker), renderer: renderer({ strictSources: true }), time: 0 }),
			).rejects.toThrow(/could not be loaded/);
		});
	}
});

describe("messages stay short for a huge sticker id", () => {
	// Uppercase: not a valid icon name, so it resolves to the missing placeholder and fails to load.
	const HUGE = "X".repeat(10_000);

	test("a failed load names the sticker in at most a few dozen characters", async () => {
		const stickerId = `icons:${HUGE}`;
		failingUrls.add(`/icons/phosphor/unknown.svg`);
		const error = await loadStickerSource({ stickerId }).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error && error.message.length).toBeLessThan(300);
	});

	test("so is the message of a load that timed out", async () => {
		const stickerId = `icons:${HUGE}-timeout`;
		hangingUrls.add(`/icons/phosphor/unknown.svg`);
		const error = await loadStickerSource({ stickerId, timeoutMs: 20 }).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error && error.message).toMatch(/Timed out/);
		expect(error instanceof Error && error.message.length).toBeLessThan(300);
	});

	test("the preview warning and the export error are short too", async () => {
		const stickerId = `icons:${HUGE}-2`;
		failingUrls.add(`/icons/phosphor/unknown.svg`);
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		await loadStickerSourceOrNull({ stickerId });
		for (const call of warn.mock.calls) for (const argument of call) expect(String(argument).length).toBeLessThan(500);
		warn.mockRestore();

		const message = await resolveRenderTree({
			node: new RootNode().add(stickerNode({ stickerId: `icons:${HUGE}-3` })),
			renderer: renderer({ strictSources: true }),
			time: 0,
		}).catch((reason: unknown) => (reason instanceof Error ? reason.message : String(reason)));
		expect(String(message).length).toBeLessThan(300);
	});
});
