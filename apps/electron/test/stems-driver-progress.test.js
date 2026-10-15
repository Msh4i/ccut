const { describe, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// The driver's progress arithmetic (a pure function, importable without torch or demucs) with fake
// demucs callbacks, run by `python3 -I`. SKIPPED (test.skip) when python3 is not installed here: the
// owner's machine has it, the check then runs for real.

const hasPython = spawnSync("python3", ["-I", "-c", "print(1)"], { encoding: "utf8" }).status === 0;
const maybe = hasPython ? test : test.skip;

describe("stems_demucs_driver.py progress", () => {
	maybe("progress follows the chunks (demucs 4.1.0 callback), never decreases, survives garbage", () => {
		const result = spawnSync("python3", ["-I", "-B", path.join(__dirname, "stems_driver_progress_check.py"), path.join(__dirname, "..", "stems_demucs_driver.py")], { encoding: "utf8" });
		expect(result.stderr).toBe("");
		expect(result.stdout.trim()).toBe("ok");
		expect(result.status).toBe(0);
	});
});
