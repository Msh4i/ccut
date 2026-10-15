import { describe, expect, test } from "bun:test";
import { STICKER_LOAD_TIMEOUT_MS, loadImage } from "../image-load";

type Behaviour = "load" | "error" | "hang";

class FakeImage {
	onload: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	srcValue = "";
	constructor(readonly behaviour: Behaviour) {}
	set src(url: string) {
		this.srcValue = url;
		if (url === "") return;
		queueMicrotask(() => {
			if (this.behaviour === "load") this.onload?.(new Event("load"));
			if (this.behaviour === "error") this.onerror?.(new Event("error"));
		});
	}
	get src() {
		return this.srcValue;
	}
}

function image(behaviour: Behaviour) {
	const fake = new FakeImage(behaviour);
	return { fake, createImage: () => fake };
}

describe("loadImage", () => {
	test("resolves with the loaded image and leaves no handlers on it", async () => {
		const { fake, createImage } = image("load");
		const loaded = await loadImage({ url: "/a.svg", createImage });
		expect(loaded).toBe(fake);
		expect(fake.srcValue).toBe("/a.svg");
		expect(fake.onload).toBeNull();
		expect(fake.onerror).toBeNull();
	});

	test("rejects when the image cannot be loaded", async () => {
		const { fake, createImage } = image("error");
		await expect(loadImage({ url: "/missing.svg", createImage })).rejects.toThrow(/Failed to load image/);
		expect(fake.onload).toBeNull();
		expect(fake.onerror).toBeNull();
	});

	test("gives up on an image that never answers, and stops its request", async () => {
		const { fake, createImage } = image("hang");
		const started = Date.now();
		await expect(loadImage({ url: "/slow.svg", createImage, timeoutMs: 40 })).rejects.toThrow(/Timed out/);
		expect(Date.now() - started).toBeLessThan(1500);
		expect(fake.onload).toBeNull();
		expect(fake.onerror).toBeNull();
		expect(fake.srcValue).toBe("");
	});

	test("a late load event after the timeout does nothing", async () => {
		const { fake, createImage } = image("hang");
		const pending = loadImage({ url: "/slow.svg", createImage, timeoutMs: 20 });
		const onload = fake.onload;
		await expect(pending).rejects.toThrow();
		expect(() => onload?.(new Event("load"))).not.toThrow();
	});

	test("does not start the timer to fire after a successful load", async () => {
		const { createImage } = image("load");
		await loadImage({ url: "/a.svg", createImage, timeoutMs: 20 });
		await new Promise((done) => setTimeout(done, 60)); // would be an unhandled rejection if the timer survived
	});

	test("the default timeout is 10 seconds", () => {
		expect(STICKER_LOAD_TIMEOUT_MS).toBe(10_000);
	});
});
