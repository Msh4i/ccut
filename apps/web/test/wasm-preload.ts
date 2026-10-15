// bun, `import * as wasm from "./x.wasm"` (wasm-bindgen "bundler" çıktısı) ESM-wasm entegrasyonunu
// desteklemiyor: opencut-wasm yüklenirken `__wbindgen_start is not a function` fırlatıyor.
// Burada .wasm modülünü kendimiz örnekleyip dışa aktarımlarını nesne olarak veriyoruz.
// bunfig.toml içinden test çalıştırmalarında otomatik yüklenir.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

Bun.plugin({
	name: "opencut-wasm",
	setup(build) {
		build.onLoad({ filter: /opencut_wasm_bg\.wasm$/ }, async ({ path }) => {
			const bindings = (await import(
				pathToFileURL(path.replace(/\.wasm$/, ".js")).href
			)) as WebAssembly.ModuleImports;
			const { instance } = await WebAssembly.instantiate(readFileSync(path), {
				"./opencut_wasm_bg.js": bindings,
			});
			return { exports: { ...instance.exports }, loader: "object" };
		});
	},
});
