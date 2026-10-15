import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The onnxruntime-web `dist` folder, found the way node resolution would: in `node_modules` of
 * `from` or of any parent folder (bun hoists the package to the repository root). The package's
 * `exports` do not allow `require.resolve("onnxruntime-web/package.json")`, so the folder is walked.
 */
export function findOrtDist({ from }) {
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", "onnxruntime-web", "dist");
		if (existsSync(join(candidate, "ort-wasm-simd-threaded.wasm"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) throw new Error("onnxruntime-web is not installed (run bun install)");
		dir = parent;
	}
}
