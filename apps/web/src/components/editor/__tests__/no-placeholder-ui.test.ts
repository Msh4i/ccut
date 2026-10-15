import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Owner rule: nothing is added to look rich. A feature either works or it is
// not in the product, so no "coming soon" tab, button or message may ship.
const SRC_ROOT = join(import.meta.dir, "..", "..", "..");
const PLACEHOLDER_MARKER = /coming soon|not available yet/i;

function listSourceFiles({ dir }: { dir: string }): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__tests__" || entry.name === "node_modules"
				? []
				: listSourceFiles({ dir: path });
		}
		return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
	});
}

describe("placeholder UI guard", () => {
	test("no source file ships a coming-soon placeholder", () => {
		const offenders = listSourceFiles({ dir: SRC_ROOT })
			.filter((path) => PLACEHOLDER_MARKER.test(readFileSync(path, "utf8")))
			.map((path) => path.slice(SRC_ROOT.length + 1));

		expect(offenders).toEqual([]);
	});
});
