import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Slice T6: the single-point tracker ("Track a point") was replaced by Stick to
// scene and removed. Nothing may bring its modules or UI back by import.
const SRC_ROOT = join(import.meta.dir, "..", "..");
const REMOVED =
	/motion-track-job|track-point|follow-track|TrackingHandles|run-motion-track|apply-motion-track|useMotionTrackStore|tracking\/ncc|tracking\/follow"|tracking\/panel-helpers|tracking\/scene-lookup|tracking-tab|tracking-handles/;
// The same modules by a relative path ("./ncc", "../scene-lookup"), which the alias patterns above do not see.
const REMOVED_RELATIVE =
	/["'](?:@\/tracking|\.{1,2})(?:\/[\w.-]+)*\/(?:ncc|follow|panel-helpers|scene-lookup)(?:\.tsx?)?["']/;
const THIS_FILE = "tracking/__tests__/no-old-tracker.test.ts";

function refersToRemovedTracker({ source }: { source: string }): boolean {
	return REMOVED.test(source) || REMOVED_RELATIVE.test(source);
}

function listSourceFiles({ dir }: { dir: string }): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "node_modules" ? [] : listSourceFiles({ dir: path });
		}
		return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
	});
}

describe("the removed single-point tracker", () => {
	test("no source file refers to its modules, store or components", () => {
		const offenders = listSourceFiles({ dir: SRC_ROOT })
			.map((path) => path.slice(SRC_ROOT.length + 1))
			.filter((name) => name !== THIS_FILE)
			.filter((name) => refersToRemovedTracker({ source: readFileSync(join(SRC_ROOT, name), "utf8") }));
		expect(offenders).toEqual([]);
	});

	test("the scan can see source files (a wrong root would pass vacuously)", () => {
		const files = listSourceFiles({ dir: SRC_ROOT }).map((path) => path.slice(SRC_ROOT.length + 1));
		expect(files).toContain("tracking/host.ts");
		expect(files).toContain("tracking/camera/controller.ts");
	});

	test("the pattern catches every way of importing a removed module (alias, relative, sideways, dynamic)", () => {
		const imports = [
			'import { x } from "@/tracking/ncc";',
			'import { x } from "@/tracking/follow";',
			'import { x } from "@/tracking/panel-helpers";',
			'import { x } from "@/tracking/scene-lookup";',
			'import { x } from "./ncc";',
			'import { x } from "./follow";',
			'import { x } from "./panel-helpers";',
			'import { x } from "../scene-lookup";',
			'import { x } from "../../tracking/ncc";',
			"import { x } from './follow';",
			'import { x } from "./ncc.ts";',
			'const mod = await import("./panel-helpers");',
			'export * from "../scene-lookup";',
		];
		for (const source of imports) {
			expect(refersToRemovedTracker({ source }), source).toBe(true);
		}
	});

	test("and leaves modules that only look similar alone", () => {
		const fine = [
			'import { x } from "@/tracking/host";',
			'import { x } from "./follow-up";',
			'import { x } from "./nccx";',
			'import { x } from "../camera/pin-element";',
			'import { x } from "./scene-lookups";',
			'import { x } from "some-package/follow";',
		];
		for (const source of fine) {
			expect(refersToRemovedTracker({ source }), source).toBe(false);
		}
	});
});
