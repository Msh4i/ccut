#!/usr/bin/env node
// Local check tool (not shipped): combines a video-only MP4 and an m4a with the SAME code the app
// uses for "Import from link" (link-import-mux.js -> link-import-mux-worker.js, a worker thread,
// packet copy with mediabunny), so the result can be inspected with ffprobe.
//
//   node apps/electron/test/link-import-mux-cli.js <video-only.mp4> <audio.m4a> <new-output.mp4>
//
// The output must not exist yet (the worker creates it with O_EXCL). Prints the outcome as JSON.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { runMuxWorker } = require("../link-import-mux");

async function main() {
	const [video, audio, out] = process.argv.slice(2);
	if (!video || !audio || !out) {
		process.stderr.write("usage: node link-import-mux-cli.js <video-only.mp4> <audio.m4a> <new-output.mp4>\n");
		process.exit(2);
	}
	const describe = (file) => {
		const stat = fs.lstatSync(file);
		return { path: path.resolve(file), size: stat.size, dev: stat.dev, ino: stat.ino };
	};
	const started = Date.now();
	let last = -1;
	const outcome = await runMuxWorker({
		job: { video: describe(video), audio: describe(audio), outPath: path.resolve(out) },
		onProgress: (fraction) => {
			const percent = Math.floor(fraction * 10) * 10;
			if (percent > last) {
				last = percent;
				process.stderr.write(`${percent}%\n`);
			}
		},
	}).done;
	process.stdout.write(`${JSON.stringify({ ...outcome, ms: Date.now() - started }, null, 2)}\n`);
	process.exit(outcome.ok ? 0 : 1);
}

main();
