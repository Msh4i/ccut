// The experimental playback levers of the app (apps/web/src/services/playback-levers) as the
// harness sets and reads them: --levers parsing, the stored value written into the TEMPORARY
// profile's localStorage, and the HUD's levers line. Pure.

/** localStorage key of the app's levers store (apps/web/src/services/playback-levers/store.ts). */
const LEVERS_STORAGE_KEY = "ccut-playback-levers";
const LEVERS_STORE_VERSION = 1;

/** --levers names -> the app's lever keys. */
const LEVER_NAMES = { worker: "decodeWorker", bitmap: "bitmapUpload", display: "displayResolution" };
const ALL_OFF = Object.freeze({ decodeWorker: false, bitmapUpload: false, displayResolution: false });

/**
 * "off" or "worker=on,bitmap=off,display=on" (any subset, each name once) -> the three levers;
 * a lever not named is off. Returns null for anything else (the caller reports a usage error).
 */
function parseLeversArg(text) {
	if (typeof text !== "string") return null;
	if (text === "off") return { ...ALL_OFF };
	const levers = { ...ALL_OFF };
	const seen = new Set();
	for (const part of text.split(",")) {
		const match = /^(worker|bitmap|display)=(on|off)$/.exec(part.trim());
		if (!match || seen.has(match[1])) return null;
		seen.add(match[1]);
		levers[LEVER_NAMES[match[1]]] = match[2] === "on";
	}
	return levers;
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The stored levers value (zustand persist JSON, or null when nothing is stored) with `levers`
 * set; every other stored field is kept, an unreadable value is replaced.
 */
function persistedWithLevers({ stored, levers }) {
	let parsed = null;
	try {
		parsed = typeof stored === "string" ? JSON.parse(stored) : null;
	} catch {
		parsed = null;
	}
	const state = isRecord(parsed) && isRecord(parsed.state) ? parsed.state : {};
	const clean = Object.fromEntries(Object.keys(ALL_OFF).map((key) => [key, isRecord(levers) && levers[key] === true]));
	return JSON.stringify({ state: { ...state, levers: clean }, version: LEVERS_STORE_VERSION });
}

/** The "levers: ..." line of a HUD dump (recorder.ts), or null. */
function leversLineOf(hudText) {
	if (typeof hudText !== "string") return null;
	return hudText.split("\n").find((line) => line.startsWith("levers: ")) ?? null;
}

const sameLevers = ({ a, b }) => Object.keys(ALL_OFF).every((key) => isRecord(a) && isRecord(b) && a[key] === b[key]);

/** --compare: a note when both runs set the same levers (a lever comparison then compares nothing). */
function leversCompareNote({ before, after }) {
	const a = before?.options?.levers;
	const b = after?.options?.levers;
	return sameLevers({ a, b }) ? "both runs set the same --levers: they do not compare a lever" : null;
}

module.exports = { LEVERS_STORAGE_KEY, leversCompareNote, leversLineOf, parseLeversArg, persistedWithLevers };
