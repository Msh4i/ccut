// "Import from link": ships mediabunny to the main process. The pair's mux worker
// (link-import-mux-worker.js) needs it, and electron-builder packs no node_modules for the main
// process ("!**/node_modules/**" in package.json). bundle.js calls this before packaging: the
// package's own CommonJS bundle, unmodified, is copied to vendor/mediabunny.cjs, and only if it
// is exactly the version apps/web pins (the editor already ships that version, MPL-2.0; see
// THIRD_PARTY_NOTICES.md). Not a new dependency: the same package, a second place it runs.
// The file's sha256 is pinned: it is the bundle inside the npm tarball mediabunny-1.41.0.tgz
// (whose sha512 equals the registry's dist.integrity), checked when the pin was set.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VENDOR_FILE = path.join("vendor", "mediabunny.cjs");
const MEDIABUNNY_CJS_SHA256 = "8fe8bf0510bd5e522cfe59fe9bceb6ba6d8534389e7cbdb049a6d13cc6a819e4";

/** Copies mediabunny's CJS bundle to <targetDir>/vendor/mediabunny.cjs; returns { version, file }. */
function vendorMediabunny({ webDir, targetDir, expectedSha256 = MEDIABUNNY_CJS_SHA256 }) {
	const wanted = JSON.parse(fs.readFileSync(path.join(webDir, "package.json"), "utf8")).dependencies?.mediabunny;
	// The package's "require" export IS its CJS bundle (dist/bundles/mediabunny.cjs). Its
	// package.json is not exported, so Node cannot resolve it by name: it is two levels up.
	const bundle = require.resolve("mediabunny", { paths: [webDir] });
	const packageDir = path.resolve(path.dirname(bundle), "..", "..");
	const { name, version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
	if (name !== "mediabunny" || path.relative(packageDir, bundle) !== path.join("dist", "bundles", "mediabunny.cjs")) throw new Error("mediabunny: unexpected package layout");
	if (typeof wanted !== "string" || version !== wanted) throw new Error(`mediabunny ${version} is installed, apps/web pins ${wanted}: run bun install`);
	// Hash and copy the same bytes (read once): what is checked is what is shipped.
	const bytes = fs.readFileSync(bundle);
	const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== expectedSha256) throw new Error(`mediabunny's CJS bundle has sha256 ${sha256}, not the pinned ${expectedSha256}`);
	const file = path.join(targetDir, VENDOR_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
	return { version, file, sha256 };
}

module.exports = { MEDIABUNNY_CJS_SHA256, VENDOR_FILE, vendorMediabunny };
