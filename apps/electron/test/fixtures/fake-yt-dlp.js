#!/usr/bin/env node
// A stand-in for yt-dlp in tests. NO network to YouTube/TikTok: it reads the options Ccut
// passes (link-import-args.js), writes progress lines with the job's template, "downloads" a
// file into the output template and appends the result line to the --print-to-file file.
//
// The scenario comes from the URL's v= parameter (https://www.youtube.com/watch?v=<scenario>),
// default "ok". The media bytes come from, in this order: fake-yt-dlp.json next to this file
// ({ "httpUrl": "http://127.0.0.1:<port>/sample.mp4", "audioHttpUrl": ".../sample.m4a" } or
// { "sampleFile": "/abs/path.mp4" }),
// else the fixed pattern of fake-media.js. The real-window test (features-link-import.js)
// copies this file next to such a config; the unit tests run it as it is.
//
// Pair mode (a comma in -f: Ccut's H.264 video-only + AAC m4a selector) "downloads" two real
// files, out/137.mp4 and out/140.m4a, from { "pairVideoHttpUrl", "pairAudioHttpUrl" } in the
// config, else from media/video-frag.mp4 and media/audio-frag.m4a next to this file, with one
// progress series and one result line per file. Pair-only scenarios: pairformat, noavc, nom4a,
// pairvp9, pairnames, pairextra, pairsymlink, pairbadmedia, pairsum, pairbig, pairfinal (plants
// final/media.mp4 as a link to victim.txt in the job directory), pairpadded (the video file gets
// 1.2 MiB of padding after the download), pair403 (the pair download fails with HTTP 403). The single-file
// scenarios (two, symlink, badext, ...) change only the single-file download.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fakeMediaBytes } = require("./fake-media");

const configPath = path.join(__dirname, "fake-yt-dlp.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (args.length === 1 && args[0] === "--version") {
	process.stdout.write(`${config.version ?? "2025.09.26"}\n`);
	process.exit(0);
}

const separator = args.indexOf("--");
if (separator === -1 || separator !== args.length - 2 || args.lastIndexOf("--") !== separator) {
	process.stderr.write("FAKE yt-dlp: the URL must be the only argument after a single --\n");
	process.exit(97);
}
const url = new URL(args[args.length - 1]);
const option = (name) => {
	const index = args.indexOf(name);
	return index === -1 || index >= separator ? null : args[index + 1];
};
const scenario = url.searchParams.get("v") ?? "ok";
const format = option("-f") ?? "";
const pair = format.includes(",");
const audio = !pair && format.startsWith("ba");
const outputTemplate = option("-o");
const progressTemplate = (option("--progress-template") ?? "").replace(/^download:/, "");
const printIndex = args.indexOf("--print-to-file");
const resultFile = printIndex === -1 ? null : args[printIndex + 2];

function progressLine({ downloaded, total, speed, eta, formatId = "18" }) {
	const fields = { downloaded_bytes: downloaded, total_bytes: total, total_bytes_estimate: null, speed, eta };
	return progressTemplate
		.replace("%(info.format_id)s", formatId)
		.replace(/%\(progress\.([a-z_]+)\)s/g, (_, name) => (fields[name] === null || fields[name] === undefined ? "NA" : String(fields[name])));
}

function writeResult(info) {
	if (resultFile) fs.appendFileSync(resultFile, `${JSON.stringify(info)}\n`);
}

async function mediaBytes() {
	// Audio-only requests use audioHttpUrl when it is configured (a real m4a for the real-window test).
	const httpUrl = audio && config.audioHttpUrl ? config.audioHttpUrl : config.httpUrl;
	if (httpUrl) {
		const response = await fetch(httpUrl);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return Buffer.from(await response.arrayBuffer());
	}
	if (config.sampleFile) return fs.readFileSync(config.sampleFile);
	return fakeMediaBytes();
}

async function download({ ext, chunks = 4, delayMs = 10, bytes: given, formatId }) {
	const bytes = given ?? (await mediaBytes());
	const target = outputTemplate.replace("%(format_id)s", formatId ?? "").replace("%(ext)s", ext);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	process.stdout.write(`[download] Destination: ${target}\n`);
	const step = Math.ceil(bytes.length / chunks);
	fs.writeFileSync(`${target}.part`, "");
	for (let offset = 0; offset < bytes.length; offset += step) {
		fs.appendFileSync(`${target}.part`, bytes.subarray(offset, offset + step));
		const downloaded = Math.min(bytes.length, offset + step);
		process.stdout.write(`${progressLine({ downloaded, total: bytes.length, speed: 123456.789, eta: downloaded === bytes.length ? 0 : 1, formatId })}\n`);
		await sleep(delayMs);
	}
	fs.renameSync(`${target}.part`, target);
	return { target, size: bytes.length };
}

const info = (ext) => ({
	id: scenario,
	title: `Fake ${scenario}: "quotes" <tags> & a/slash\nsecond line`,
	ext,
	width: audio ? null : 640,
	height: audio ? null : 360,
	vcodec: audio ? "none" : "avc1.42001E",
	acodec: "mp4a.40.2",
	duration: 6,
});

const ERRORS = {
	private: "ERROR: [youtube] private0001: Private video. Sign in if you've been granted access to this video",
	geo: "ERROR: [youtube] geo00000001: Video unavailable. The uploader has not made this video available in your country",
	429: "ERROR: [youtube] rate0000001: Unable to download API page: HTTP Error 429: Too Many Requests",
	unsupported: `ERROR: Unsupported URL: ${url.href}`,
	format: "ERROR: [youtube] format00001: Requested format is not available. Use --list-formats for a list of available formats",
	network: "ERROR: [youtube] net00000001: Unable to download webpage: [Errno -3] Temporary failure in name resolution",
	403: "ERROR: unable to download video data: HTTP Error 403: Forbidden",
};

async function pairBytes(kind) {
	const httpUrl = kind === "video" ? config.pairVideoHttpUrl : config.pairAudioHttpUrl;
	if (httpUrl) {
		const response = await fetch(httpUrl);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return Buffer.from(await response.arrayBuffer());
	}
	return fs.readFileSync(path.join(__dirname, "media", kind === "video" ? "video-frag.mp4" : "audio-frag.m4a"));
}

const pairInfo = ({ formatId, ext }) => ({
	id: scenario,
	title: `Fake ${scenario}: "quotes" <tags> & a/slash\nsecond line`,
	format_id: formatId,
	ext,
	width: ext === "mp4" ? 128 : null,
	height: ext === "mp4" ? 72 : null,
	vcodec: ext === "mp4" ? (scenario === "pairvp9" ? "vp9" : "avc1.64000b") : "none",
	acodec: ext === "mp4" ? "none" : "mp4a.40.2",
	duration: 1,
});

async function pairMain() {
	switch (scenario) {
		case "pairformat":
			process.stderr.write(`${ERRORS.format}\n`);
			process.exit(1);
			break;
		case "pair403":
			process.stderr.write(`${ERRORS[403]}\n`);
			process.exit(1);
			break;
		case "pairbig":
			process.stdout.write("\r[download] File is larger than max-filesize (3000000000 bytes > 2147483648 bytes). Aborting.\n");
			process.exit(0);
			break;
		case "pairsum":
			// each file alone is below the cap, together they are not
			process.stdout.write(`${progressLine({ downloaded: 700_000, total: 700_000, speed: 1000, eta: 0, formatId: "137" })}\n`);
			process.stdout.write(`${progressLine({ downloaded: 100_000, total: 700_000, speed: 1000, eta: 600, formatId: "140" })}\n`);
			await sleep(30_000);
			process.exit(1);
			break;
		default:
	}
	const video = { formatId: "137", ext: "mp4", bytes: await pairBytes("video") };
	const sound = { formatId: "140", ext: "m4a", bytes: await pairBytes("audio") };
	if (scenario === "pairbadmedia") video.bytes = fakeMediaBytes(4000);
	const parts = scenario === "noavc" ? [sound] : scenario === "nom4a" ? [video] : [video, sound];
	const targets = [];
	for (const part of parts) targets.push((await download({ ext: part.ext, bytes: part.bytes, formatId: part.formatId })).target);
	const outDir = path.dirname(targets[0]);
	switch (scenario) {
		case "pairnames":
			fs.renameSync(path.join(outDir, "137.mp4"), path.join(outDir, "999.mp4"));
			break;
		case "pairextra":
			fs.writeFileSync(path.join(outDir, "137.mp4.part"), "left over");
			break;
		case "pairsymlink":
			fs.rmSync(path.join(outDir, "137.mp4"));
			fs.symlinkSync(path.join(__dirname, "media", "video-frag.mp4"), path.join(outDir, "137.mp4"));
			break;
		case "pairpadded":
			fs.appendFileSync(path.join(outDir, "137.mp4"), Buffer.alloc(1.2 * 1024 * 1024));
			break;
		case "pairfinal":
			fs.writeFileSync("victim.txt", "must stay");
			fs.mkdirSync("final");
			fs.symlinkSync(path.resolve("victim.txt"), path.join("final", "media.mp4"));
			break;
		default:
	}
	for (const part of parts) writeResult(pairInfo(part));
	process.exit(0);
}

async function main() {
	process.stdout.write(`[youtube] Extracting URL: ${url.href}\n`);
	const ext = audio ? "m4a" : "mp4";
	if (Object.hasOwn(ERRORS, scenario)) {
		process.stderr.write(`${ERRORS[scenario]}\n`);
		process.exit(1);
	}
	switch (scenario) {
		case "env":
			fs.writeFileSync("env.json", JSON.stringify(process.env));
			break;
		case "args":
			fs.writeFileSync("args.json", JSON.stringify(args));
			break;
		case "slow":
		case "child": {
			if (scenario === "child") {
				const grandchild = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
				fs.writeFileSync("pids.json", JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
			}
			for (let i = 0; i < 600; i++) {
				process.stdout.write(`${progressLine({ downloaded: i * 1000, total: 600_000, speed: 1000, eta: 600 - i })}\n`);
				await sleep(100);
			}
			process.exit(1);
			break;
		}
		case "hang":
			await sleep(60_000);
			process.exit(1);
			break;
		case "huge":
			process.stdout.write(`${progressLine({ downloaded: 1000, total: 3_000_000_000, speed: 1000, eta: 3000 })}\n`);
			await sleep(30_000);
			process.exit(1);
			break;
		case "big":
			process.stdout.write("\r[download] File is larger than max-filesize (3000000000 bytes > 2147483648 bytes). Aborting.\n");
			process.exit(0);
			break;
		default:
	}
	if (pair) return pairMain();
	const { target } = await download({ ext });
	switch (scenario) {
		case "two":
			fs.writeFileSync(path.join(path.dirname(target), "media.webm"), "second");
			break;
		case "symlink":
			fs.rmSync(target);
			fs.symlinkSync(__filename, target);
			break;
		case "badext":
			fs.renameSync(target, target.replace(/\.[a-z0-9]+$/, ".exe"));
			writeResult(info("exe"));
			process.exit(0);
			break;
		case "mismatch":
			writeResult(info("webm"));
			process.exit(0);
			break;
		case "empty":
			fs.writeFileSync(target, "");
			break;
		case "notmedia":
			fs.writeFileSync(target, "<!DOCTYPE html><html><body>Sign in</body></html>\n".repeat(50));
			break;
		case "noresult":
			process.exit(0);
			break;
		default:
	}
	writeResult(info(ext));
	process.exit(0);
}

main().catch((error) => {
	process.stderr.write(`ERROR: fake failure: ${error.message}\n`);
	process.exit(1);
});
