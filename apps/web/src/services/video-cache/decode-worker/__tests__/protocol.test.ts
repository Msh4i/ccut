import { describe, expect, test } from "bun:test";
import { parseFromWorker, parseToWorker } from "../protocol";

describe("parseToWorker", () => {
	const file = new Blob(["x"]);

	test("accepts every message of the protocol", () => {
		const valid = [
			{ type: "open", streamId: 1, file },
			{ type: "iterate", streamId: 1, iteratorId: 2, startTime: 0.5 },
			{ type: "pull", iteratorId: 2 },
			{ type: "render", requestId: 3, frameId: 4, scale: 0.5 },
			{ type: "close", frameId: 4 },
			{ type: "return", iteratorId: 2 },
			{ type: "dispose", streamId: 1 },
		];
		for (const message of valid) expect<unknown>(parseToWorker(message)).toEqual(message);
	});

	test("drops anything else", () => {
		const invalid: unknown[] = [
			null,
			undefined,
			"open",
			42,
			{},
			{ type: "unknown" },
			{ type: "open", streamId: 1 },
			{ type: "open", streamId: 1, file: "a string" },
			{ type: "open", streamId: -1, file },
			{ type: "open", streamId: 1.5, file },
			{ type: "iterate", streamId: 1, iteratorId: 2, startTime: Number.NaN },
			{ type: "iterate", streamId: 1, iteratorId: 2, startTime: "0" },
			{ type: "pull" },
			{ type: "pull", iteratorId: "2" },
			{ type: "render", requestId: 1, frameId: 2, scale: 0 },
			{ type: "render", requestId: 1, frameId: 2, scale: Number.NaN },
			{ type: "render", requestId: 1, frameId: 2, scale: Number.POSITIVE_INFINITY },
			{ type: "render", requestId: 1, scale: 1 },
			{ type: "close", frameId: Number.MAX_SAFE_INTEGER + 2 },
			{ type: "return", iteratorId: null },
			{ type: "dispose", streamId: [] },
		];
		for (const value of invalid) expect(parseToWorker(value)).toBeNull();
	});
});

describe("parseFromWorker", () => {
	const opened = {
		type: "opened",
		streamId: 1,
		displaySize: { width: 1920, height: 1080 },
		frameBytes: { decoded: 10, drawn: 20 },
		rotation: 90,
	};

	test("accepts every message of the protocol", () => {
		const bitmap = { width: 480, height: 270 };
		const frame = { displayWidth: 1920 };
		const valid = [
			opened,
			{ type: "frame", iteratorId: 1, frameId: 2, timestamp: 0, duration: 1 / 30 },
			{ type: "done", iteratorId: 1 },
			{ type: "rendered", requestId: 1, image: { kind: "bitmap", bitmap } },
			{ type: "rendered", requestId: 1, image: { kind: "frame", frame } },
			{ type: "error", target: "pull", id: 1, message: "boom" },
			{ type: "disposed", streamId: 1 },
		];
		for (const message of valid) expect<unknown>(parseFromWorker(message)).toEqual(message);
	});

	test("keeps the picture object itself (it has to be closed later)", () => {
		const bitmap = { width: 4, height: 4 };
		const parsed = parseFromWorker({ type: "rendered", requestId: 1, image: { kind: "bitmap", bitmap } });
		expect(parsed?.type === "rendered" && parsed.image.kind === "bitmap" && parsed.image.bitmap).toBe(bitmap);
	});

	test("drops anything else", () => {
		const invalid: unknown[] = [
			null,
			7,
			{ type: "nope" },
			{ ...opened, rotation: 45 },
			{ ...opened, displaySize: { width: 0, height: 10 } },
			{ ...opened, frameBytes: { decoded: -1, drawn: 1 } },
			{ type: "frame", iteratorId: 1, frameId: 2, timestamp: Number.NaN, duration: 1 },
			{ type: "frame", iteratorId: 1, frameId: 2, timestamp: 0, duration: -1 },
			{ type: "frame", iteratorId: 1, timestamp: 0, duration: 1 },
			{ type: "done" },
			{ type: "rendered", requestId: 1, image: null },
			{ type: "rendered", requestId: 1, image: { kind: "bitmap" } },
			{ type: "rendered", requestId: 1, image: { kind: "bitmap", bitmap: { width: 0, height: 5 } } },
			{ type: "rendered", requestId: 1, image: { kind: "frame", frame: 3 } },
			{ type: "rendered", requestId: 1, image: { kind: "texture" } },
			{ type: "error", target: "elsewhere", id: 1, message: "x" },
			{ type: "error", target: "pull", id: 1, message: 5 },
			{ type: "disposed", streamId: -3 },
		];
		for (const value of invalid) expect(parseFromWorker(value)).toBeNull();
	});
});
