// Copies the onnxruntime-web wasm runtime into public/ort/ so the smart cutout worker loads it from
// the app itself (the standalone server and the desktop app protocol serve public/), never from a CDN.
// Runs before `next dev` and `next build` (package.json predev / prebuild).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { findOrtDist } from "./ort-dist.mjs";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = findOrtDist({ from: root });
const target = join(root, "public", "ort");
mkdirSync(target, { recursive: true });
for (const name of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) {
	cpSync(join(dist, name), join(target, name));
}
