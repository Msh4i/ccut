import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import type { TimelineDragData } from "@/timeline/drag";
import { TimelineDragSource } from "@/timeline/drag-source";
import { ZERO_MEDIA_TIME } from "@/wasm";

// Dropping a sticker on the timeline checks that it loads, like adding it with
// the button: a broken sticker is reported and not inserted.

const { DragDropController } = await import("../drag-drop-controller");
type Config = ConstructorParameters<typeof DragDropController>[0]["configRef"]["current"];

class ActiveDragSource extends TimelineDragSource {
	constructor(private readonly data: TimelineDragData) {
		super();
	}
	override getActive() {
		return this.data;
	}
	override isActive() {
		return true;
	}
}

const TRACKS: SceneTracks = {
	overlay: [{ id: "graphics", name: "Graphics", type: "graphic", elements: [], hidden: false }],
	main: { id: "main", name: "Main", type: "video", elements: [], muted: false, hidden: false },
	audio: [],
};

const settle = () => new Promise((done) => setTimeout(done, 0));

const dropEvent = {
	preventDefault: () => {},
	clientX: 120,
	clientY: 8,
	dataTransfer: { types: [] as string[], files: [] as File[], dropEffect: "none" },
};

function setup({
	dragData,
	resolveStickerSize,
	reportDropError,
	initialTracks = TRACKS,
}: {
	initialTracks?: SceneTracks;
	dragData: TimelineDragData;
	resolveStickerSize?: Config["resolveStickerSize"];
	reportDropError?: Config["reportDropError"];
}) {
	const inserted: { placement: unknown; element: Record<string, unknown> }[] = [];
	const commands: unknown[] = [];
	let tracks = initialTracks;
	const config: Config = {
		zoomLevel: 1,
		getContainerEl: () => null,
		getHeaderEl: () => null,
		getTracksScrollEl: () => ({
			getBoundingClientRect: () => ({ left: 0, top: 0, height: 300 }),
			scrollLeft: 0,
			scrollTop: 0,
		}),
		getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
		getActiveProjectId: () => "project",
		getSceneTracks: () => tracks,
		getCurrentPlayheadTime: () => ZERO_MEDIA_TIME,
		getMediaAssets: () => [],
		dragSource: new ActiveDragSource(dragData),
		addMediaAsset: async () => null,
		executeCommand: (command) => void commands.push(command),
		insertElement: (args) => void inserted.push(args),
		addClipEffect: () => {},
		resolveStickerSize,
		reportDropError,
	};
	const controller = new DragDropController({ configRef: { current: config } });
	controller.onDragOver(dropEvent);
	return {
		controller,
		inserted,
		commands,
		/** The timeline changes while the sticker is still being measured. */
		changeTracks: (next: SceneTracks) => {
			tracks = next;
		},
	};
}

const stickerDrag: TimelineDragData = {
	id: "emoji:1f525",
	type: "sticker",
	name: "Fire",
	stickerId: "emoji:1f525",
};

describe("dropping a sticker", () => {
	test("inserts it with the size of its loaded image", async () => {
		const { controller, inserted, commands } = setup({
			dragData: stickerDrag,
			resolveStickerSize: async () => ({ width: 512, height: 384 }),
			reportDropError: () => {},
		});
		controller.onDrop(dropEvent);
		await settle();
		expect(commands).toHaveLength(0);
		expect(inserted).toHaveLength(1);
		expect(inserted[0].element).toMatchObject({
			type: "sticker",
			stickerId: "emoji:1f525",
			name: "Fire",
			intrinsicWidth: 512,
			intrinsicHeight: 384,
		});
	});

	test("a sticker that cannot be loaded is reported, and nothing is inserted", async () => {
		const reported: string[] = [];
		const { controller, inserted, commands } = setup({
			dragData: stickerDrag,
			resolveStickerSize: async () => {
				throw new Error('Sticker "emoji:1f525" could not be loaded');
			},
			reportDropError: ({ message }) => void reported.push(message),
		});
		const consoleError = mock(() => {});
		const original = console.error;
		console.error = consoleError;
		controller.onDrop(dropEvent);
		await settle();
		console.error = original;
		expect(inserted).toHaveLength(0);
		expect(commands).toHaveLength(0);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("Fire");
		expect(consoleError).toHaveBeenCalled();
	});

	test("the drop target is gone when it is handled: a second drop does nothing", async () => {
		const { controller, inserted } = setup({
			dragData: stickerDrag,
			resolveStickerSize: async () => ({ width: 64, height: 64 }),
			reportDropError: () => {},
		});
		controller.onDrop(dropEvent);
		controller.onDrop(dropEvent); // no new dragover in between: no target
		await settle();
		expect(inserted).toHaveLength(1);
	});
});

describe("the timeline can change while the sticker is being measured (up to 10 s)", () => {
	function deferredSize() {
		let resolve: (size: { width: number; height: number }) => void = () => {};
		const promise = new Promise<{ width: number; height: number }>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}

	test("a track that was removed in the meantime is reported, not silently dropped", async () => {
		const size = deferredSize();
		const reported: string[] = [];
		const { controller, inserted, commands, changeTracks } = setup({
			dragData: stickerDrag,
			resolveStickerSize: () => size.promise,
			reportDropError: ({ message }) => void reported.push(message),
		});
		controller.onDrop(dropEvent);
		changeTracks({ ...TRACKS, overlay: [] }); // the graphics track is gone
		size.resolve({ width: 64, height: 64 });
		await settle();
		expect(inserted).toHaveLength(0);
		expect(commands).toHaveLength(0);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("Fire");
		// The reason is the track, not a failed image (a TypeError caught further out would say that).
		expect(reported[0]).toContain("the track it was dropped on is gone");
	});

	test("a track that moved is still the one that gets the sticker (it is found by id, not by index)", async () => {
		const size = deferredSize();
		const { controller, inserted, changeTracks } = setup({
			dragData: stickerDrag,
			resolveStickerSize: () => size.promise,
			reportDropError: () => {},
		});
		controller.onDrop(dropEvent);
		changeTracks({
			...TRACKS,
			overlay: [{ id: "new-above", name: "New", type: "graphic", elements: [], hidden: false }, ...TRACKS.overlay],
		});
		size.resolve({ width: 64, height: 64 });
		await settle();
		expect(inserted).toHaveLength(1);
		expect(inserted[0].placement).toEqual({ mode: "explicit", trackId: "graphics" });
	});
});

describe("messages stay short", () => {
	test("a drop that fails names a huge sticker name in about a hundred characters", async () => {
		const reported: string[] = [];
		const { controller } = setup({
			dragData: { ...stickerDrag, name: "N".repeat(10_000) },
			resolveStickerSize: async () => {
				throw new Error("x");
			},
			reportDropError: ({ message }) => void reported.push(message),
		});
		const original = console.error;
		console.error = () => {};
		controller.onDrop(dropEvent);
		await settle();
		console.error = original;
		expect(reported).toHaveLength(1);
		expect(reported[0].length).toBeLessThan(200);
	});
});

describe("other drops are unchanged", () => {
	test("a text drop is inserted at once, without waiting", () => {
		const { controller, inserted, commands } = setup({
			dragData: { id: "text", type: "text", name: "Title", content: "Hello" },
		});
		controller.onDrop(dropEvent);
		expect(inserted.length + commands.length).toBe(1);
	});
});
