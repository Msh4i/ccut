const { describe, expect, test } = require("bun:test");
const { HW_DECODE_ENV, HW_DECODE_FEATURES, applyHwDecodeSwitch, computeHwDecodeSwitch } = require("../perf-switches");

// The opt-in hardware decode switch (playback-proposals.md 1.4): off unless CCUT_HW_DECODE is
// "1" or "zerocopy", Linux only, merged into ONE --enable-features value.

const BASE = ["AcceleratedVideoDecoder", "AcceleratedVideoDecodeLinuxGL"];
const ZERO_COPY = "AcceleratedVideoDecodeLinuxZeroCopyGL";

const compute = ({ value, platform = "linux", existingEnable = "", existingDisable = "" } = {}) =>
	computeHwDecodeSwitch({
		env: value === undefined ? {} : { [HW_DECODE_ENV]: value },
		platform,
		existingEnable,
		existingDisable,
	});

function fakeApp({ enable = "", disable = "" } = {}) {
	const appended = [];
	const app = {
		commandLine: {
			getSwitchValue: (name) => (name === "enable-features" ? enable : name === "disable-features" ? disable : ""),
			appendSwitch: (name, value) => appended.push([name, value]),
		},
	};
	return { app, appended };
}

describe("computeHwDecodeSwitch", () => {
	test("unset or empty: nothing is switched and nothing is logged (OFF by default)", () => {
		expect(compute({})).toEqual({ enableFeatures: null, added: [], message: null });
		expect(compute({ value: "" })).toEqual({ enableFeatures: null, added: [], message: null });
	});

	test('"1": the two decode features, on Linux only', () => {
		const result = compute({ value: "1" });
		expect(result.enableFeatures).toBe(BASE.join(","));
		expect(result.added).toEqual(BASE);
		expect(result.message).toContain(`${HW_DECODE_ENV}=1`);
		expect(result.message).toContain(BASE.join(","));
	});

	test('"zerocopy": the two decode features plus the zero-copy one', () => {
		const result = compute({ value: "zerocopy" });
		expect(result.enableFeatures).toBe([...BASE, ZERO_COPY].join(","));
		expect(result.added).toEqual([...BASE, ZERO_COPY]);
	});

	test("unknown values are refused: logged, nothing switched (no prefix, case or whitespace guessing)", () => {
		for (const value of ["0", "true", "yes", "ZeroCopy", " 1", "1 ", "zerocopy,1", "toString", "__proto__", "constructor", "AcceleratedVideoDecodeLinuxZeroCopyGL"]) {
			const result = compute({ value });
			expect(result.enableFeatures).toBeNull();
			expect(result.added).toEqual([]);
			expect(result.message).toContain("ignored");
		}
	});

	test("an unknown value is echoed escaped and cut short in the log line", () => {
		const result = compute({ value: `evil\n[ccut] fake line ${"x".repeat(500)}` });
		expect(result.message).not.toContain("\n");
		expect(result.message.length).toBeLessThan(200);
	});

	test("non-printable or non-ASCII characters of an unknown value are logged as '?' (no terminal escapes, no bidi tricks)", () => {
		const result = compute({ value: "1\u001b[31m‮éx" });
		expect(result.message).toContain('"1?[31m??x"');
		expect(/[^\x20-\x7e]/.test(result.message)).toBe(false);
	});

	test("not Linux: refused with a log line, nothing switched", () => {
		for (const platform of ["win32", "darwin", "freebsd"]) {
			const result = compute({ value: "1", platform });
			expect(result.enableFeatures).toBeNull();
			expect(result.message).toContain("Linux only");
		}
	});

	test("merged with features already enabled into one value, order kept, nothing duplicated", () => {
		const result = compute({ value: "zerocopy", existingEnable: "Vulkan,AcceleratedVideoDecoder,UseOzonePlatform" });
		expect(result.enableFeatures).toBe(["Vulkan", "AcceleratedVideoDecoder", "UseOzonePlatform", "AcceleratedVideoDecodeLinuxGL", ZERO_COPY].join(","));
		expect(result.added).toEqual(["AcceleratedVideoDecodeLinuxGL", ZERO_COPY]);
	});

	test("an existing entry with field-trial parameters counts as present; empty entries and spaces are dropped", () => {
		const result = compute({ value: "1", existingEnable: " ,AcceleratedVideoDecoder<Trial.Group:a/1, ,Foo:x/2," });
		expect(result.enableFeatures).toBe("AcceleratedVideoDecoder<Trial.Group:a/1,Foo:x/2,AcceleratedVideoDecodeLinuxGL");
		expect(result.added).toEqual(["AcceleratedVideoDecodeLinuxGL"]);
	});

	test("everything already enabled: no switch to append, the log says so", () => {
		const result = compute({ value: "1", existingEnable: BASE.join(",") });
		expect(result.enableFeatures).toBeNull();
		expect(result.added).toEqual([]);
		expect(result.message).toContain("already");
	});

	test("a feature the user disabled on the command line stays off", () => {
		const result = compute({ value: "zerocopy", existingDisable: `Foo,${ZERO_COPY}` });
		expect(result.added).toEqual(BASE);
		expect(result.enableFeatures).toBe(BASE.join(","));
		expect(result.message).toContain(`--disable-features: ${ZERO_COPY}`);
	});

	test("the allow-list is frozen", () => {
		expect(Object.isFrozen(HW_DECODE_FEATURES)).toBe(true);
		expect(Object.isFrozen(HW_DECODE_FEATURES["1"])).toBe(true);
		expect(Object.keys(HW_DECODE_FEATURES).sort()).toEqual(["1", "zerocopy"]);
	});
});

describe("applyHwDecodeSwitch", () => {
	test("appends ONE --enable-features switch carrying the merged value and logs once", () => {
		const { app, appended } = fakeApp({ enable: "Vulkan" });
		const logs = [];
		applyHwDecodeSwitch({ app, env: { [HW_DECODE_ENV]: "1" }, platform: "linux", log: (line) => logs.push(line) });
		expect(appended).toEqual([["enable-features", `Vulkan,${BASE.join(",")}`]]);
		expect(logs).toHaveLength(1);
	});

	test("unset: no switch and no log line", () => {
		const { app, appended } = fakeApp();
		const logs = [];
		applyHwDecodeSwitch({ app, env: {}, platform: "linux", log: (line) => logs.push(line) });
		expect(appended).toEqual([]);
		expect(logs).toEqual([]);
	});

	test("unknown value or another platform: logged, no switch", () => {
		for (const [value, platform] of [["2", "linux"], ["1", "win32"]]) {
			const { app, appended } = fakeApp();
			const logs = [];
			applyHwDecodeSwitch({ app, env: { [HW_DECODE_ENV]: value }, platform, log: (line) => logs.push(line) });
			expect(appended).toEqual([]);
			expect(logs).toHaveLength(1);
		}
	});

	test("the --disable-features value is read from the command line too", () => {
		const { app, appended } = fakeApp({ disable: "AcceleratedVideoDecoder" });
		applyHwDecodeSwitch({ app, env: { [HW_DECODE_ENV]: "1" }, platform: "linux", log: () => {} });
		expect(appended).toEqual([["enable-features", "AcceleratedVideoDecodeLinuxGL"]]);
	});
});

describe("wiring", () => {
	const fs = require("node:fs");
	const path = require("node:path");
	const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");

	test("main.js applies the switch once, at load time, before app.whenReady()", () => {
		const calls = [...main.matchAll(/applyHwDecodeSwitch\(\{/g)];
		expect(calls).toHaveLength(1);
		expect(calls[0].index).toBeLessThan(main.indexOf("await app.whenReady()"));
		// top level (no indentation): not inside a function that might run after "ready"
		expect(main).toMatch(/^applyHwDecodeSwitch\(\{ app, env: process\.env, platform: process\.platform, log: /m);
	});

	test("the packaged app ships the module", () => {
		const { build } = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
		expect(build.files).toContain("perf-switches.js");
	});
});
