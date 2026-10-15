// Command line of apps/electron/test/perf-two-clips.js and the guards that keep the harness off the
// owner's live profile. Pure.
const path = require("node:path");
const { parseLeversArg } = require("./levers");
const { SYNTHETIC_IDS } = require("./scenarios");

class UsageError extends Error {}

const LABEL = /^[A-Za-z0-9._-]{1,40}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const HW_DECODE = new Set(["off", "1", "zerocopy"]);
const NOT_COPIED = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]);
const USER_DATA_PREFIX = "ccut-perf-";

function usage() {
	return [
		"Two-clip playback measurement (docs/ccut/playback-measure-2clips.md). Runs the unpackaged app on a",
		"fresh temporary profile (or a COPY of --profile-copy), never on the live one.",
		"",
		"  node apps/electron/test/perf-two-clips.js [options]",
		"    --scenarios S1,S1b,S2,S3[,project]  default: the four synthetic ones (only 'project' with --project)",
		"    --seconds N          playback per scenario, 5..600 (default 30)",
		"    --idle-seconds N     paused time measured before Play, 0..30 (default 2)",
		"    --out DIR            result directory (default apps/electron/test/out/perf)",
		"    --label NAME         name in the result file, e.g. before / after (default run)",
		"    --clips DIR          use perf-a/perf-b-1080p30.mp4 from DIR instead of generating them",
		"    --profile-copy DIR   copy this user-data dir to a temporary one and run on the copy",
		"    --project ID         with --profile-copy: also measure this existing project",
		"    --hw-decode off|1|zerocopy   set CCUT_HW_DECODE for the app (default: leave the environment)",
		"    --levers off|worker=on,bitmap=on,display=on   set the experimental playback levers in the",
		"                         temporary profile (levers not named are off; default: leave what is stored)",
		"  node apps/electron/test/perf-two-clips.js --compare BEFORE.json AFTER.json",
		"",
		"Exit code 0 = measured (targets may be missed), 1 = harness failure, 2 = usage error.",
	].join("\n");
}

function integerIn({ value, min, max, name }) {
	if (value === undefined || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new UsageError(`${name} must be a whole number in ${min}..${max}`);
	return Number(value);
}

/** argv (without node and the script) -> { mode: "run" | "compare" | "help", ... }; throws UsageError. */
function parseArgs({ argv }) {
	if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
	if (argv[0] === "--compare") {
		if (argv.length !== 3) throw new UsageError("--compare takes exactly two result files and no other option");
		return { mode: "compare", before: argv[1], after: argv[2] };
	}
	const options = { mode: "run", scenarios: null, seconds: 30, idleSeconds: 2, outDir: null, label: "run", clipsDir: null, profileCopy: null, project: null, hwDecode: null, levers: null };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		const needValue = () => {
			if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
			i += 1;
			return value;
		};
		if (flag === "--scenarios") {
			const list = [...new Set(needValue().split(",").map((id) => id.trim()).filter(Boolean))];
			const unknown = list.filter((id) => !SYNTHETIC_IDS.includes(id) && id !== "project");
			if (list.length === 0 || unknown.length > 0) throw new UsageError(`--scenarios: unknown ${unknown.join(",") || "(empty)"}; use ${SYNTHETIC_IDS.join(",")},project`);
			options.scenarios = list;
		} else if (flag === "--seconds") options.seconds = integerIn({ value: needValue(), min: 5, max: 600, name: "--seconds" });
		else if (flag === "--idle-seconds") options.idleSeconds = integerIn({ value: needValue(), min: 0, max: 30, name: "--idle-seconds" });
		else if (flag === "--out") options.outDir = needValue();
		else if (flag === "--label") {
			const label = needValue();
			if (!LABEL.test(label) || label === "." || label === "..") throw new UsageError("--label: 1-40 of A-Z a-z 0-9 . _ -");
			options.label = label;
		} else if (flag === "--clips") options.clipsDir = needValue();
		else if (flag === "--profile-copy") options.profileCopy = needValue();
		else if (flag === "--project") {
			const id = needValue();
			if (!PROJECT_ID.test(id)) throw new UsageError("--project: a project id (A-Z a-z 0-9 _ -)");
			options.project = id;
		} else if (flag === "--hw-decode") {
			const mode = needValue();
			if (!HW_DECODE.has(mode)) throw new UsageError("--hw-decode: off, 1 or zerocopy");
			options.hwDecode = mode;
		} else if (flag === "--levers") {
			const levers = parseLeversArg(needValue());
			if (!levers) throw new UsageError("--levers: off, or a comma list of worker=on|off, bitmap=on|off, display=on|off (each once)");
			options.levers = levers;
		} else throw new UsageError(`unknown argument ${flag}`);
	}
	if (options.project && !options.profileCopy) throw new UsageError("--project needs --profile-copy (the harness never opens the live profile)");
	if (options.scenarios === null) options.scenarios = options.project ? ["project"] : [...SYNTHETIC_IDS];
	if (options.scenarios.includes("project") && !options.project) throw new UsageError("scenario 'project' needs --project ID and --profile-copy DIR");
	return options;
}

/** True only for a directory named ccut-perf-* directly inside the temp root (what the harness creates). */
function isSafeUserDataDir({ dir, tmpRoot }) {
	if (!path.isAbsolute(dir)) return false;
	const resolved = path.resolve(dir);
	return path.dirname(resolved) === path.resolve(tmpRoot) && path.basename(resolved).startsWith(USER_DATA_PREFIX);
}

/** Entries of a profile that are not copied: the single-instance lock of a running Ccut and the DevTools port file. */
const shouldCopyProfileEntry = (name) => !NOT_COPIED.has(name);

const resultFileName = ({ label, startedAt }) => `perf-${label}-${startedAt.replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}.json`;

module.exports = { USER_DATA_PREFIX, UsageError, isSafeUserDataDir, parseArgs, resultFileName, shouldCopyProfileEntry, usage };
