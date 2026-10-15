#!/usr/bin/env node
// Test clips for the two-clip playback harness (docs/ccut/playback-measure-2clips.md):
//   node script/make-perf-clips.js <outDir> [--seconds 20]
// Writes perf-a-1080p30.mp4 and perf-b-1080p30.mp4 (ffmpeg testsrc2 + sine, 1920x1080, 30 fps,
// H.264 High yuv420p, GOP 2 s, AAC, faststart), checks them with ffprobe and prints the facts as
// JSON. Exit 1 when a clip does not match its spec, 2 on a usage error. Needs ffmpeg and ffprobe
// on PATH. The settings live in apps/electron/test/perf/clips.js (the harness uses the same code).
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { generateClips, parseClipArgs } = require("../apps/electron/test/perf/clips");

function main() {
	let options;
	try {
		options = parseClipArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
	const result = generateClips({ dir: path.resolve(options.dir), seconds: options.seconds, spawnSync, fs, log: (line) => console.error(line) });
	console.log(JSON.stringify(result, null, 2));
	if (result.problems.length > 0) {
		console.error(`${result.problems.length} problem(s):\n${result.problems.join("\n")}`);
		process.exit(1);
	}
}

main();
