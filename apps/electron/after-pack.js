// electron-builder extraResources `node_modules` klasörlerini sessizce atlıyor (Next sunucusu 'next' bulamıyor).
// Standalone çıktısını olduğu gibi kopyala.
const fs = require("node:fs");
const path = require("node:path");

/** Deletes every `.env*` file under `dir` (Next copies the owner's .env and .env.production into the standalone output). Returns the paths removed. */
function removeEnvFiles({ dir }) {
	const removed = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) removed.push(...removeEnvFiles({ dir: full }));
		else if (entry.name.startsWith(".env")) {
			fs.rmSync(full);
			removed.push(full);
		}
	}
	return removed;
}

exports.removeEnvFiles = removeEnvFiles;

exports.default = async (context) => {
	const from = path.join(__dirname, "../web/.next/standalone");
	if (!fs.existsSync(path.join(from, "apps/web/server.js"))) throw new Error('Run "node bundle.js" before packaging');
	const target = path.join(context.appOutDir, "resources/web");
	fs.cpSync(from, target, { recursive: true });
	// No secrets of the build machine in the package (security audit F5).
	for (const file of removeEnvFiles({ dir: target })) console.log(`after-pack: removed ${file}`);
	// MIT/OFL/Unicode lisansları kopyalarda bildirimin bulunmasını ister: yazı tipleri, sticker'lar, npm bağımlılıkları.
	fs.copyFileSync(path.join(__dirname, "../../THIRD_PARTY_NOTICES.md"), path.join(context.appOutDir, "resources/THIRD_PARTY_NOTICES.md"));
};
