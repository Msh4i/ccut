import { describe, expect, test } from "bun:test";
import { orderLayersForDepth } from "../depth-sort";

type Entry = { name: string; depth: number | null };

function names(entries: Entry[]): string[] {
	return orderLayersForDepth(entries).map((entry) => entry.name);
}

describe("orderLayersForDepth", () => {
	test("2D layers keep their track order", () => {
		expect(
			names([
				{ name: "a", depth: null },
				{ name: "b", depth: null },
				{ name: "c", depth: null },
			]),
		).toEqual(["a", "b", "c"]);
	});

	test("a run of consecutive 3D layers is drawn back to front (far first)", () => {
		expect(
			names([
				{ name: "near", depth: 100 },
				{ name: "far", depth: 900 },
				{ name: "middle", depth: 400 },
			]),
		).toEqual(["far", "middle", "near"]);
	});

	test("a 2D layer splits runs: 3D layers never cross it", () => {
		expect(
			names([
				{ name: "video", depth: null },
				{ name: "near-1", depth: 10 },
				{ name: "far-1", depth: 50 },
				{ name: "title", depth: null },
				{ name: "near-2", depth: 20 },
				{ name: "far-2", depth: 5000 },
			]),
		).toEqual(["video", "far-1", "near-1", "title", "far-2", "near-2"]);
	});

	test("equal depths keep their track order (stable)", () => {
		expect(
			names([
				{ name: "first", depth: 300 },
				{ name: "second", depth: 300 },
				{ name: "third", depth: 300 },
			]),
		).toEqual(["first", "second", "third"]);
	});

	test("layers behind the camera (negative depth) sort like any depth", () => {
		expect(
			names([
				{ name: "behind", depth: -50 },
				{ name: "front", depth: 50 },
			]),
		).toEqual(["front", "behind"]);
	});

	test("does not change the input array", () => {
		const entries: Entry[] = [
			{ name: "near", depth: 1 },
			{ name: "far", depth: 2 },
		];
		orderLayersForDepth(entries);
		expect(entries.map((entry) => entry.name)).toEqual(["near", "far"]);
	});
});
