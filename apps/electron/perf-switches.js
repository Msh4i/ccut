// Opt-in hardware video decode switches (docs/ccut/playback-proposals.md 1.4). OFF by default:
// nothing changes unless the user starts Ccut with
//   CCUT_HW_DECODE=1         AcceleratedVideoDecoder, AcceleratedVideoDecodeLinuxGL
//   CCUT_HW_DECODE=zerocopy  the same plus AcceleratedVideoDecodeLinuxZeroCopyGL
// Linux only; any other value is logged and ignored. The value only picks one of two fixed
// feature lists (nothing of it reaches the command line), and the page can neither set nor read it.
// Allowed in the packaged app too: an environment variable of the user's own launch is no new
// surface (whoever sets it can already run anything as that user), and it lets the owner measure
// the build he really uses (docs/ccut/playback-measure-2clips.md).
const HW_DECODE_ENV = "CCUT_HW_DECODE";

const HW_DECODE_FEATURES = Object.freeze({
	1: Object.freeze(["AcceleratedVideoDecoder", "AcceleratedVideoDecodeLinuxGL"]),
	zerocopy: Object.freeze(["AcceleratedVideoDecoder", "AcceleratedVideoDecodeLinuxGL", "AcceleratedVideoDecodeLinuxZeroCopyGL"]),
});

const MAX_ECHO_CHARS = 40;

// "Name<Trial.Group:param/value" -> "Name"
const featureName = (entry) => entry.split(/[<:]/)[0].trim();

function splitFeatures(value) {
	if (typeof value !== "string" || value === "") return [];
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/**
 * Pure: the --enable-features value to append (null = append nothing), the features it adds and
 * the one log line (null = say nothing). `existingEnable` / `existingDisable` are the values the
 * command line already carries ("" when absent): a second --enable-features replaces the first,
 * so the result repeats them; a feature the user disabled explicitly stays off.
 */
function computeHwDecodeSwitch({ env, platform, existingEnable, existingDisable }) {
	const raw = env[HW_DECODE_ENV];
	if (raw === undefined || raw === "") return { enableFeatures: null, added: [], message: null };
	if (typeof raw !== "string" || !Object.hasOwn(HW_DECODE_FEATURES, raw)) {
		// printable ASCII only: no terminal escape sequences or bidi overrides reach the log
		const echo = JSON.stringify(String(raw).slice(0, MAX_ECHO_CHARS).replace(/[^\x20-\x7e]/g, "?"));
		return { enableFeatures: null, added: [], message: `[ccut] ${HW_DECODE_ENV}=${echo} ignored: use "1" or "zerocopy"` };
	}
	if (platform !== "linux") {
		return { enableFeatures: null, added: [], message: `[ccut] ${HW_DECODE_ENV} ignored: hardware decode switches are Linux only (${platform})` };
	}
	const existing = splitFeatures(existingEnable);
	const present = new Set(existing.map(featureName));
	const disabled = new Set(splitFeatures(existingDisable).map(featureName));
	const wanted = HW_DECODE_FEATURES[raw];
	const added = wanted.filter((feature) => !present.has(feature) && !disabled.has(feature));
	const blocked = wanted.filter((feature) => disabled.has(feature));
	const kept = blocked.length > 0 ? `; kept off by --disable-features: ${blocked.join(",")}` : "";
	const gained = added.length > 0 ? `--enable-features gains ${added.join(",")}` : "every feature is already enabled";
	return {
		enableFeatures: added.length > 0 ? [...existing, ...added].join(",") : null,
		added,
		message: `[ccut] hardware decode (${HW_DECODE_ENV}=${raw}): ${gained}${kept}`,
	};
}

/** Before app "ready": reads the command line, appends at most one switch, logs at most one line. */
function applyHwDecodeSwitch({ app, env, platform, log }) {
	const result = computeHwDecodeSwitch({
		env,
		platform,
		existingEnable: app.commandLine.getSwitchValue("enable-features"),
		existingDisable: app.commandLine.getSwitchValue("disable-features"),
	});
	if (result.enableFeatures !== null) app.commandLine.appendSwitch("enable-features", result.enableFeatures);
	if (result.message !== null) log(result.message);
	return result;
}

module.exports = { HW_DECODE_ENV, HW_DECODE_FEATURES, applyHwDecodeSwitch, computeHwDecodeSwitch };
