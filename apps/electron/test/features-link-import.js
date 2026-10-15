// "Import from link" in the REAL Electron window (owner's local session; the cloud cannot run it).
//
//   node apps/electron/test/features-link-import.js
//
// Prerequisites: apps/web/.next/standalone (node apps/electron/bundle.js), /usr/bin/ffmpeg, Node >= 22,
// a display (xvfb-run on a headless Linux). No YouTube/TikTok traffic: the unpackaged app is started
// with CCUT_TEST_YTDLP pointing at a copy of test/fixtures/fake-yt-dlp.js, which "downloads" a sample
// mp4/m4a generated here with ffmpeg from a local HTTP server (127.0.0.1). The packaged app never
// reads CCUT_TEST_YTDLP (link-import-ipc.js readLinkImportSeam).
//
// Output: JSON summary on stdout, apps/electron/test/out/link-import.json and screenshots on failure.
// Exit 0 = every step PASS.
const cp = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { closeApp, collectProblems, connectToPage, launchElectron, sleep } = require("./cdp");
const ed = require("./features-editor");
const lib = require("./features-lib");

const { OUT, byTextFinder, clickEl, createReporter, createShooter, expect, press, problemWindow, toastTexts, waitFor } = lib;

const FFMPEG = "/usr/bin/ffmpeg";
const WATCHDOG_MS = 8 * 60 * 1000;
const DIALOG = `document.querySelector('[role="dialog"]')`;
const { ASSETS } = ed;
const yt = (scenario) => `https://www.youtube.com/watch?v=${scenario}`;

function makeSamples({ dir }) {
	const video = path.join(dir, "sample.mp4");
	const audio = path.join(dir, "sample.m4a");
	// YouTube in Video mode downloads a video-only stream and an m4a and combines them (the pair)
	const videoOnly = path.join(dir, "sample-video.mp4");
	const run = (args) => {
		const result = cp.spawnSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 1 << 26 });
		if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr?.toString().slice(-400)}`);
	};
	run(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", video]);
	run(["-f", "lavfi", "-i", "sine=f=660:d=3", "-c:a", "aac", "-b:a", "128k", audio]);
	run(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "frag_keyframe+empty_moov+default_base_moof", videoOnly]);
	return { video, audio, videoOnly };
}

// Serves the two samples on 127.0.0.1 only; counts requests so a step can prove the fake used it.
function startServer({ files }) {
	const hits = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url);
		const file = files[req.url];
		if (!file) {
			res.writeHead(404).end();
			return;
		}
		const bytes = fs.readFileSync(file);
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }).end(bytes);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, hits })));
}

function installFake({ dir, httpUrl, audioHttpUrl, pairVideoHttpUrl, pairAudioHttpUrl }) {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	for (const name of ["fake-yt-dlp.js", "fake-media.js"]) fs.copyFileSync(path.join(__dirname, "fixtures", name), path.join(bin, name));
	fs.chmodSync(path.join(bin, "fake-yt-dlp.js"), 0o755);
	fs.writeFileSync(path.join(bin, "fake-yt-dlp.json"), JSON.stringify({ httpUrl, audioHttpUrl, pairVideoHttpUrl, pairAudioHttpUrl }));
	return path.join(bin, "fake-yt-dlp.js");
}

const dialogText = (client) => client.evaluate(`(${DIALOG})?.innerText.replace(/\\s+/g, " ") ?? ""`);
const jobDirs = (userDataDir) => {
	const dir = path.join(userDataDir, "link-import", "jobs");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const assetNames = (client) => client.evaluate(`[...${ASSETS}.querySelectorAll("span.sr-only")].map((s) => s.textContent.trim())`);

async function openLinkDialog(client) {
	await ed.openAssetsTab(client, "Media");
	await clickEl(client, "Import chevron", `() => ${ASSETS}.querySelector('button[aria-label="More ways to import"]')`);
	await clickEl(client, "'Import from link' menu item", byTextFinder('[role="menuitem"]', "Import from link"));
	await waitFor("link dialog", async () => (await dialogText(client)).includes("Import from link"));
	// Closed while it ran: the dialog reopens on its end state ("Cancelled …"); go back to the form.
	if (/Import another|Try again/.test(await dialogText(client))) await backToForm(client);
}

async function fillAndSubmit(client, { url, audio = false }) {
	await clickEl(client, "link field", `() => (${DIALOG})?.querySelector('input[type="url"]')`);
	await press(client, "ctrl+a");
	await press(client, "backspace");
	await client.send("Input.insertText", { text: url });
	// The mode stays as last chosen: set it every time.
	await clickEl(client, audio ? "'Audio only'" : "'Video'", byTextFinder("label", audio ? "Audio only" : "Video", DIALOG));
	await clickEl(client, "Import (dialog)", byTextFinder("button", "Import", DIALOG));
}

async function finishedText(client, { timeoutMs = 60_000 } = {}) {
	return waitFor(
		"dialog end state",
		async () => {
			const text = await dialogText(client);
			return /Import another|Try again|Cancelled\. Nothing was added\./.test(text) ? text : null;
		},
		{ timeoutMs },
	);
}

async function backToForm(client) {
	const text = await dialogText(client);
	const label = text.includes("Try again") ? "Try again" : "Import another";
	await clickEl(client, label, byTextFinder("button", label, DIALOG));
}

async function main() {
	const R = createReporter();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccut-link-e2e-"));
	const userDataDir = path.join(dir, "profile");
	let app = null;
	let serverInfo = null;
	const watchdog = setTimeout(() => {
		R.steps.push({ scenario: "watchdog", id: "watchdog", name: "finished in time", status: "FAIL" });
		app?.child.kill("SIGKILL");
		report();
	}, WATCHDOG_MS);
	watchdog.unref();

	function report() {
		clearTimeout(watchdog);
		serverInfo?.server.close();
		const ok = R.steps.length > 0 && R.steps.every((step) => step.status === "PASS");
		fs.mkdirSync(OUT, { recursive: true });
		const summary = { ok, steps: R.steps, notes: R.notes, scenarios: R.scenarios };
		fs.writeFileSync(path.join(OUT, "link-import.json"), JSON.stringify(summary, null, 2));
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, () => process.exit(ok ? 0 : 1));
	}

	try {
		const samples = makeSamples({ dir });
		serverInfo = await startServer({ files: { "/sample.mp4": samples.video, "/sample.m4a": samples.audio, "/sample-video.mp4": samples.videoOnly } });
		const base = `http://127.0.0.1:${serverInfo.port}`;
		process.env.CCUT_TEST_YTDLP = installFake({
			dir,
			httpUrl: `${base}/sample.mp4`,
			audioHttpUrl: `${base}/sample.m4a`,
			pairVideoHttpUrl: `${base}/sample-video.mp4`,
			pairAudioHttpUrl: `${base}/sample.m4a`,
		});
		app = await launchElectron({ userDataDir });
		const client = await connectToPage({ app });
		await client.send("Runtime.enable");
		await client.send("Log.enable");
		await client.send("Network.enable");
		const collected = collectProblems(client);
		const problems = problemWindow(collected);
		const shoot = createShooter({ client });
		R.setFailureHook(async (name) => ({ screenshot: (await shoot(`link-import-${name}`)).file }));

		await R.scenario("L", async () => {
			await ed.newProject(client);

			await R.step("L.1", "the Import button has a chevron with 'Import from link'; it opens the dialog", async () => {
				await openLinkDialog(client);
				return await dialogText(client);
			});

			await R.step("L.2", "first import (YouTube, Video: a video-only stream and an m4a, combined in the main process): the one-time rights notice, then download -> combine -> transfer -> import; the asset appears with the title as its name and 640×360 is reported", async () => {
				await fillAndSubmit(client, { url: yt("ok") });
				await waitFor("rights notice", async () => (await dialogText(client)).includes("Only download content you have the right to use"));
				await clickEl(client, "I understand, continue", byTextFinder("button", "I understand, continue", DIALOG));
				const text = await finishedText(client);
				expect(text.includes("(640×360)"), "the obtained resolution is reported", { actual: text });
				const expectedName = "Fake ok- -quotes- -tags- & a-slash second line.mp4";
				await waitFor("asset card", async () => (await assetNames(client)).includes(expectedName), { timeoutMs: 30_000 });
				expect(serverInfo.hits.includes("/sample-video.mp4") && serverInfo.hits.includes("/sample.m4a"), "the fake fetched the video-only and the audio sample from the local server", { actual: serverInfo.hits });
				expect(jobDirs(userDataDir).length === 0, "the job directory is gone after the transfer", { actual: jobDirs(userDataDir) });
				expect(await client.evaluate(`localStorage.getItem("ccut-link-import-notice-acknowledged") === "1"`), "the acknowledgement is stored");
				return { text, toasts: await toastTexts(client) };
			});

			await R.step("L.3", "second import, Audio only: no notice this time; an audio asset (m4a) is added", async () => {
				await backToForm(client);
				await fillAndSubmit(client, { url: yt("ok"), audio: true });
				const text = await finishedText(client);
				expect(!text.includes("Only download content"), "the notice is not shown again", { actual: text });
				expect(text.includes("(audio only)"), "audio only reported", { actual: text });
				await waitFor("audio asset card", async () => (await assetNames(client)).some((name) => name.endsWith(".m4a")), { timeoutMs: 30_000 });
				return text;
			});

			await R.step("L.4", "errors come back as clear messages: private, region, HTTP 429", async () => {
				const seen = {};
				for (const [scenario, fragment] of [
					["private", "This video is private."],
					["geo", "not available in your region"],
					["429", "HTTP 429"],
				]) {
					await backToForm(client);
					await fillAndSubmit(client, { url: yt(scenario) });
					const text = await finishedText(client);
					expect(text.includes(fragment), `${scenario}: message`, { expected: fragment, actual: text });
					seen[scenario] = text;
				}
				expect(jobDirs(userDataDir).length === 0, "no job directory left after failures", { actual: jobDirs(userDataDir) });
				return seen;
			});

			await R.step("L.5", "a refused link is answered at once in the form; nothing is started", async () => {
				await backToForm(client);
				await fillAndSubmit(client, { url: "https://youtube.com.evil.example/watch?v=x" });
				await waitFor("refusal", async () => (await dialogText(client)).includes("Paste the link of a single YouTube or TikTok video"));
				expect(jobDirs(userDataDir).length === 0, "no job directory");
				return await dialogText(client);
			});

			await R.step("L.6", "Cancel during the download: the process is stopped, its directory deleted, nothing added", async () => {
				const before = (await assetNames(client)).length;
				await fillAndSubmit(client, { url: yt("slow") });
				await waitFor("download progress", async () => (await dialogText(client)).includes("Downloading"));
				expect(jobDirs(userDataDir).length === 1, "a job directory exists while it runs", { actual: jobDirs(userDataDir) });
				await clickEl(client, "Cancel (running)", byTextFinder("button", "Cancel", DIALOG));
				const text = await finishedText(client);
				expect(text.includes("Cancelled. Nothing was added."), "cancelled", { actual: text });
				await waitFor("job directory deleted", async () => jobDirs(userDataDir).length === 0, { timeoutMs: 10_000 });
				expect((await assetNames(client)).length === before, "no new asset");
				return text;
			});

			await R.step("L.7", "closing the dialog with X while it downloads cancels the job", async () => {
				await backToForm(client);
				await fillAndSubmit(client, { url: yt("slow") });
				await waitFor("download progress", async () => (await dialogText(client)).includes("Downloading"));
				await press(client, "escape");
				await waitFor("job directory deleted", async () => jobDirs(userDataDir).length === 0, { timeoutMs: 10_000 });
				return "closed";
			});

			await R.step("L.8", "reload during a download: the main process stops the job (page navigation) and deletes its directory", async () => {
				await openLinkDialog(client);
				await fillAndSubmit(client, { url: yt("slow") });
				await waitFor("download progress", async () => (await dialogText(client)).includes("Downloading"));
				await ed.waitSaved(client, lib.readProjects, { timeoutMs: 8000 }).catch(() => {});
				await client.send("Page.reload");
				await waitFor("job directory deleted", async () => jobDirs(userDataDir).length === 0, { timeoutMs: 10_000 });
				await waitFor("editor back", () => client.evaluate('!!document.querySelector(\'button[aria-label="Text"]\')'), { timeoutMs: 30_000 });
				return "deleted";
			});

			await R.step("L.9", "after the reload the imported assets still load (from the project) and the earlier session's temporary files are swept", async () => {
				await ed.openAssetsTab(client, "Media");
				await waitFor("assets after reload", async () => (await assetNames(client)).some((name) => name.endsWith(".mp4")), { timeoutMs: 30_000 });
				const left = await waitFor(
					"temporary files swept",
					() =>
						client.evaluate(`(async () => {
							const root = await navigator.storage.getDirectory();
							let dir;
							try { dir = await root.getDirectoryHandle("ccut-link-import"); } catch { return 0; }
							let n = 0;
							for await (const _ of dir.keys()) n++;
							return n === 0 ? "empty" : null;
						})()`),
					{ timeoutMs: 10_000 },
				);
				return left;
			});

			await R.step("L.10", "no console error, no failed request, no request to 127.0.0.1 from the page during the scenario", async () => {
				const counts = problems.since({ problems: 0, requests: 0 });
				expect(counts.consoleProblems === 0 && counts.networkProblems === 0, "no problems", { actual: counts.problemSamples });
				expect(counts.directLocalRequests === 0, "the page never talks to the local server (only the fake does)", { actual: counts.directLocalRequests });
				return counts;
			});
		});

		await closeApp({ app });
		app = null;
	} catch (error) {
		R.steps.push({ scenario: R.current, id: "main.error", name: "unexpected error", status: "FAIL", detail: error.stack ?? String(error) });
		if (app) await closeApp({ app }).catch(() => {});
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch {}
		await sleep(10);
		report();
	}
}

main();
