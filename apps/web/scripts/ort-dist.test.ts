import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOrtDist } from "./ort-dist.mjs";

test("finds the package in a parent node_modules (hoisted) and fails clearly when absent", () => {
	const root = mkdtempSync(join(tmpdir(), "ort-dist-"));
	const app = join(root, "apps", "web");
	mkdirSync(app, { recursive: true });
	expect(() => findOrtDist({ from: app })).toThrow("not installed");
	const dist = join(root, "node_modules", "onnxruntime-web", "dist");
	mkdirSync(dist, { recursive: true });
	writeFileSync(join(dist, "ort-wasm-simd-threaded.wasm"), "x");
	expect(findOrtDist({ from: app })).toBe(dist);
});
