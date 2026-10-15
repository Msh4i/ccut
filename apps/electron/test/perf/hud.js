// Reads the text of the playback HUD's __playbackHudDump() (apps/web/src/diagnostics/playback-hud,
// formatSummary/formatRow) back into numbers. A column the HUD prints as "-" is null; a column
// this parser does not know (a later HUD) lands in `extra` when it is "<name> <number>".

const HEADER = /^Ccut playback HUD: ([\d.]+) s since play, (\d+) frames \((\d+) not stored\)/;
const SPAN = /^\s*(\d+)-(\d+) s$/;

const num = (text) => {
	if (text === undefined || text === "-") return null;
	const value = Number(text);
	return Number.isFinite(value) ? value : null;
};

const COLUMNS = [
	{ pattern: /^([\d.]+) fps$/, fields: ["fps"] },
	{ pattern: /^int (\S+)\/(\S+)\/(\S+) ms$/, fields: ["intervalP50Ms", "intervalP95Ms", "intervalMaxMs"] },
	{ pattern: /^draw (\S+)\/(\S+)\/(\S+) ms$/, fields: ["drawP50Ms", "drawP95Ms", "drawMaxMs"] },
	{ pattern: /^decode wait (\S+)\/(\S+) ms$/, fields: ["decodeWaitMs", "decodeWaitMaxMs"] },
	{ pattern: /^restarts (\d+)$/, fields: ["restarts"] },
	{ pattern: /^waits (\d+)$/, fields: ["waits"] },
	{ pattern: /^stale (\d+)$/, fields: ["stale"] },
	{ pattern: /^skipped (\d+)$/, fields: ["skipped"] },
	{ pattern: /^uploads (\d+) \((\S+) MP\)$/, fields: ["uploads", "uploadedMegapixels"] },
	{ pattern: /^long tasks (\d+)\/(\S+) ms$/, fields: ["longTasks", "longTaskMs"] },
	{ pattern: /^heap (\S+) MB$/, fields: ["heapMB"] },
];
const ALL_FIELDS = COLUMNS.flatMap((column) => column.fields);

/** One formatRow() line -> { fromS, toS, fps, ..., extra } or null when it is not a row. */
function parseHudRow(line) {
	const segments = line.split(" | ").map((segment) => segment.trim());
	const span = SPAN.exec(segments[0] ?? "");
	if (!span) return null;
	const row = { fromS: Number(span[1]), toS: Number(span[2]) };
	for (const field of ALL_FIELDS) row[field] = null;
	row.extra = {};
	for (const segment of segments.slice(1)) {
		const column = COLUMNS.find((candidate) => candidate.pattern.test(segment));
		if (column) {
			const match = column.pattern.exec(segment);
			column.fields.forEach((field, index) => (row[field] = num(match[index + 1])));
			continue;
		}
		const other = /^([a-z][a-z ]*) (-?[\d.]+)$/.exec(segment);
		if (other) row.extra[other[1].replaceAll(" ", "_")] = num(other[2]);
	}
	return row;
}

/** The whole dump -> { elapsedS, frames, notStored, rows5s, rows1s }, or null when it is no HUD table. */
function parseHudDump(text) {
	if (typeof text !== "string") return null;
	const lines = text.split("\n");
	const header = HEADER.exec(lines[0] ?? "");
	if (!header) return null;
	const out = { elapsedS: Number(header[1]), frames: Number(header[2]), notStored: Number(header[3]), rows5s: [], rows1s: [] };
	let section = null;
	for (const line of lines.slice(1)) {
		if (line.startsWith("per 5 s since play:")) section = out.rows5s;
		else if (line.startsWith("per second:")) section = out.rows1s;
		else if (section) {
			const row = parseHudRow(line);
			if (row) section.push(row);
		}
	}
	return out;
}

/**
 * Totals over the HUD rows (5 s rows of one playback) and per-second rates over `elapsedS`.
 * minFps: the lowest fps of a COMPLETE row (one that ends before `elapsedS`).
 */
function summarizeHudRows({ rows, elapsedS }) {
	const sum = (field) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
	const complete = rows.filter((row) => row.toS <= elapsedS + 1e-6 && row.fps !== null);
	return {
		restarts: sum("restarts"),
		restartsPerSecond: elapsedS > 0 ? sum("restarts") / elapsedS : null,
		waits: sum("waits"),
		stale: sum("stale"),
		skipped: sum("skipped"),
		decodeWaitMs: sum("decodeWaitMs"),
		uploads: sum("uploads"),
		longTasks: sum("longTasks"),
		longTaskMs: sum("longTaskMs"),
		minFps: complete.length > 0 ? Math.min(...complete.map((row) => row.fps)) : null,
	};
}

module.exports = { parseHudDump, parseHudRow, summarizeHudRows };
