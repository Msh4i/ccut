const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
	EncodedAudioPacketSource,
	EncodedPacket,
	Input,
	BufferSource,
	ALL_FORMATS,
	Mp4OutputFormat,
	Output,
	StreamTarget,
	WebMOutputFormat,
} = require("mediabunny");
const {
	ExportSessions,
	LIMITS,
	createFailingHandle,
	forceExtension,
	isTrustedSender,
	readSeamEnv,
	resolveChosenPath,
	sanitizeBaseName,
	uniqueName,
	verifyContainer,
} = require("../export-files");

// Real temporary directories and real files: the part file, rename and delete are
// what is under test. mediabunny writes real MP4/WebM files from ready-made packets
// (no encoder needed), through the same StreamTarget the renderer uses.

let dir;
beforeEach(async () => {
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-export-test-"));
});
afterEach(async () => {
	await fsp.rm(dir, { recursive: true, force: true });
});

const list = () => fs.readdirSync(dir).sort();
const OWNER = 7;

function createSessions({ limits, fsApi = fsp, wrapHandle, now = () => 0, pathApi, randomHex = () => "0a1b2c3d" } = {}) {
	let uuid = 0;
	const sleeps = [];
	const sessions = new ExportSessions({
		fs: fsApi,
		randomUUID: () => `token-${++uuid}`,
		randomHex,
		now,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		wrapHandle,
		pathApi,
		limits,
	});
	return { sessions, sleeps };
}

/** A FileHandle stand-in that does what the real one does, except for the named methods (which get the real handle first). */
const passthrough = (handle, overrides = {}) => ({
	fd: handle.fd,
	write: (...args) => handle.write(...args),
	read: (...args) => handle.read(...args),
	sync: () => handle.sync(),
	close: () => handle.close(),
	chmod: (...args) => handle.chmod(...args),
	...Object.fromEntries(Object.entries(overrides).map(([name, fn]) => [name, (...args) => fn(handle, ...args)])),
});

/** A promise and the function that settles it, for holding an operation at a chosen point. */
function gate() {
	let open;
	const passed = new Promise((resolve) => {
		open = resolve;
	});
	return { passed, open };
}

async function beginAt({ sessions, name = "clip.mp4", container = "mp4", ownerId = OWNER }) {
	const result = await sessions.begin({ ownerId, container, choosePath: async () => path.join(dir, name) });
	if (!result.ok) throw new Error(`begin failed: ${result.reason}`);
	return result;
}

// bun 1.2.18 can hang after an unhandled rejection: always await this.
async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "resolved";
}

/** A real file, written by mediabunny through a StreamTarget into `write`. */
async function produceFile({ container, write, packets = 50 }) {
	const target = new StreamTarget(
		new WritableStream({ write: (chunk) => write({ position: chunk.position, data: chunk.data }) }),
		{ chunked: true, chunkSize: 1024 },
	);
	const format = container === "mp4" ? new Mp4OutputFormat({ fastStart: "reserve" }) : new WebMOutputFormat();
	const output = new Output({ format, target });
	const source = new EncodedAudioPacketSource(container === "mp4" ? "aac" : "opus");
	output.addAudioTrack(source, { maximumPacketCount: packets + 8 });
	await output.start();
	const meta =
		container === "mp4"
			? { decoderConfig: { codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 44100, description: new Uint8Array([0x12, 0x10]) } }
			: { decoderConfig: { codec: "opus", numberOfChannels: 2, sampleRate: 48000 } };
	for (let i = 0; i < packets; i++) {
		await source.add(new EncodedPacket(new Uint8Array(100).fill(i), "key", i * 0.02, 0.02), i === 0 ? meta : undefined);
	}
	await output.finalize();
}

/** The bytes mediabunny produces, assembled in memory (reference copy). */
async function fileBytes({ container, packets }) {
	let bytes = new Uint8Array(0);
	await produceFile({
		container,
		packets,
		write: ({ position, data }) => {
			const end = position + data.byteLength;
			if (end > bytes.length) {
				const grown = new Uint8Array(end);
				grown.set(bytes);
				bytes = grown;
			}
			bytes.set(data, position);
		},
	});
	return bytes;
}

const readerOf = (bytes) => async ({ position, length }) => bytes.subarray(position, position + length);

describe("sanitizeBaseName", () => {
	test("keeps an ordinary name, Unicode included", () => {
		expect(sanitizeBaseName("Tatil 2026")).toBe("Tatil 2026");
		expect(sanitizeBaseName("çğıİöşü ✨")).toBe("çğıİöşü ✨");
	});

	test("no directory survives: separators, .., drive letters and UNC become plain characters", () => {
		for (const hostile of ["../../etc/passwd", "..\\..\\Windows\\System32\\x", "C:\\Users\\a\\b", "\\\\server\\share\\x", "/abs/path", "a/../../b"]) {
			const name = sanitizeBaseName(hostile);
			expect(name).not.toMatch(/[\\/:]/);
			expect(name).not.toContain("..");
			expect(path.basename(name)).toBe(name);
			expect(path.win32.basename(name)).toBe(name);
		}
	});

	test("characters Windows refuses, control characters and direction marks are gone", () => {
		expect(sanitizeBaseName('a<b>c:d"e|f?g*h')).toBe("a-b-c-d-e-f-g-h");
		expect(sanitizeBaseName("a\u0000b\u0007c\nd\u007f")).toBe("abcd");
		expect(sanitizeBaseName("clip\u202Ekcp4.exe")).toBe("clipkcp4.exe");
		expect(sanitizeBaseName("a\u2066b\u200fc")).toBe("abc");
	});

	test("Windows device names get a prefix, with or without an extension or trailing space", () => {
		for (const device of ["CON", "prn", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9", "nul.txt", "CON .mp4", "COM\u00b9"]) {
			const name = sanitizeBaseName(device);
			expect(name.startsWith("_")).toBe(true);
		}
		expect(sanitizeBaseName("CONSOLE")).toBe("CONSOLE");
		expect(sanitizeBaseName("COM10")).toBe("COM10");
	});

	test("leading/trailing dots and spaces are trimmed; empty or all-hostile names fall back to 'export'", () => {
		expect(sanitizeBaseName("  .hidden. ")).toBe("hidden");
		expect(sanitizeBaseName("name...")).toBe("name");
		for (const empty of ["", "   ", "...", "..", ".", "/", "\\", "\u202E", "///"]) {
			expect(sanitizeBaseName(empty)).toBe("export");
		}
		for (const notString of [undefined, null, 42, {}, ["a"]]) {
			expect(sanitizeBaseName(notString)).toBe("export");
		}
	});

	test("at most 120 characters, never cutting a surrogate pair", () => {
		expect(Array.from(sanitizeBaseName("a".repeat(500)))).toHaveLength(120);
		const emoji = sanitizeBaseName("😀".repeat(300));
		expect(Array.from(emoji).every((char) => char === "😀")).toBe(true);
		expect(Array.from(emoji).length).toBeLessThanOrEqual(120);
	});

	test("at most 200 UTF-8 bytes, cut on a code point: a name component is limited to 255 BYTES, and .mp4 plus .ccut-part come on top", () => {
		// 200 x CJK was 374 bytes with the extension and the part suffix: the file system refused it.
		const cjk = sanitizeBaseName("中".repeat(200));
		expect(cjk).toBe("中".repeat(66)); // 66 x 3 = 198 bytes; a 67th would be 201
		expect(sanitizeBaseName("😀".repeat(100))).toBe("😀".repeat(50)); // 4 bytes each: exactly 200
		expect(sanitizeBaseName("é".repeat(150))).toBe("é".repeat(100)); // 2 bytes each
		expect(sanitizeBaseName("e\u0301".repeat(150))).toBe("é".repeat(100)); // NFC first: the decomposed form is the same name
		for (const name of [cjk, sanitizeBaseName("😀".repeat(100)), sanitizeBaseName("ß".repeat(500))]) {
			expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
			expect(Buffer.byteLength(`${name}.webm.ccut-part`)).toBeLessThanOrEqual(255);
		}
	});

	test("after a byte cut, a trailing dot or space is trimmed again; a Windows device name still gets its prefix", () => {
		expect(sanitizeBaseName(`${"中".repeat(66)}.中`)).toBe("中".repeat(66)); // the cut falls right after the dot
		expect(sanitizeBaseName(`${"中".repeat(66)} 中`)).toBe("中".repeat(66));
		expect(sanitizeBaseName("con")).toBe("_con");
	});
});

describe("forceExtension and uniqueName", () => {
	test("the container's extension is always the last one", () => {
		expect(forceExtension("clip", "mp4")).toBe("clip.mp4");
		expect(forceExtension("x.exe", "mp4")).toBe("x.exe.mp4");
		expect(forceExtension("a.MP4", "mp4")).toBe("a.MP4");
		expect(forceExtension("a.mp4", "webm")).toBe("a.mp4.webm");
		expect(forceExtension("clip.webm", "webm")).toBe("clip.webm");
	});

	test("an unknown container is refused", () => {
		for (const bad of ["exe", "mov", "", undefined, "__proto__", "toString"]) {
			expect(() => forceExtension("a", bad)).toThrow("CCUT_EXPORT:INVALID");
		}
	});

	test("uniqueName counts up to the first free name", async () => {
		const taken = new Set([path.join(dir, "a (1).mp4"), path.join(dir, "a (2).mp4")]);
		expect(await uniqueName({ dir, base: "a.mp4", exists: async (p) => taken.has(p) })).toBe("a (3).mp4");
	});
});

describe("resolveChosenPath", () => {
	const exists = async (p) => fs.existsSync(p);

	test("forces the extension on what the user typed in the dialog", async () => {
		expect(await resolveChosenPath({ chosenPath: path.join(dir, "x.exe"), container: "mp4", exists })).toBe(path.join(dir, "x.exe.mp4"));
	});

	test("the name the dialog confirmed is kept, even if it exists (the OS asked about overwriting)", async () => {
		fs.writeFileSync(path.join(dir, "old.mp4"), "x");
		expect(await resolveChosenPath({ chosenPath: path.join(dir, "old.mp4"), container: "mp4", exists })).toBe(path.join(dir, "old.mp4"));
	});

	test("if forcing the extension lands on an existing file nobody confirmed, a free name is used", async () => {
		fs.writeFileSync(path.join(dir, "old.mp4"), "precious");
		expect(await resolveChosenPath({ chosenPath: path.join(dir, "old"), container: "mp4", exists })).toBe(path.join(dir, "old (1).mp4"));
	});

	test("relative paths, NUL bytes, non-strings and bare directories are refused", async () => {
		for (const chosenPath of ["clip.mp4", "../clip.mp4", `${dir}/a\0.mp4`, 42, null, "/"]) {
			expect(await rejection(resolveChosenPath({ chosenPath, container: "mp4", exists }))).toBe("CCUT_EXPORT:INVALID");
		}
	});

	test("an existing DIRECTORY at the chosen path is refused up front, not discovered when the export is over", async () => {
		fs.mkdirSync(path.join(dir, "movie.mp4"));
		const isDirectory = async (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
		expect(await rejection(resolveChosenPath({ chosenPath: path.join(dir, "movie.mp4"), container: "mp4", exists, isDirectory }))).toBe("CCUT_EXPORT:INVALID");
		// Forcing the extension onto an existing directory's name is the unconfirmed-name case: a free name.
		expect(await resolveChosenPath({ chosenPath: path.join(dir, "movie"), container: "mp4", exists, isDirectory })).toBe(path.join(dir, "movie (1).mp4"));
		fs.writeFileSync(path.join(dir, "file.mp4"), "x");
		expect(await resolveChosenPath({ chosenPath: path.join(dir, "file.mp4"), container: "mp4", exists, isDirectory })).toBe(path.join(dir, "file.mp4"));
	});

	test("Windows: alternate data streams and device-namespace paths are refused; ordinary, UNC and extended-length paths stay", async () => {
		const win = (chosenPath) => resolveChosenPath({ chosenPath, container: "mp4", exists: async () => false, pathApi: path.win32 });
		for (const hostile of [
			"C:\\Users\\a\\clip.mp4:evil.exe", // clip.mp4 with a hidden stream
			"C:\\Users\\a\\clip:stream",
			"C:\\Users\\a:b\\clip.mp4",
			"\\\\.\\PhysicalDrive0",
			"\\\\.\\pipe\\x",
			"//./pipe/x",
			"\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x.mp4",
			"\\\\?\\globalroot\\Device\\x.mp4",
			"//?/GLOBALROOT/Device/x.mp4",
		]) {
			expect(await rejection(win(hostile))).toBe("CCUT_EXPORT:INVALID");
		}
		expect(await win("C:\\Users\\a\\clip.mp4")).toBe("C:\\Users\\a\\clip.mp4");
		expect(await win("\\\\server\\share\\clip")).toBe("\\\\server\\share\\clip.mp4");
		expect(await win("\\\\?\\C:\\Users\\a\\clip.mp4")).toBe("\\\\?\\C:\\Users\\a\\clip.mp4");
	});

	test("Windows: a directory chosen in the dialog is refused too", async () => {
		const isDirectory = async (p) => p === "C:\\Users\\a\\movie.mp4";
		expect(
			await rejection(resolveChosenPath({ chosenPath: "C:\\Users\\a\\movie.mp4", container: "mp4", exists: async () => true, isDirectory, pathApi: path.win32 })),
		).toBe("CCUT_EXPORT:INVALID");
	});

	// POSIX paths explicitly: with the default `path` this test would check Windows rules when CI runs on Windows.
	test("elsewhere a colon is an ordinary character in a file name", async () => {
		expect(await resolveChosenPath({ chosenPath: "/home/a/a:b.mp4", container: "mp4", exists: async () => false, pathApi: path.posix })).toBe(
			"/home/a/a:b.mp4",
		);
	});

	test("Windows: a device name chosen in the dialog is refused", async () => {
		expect(
			await rejection(resolveChosenPath({ chosenPath: "C:\\Users\\a\\CON", container: "mp4", exists: async () => false, pathApi: path.win32 })),
		).toBe("CCUT_EXPORT:INVALID");
		expect(await resolveChosenPath({ chosenPath: "C:\\Users\\a\\clip", container: "mp4", exists: async () => false, pathApi: path.win32 })).toBe(
			"C:\\Users\\a\\clip.mp4",
		);
	});
});

describe("isTrustedSender", () => {
	const mainFrame = { url: "ccut://app/editor/1" };
	const webContents = { mainFrame };
	const event = (overrides) => ({ sender: webContents, senderFrame: mainFrame, ...overrides });

	test("the app's main frame on the app origin is trusted", () => {
		expect(isTrustedSender({ event: event({}), webContents, origin: "ccut://app" })).toBe(true);
	});

	test("another webContents, a sub-frame, a missing frame, another origin or a bad URL are not", () => {
		const origin = "ccut://app";
		expect(isTrustedSender({ event: event({ sender: {} }), webContents, origin })).toBe(false);
		expect(isTrustedSender({ event: event({ senderFrame: { url: "ccut://app/x" } }), webContents, origin })).toBe(false);
		expect(isTrustedSender({ event: event({ senderFrame: null }), webContents, origin })).toBe(false);
		expect(isTrustedSender({ event: event({}), webContents: { mainFrame: { url: "https://evil.example/" } }, origin })).toBe(false);
		const evil = { url: "https://evil.example/" };
		expect(isTrustedSender({ event: { sender: { mainFrame: evil }, senderFrame: evil }, webContents: { mainFrame: evil }, origin })).toBe(false);
		const broken = { url: "not a url" };
		expect(isTrustedSender({ event: { sender: { mainFrame: broken }, senderFrame: broken }, webContents: { mainFrame: broken }, origin })).toBe(false);
		expect(isTrustedSender({ event: undefined, webContents, origin })).toBe(false);
		expect(isTrustedSender({ event: event({}), webContents: null, origin })).toBe(false);
	});

	test("the scheme and the host are each checked on their own: right host with another scheme, right scheme with another host", () => {
		// The sender IS the window and the frame IS its main frame: only the URL is under test.
		const trusted = (url) => {
			const frame = { url };
			const webContents = { mainFrame: frame };
			return isTrustedSender({ event: { sender: webContents, senderFrame: frame }, webContents, origin: "ccut://app" });
		};
		expect(trusted("ccut://app/editor/1")).toBe(true);
		expect(trusted("ccut://evil/editor/1")).toBe(false); // the scheme matches, the host does not
		expect(trusted("ccut://app.evil.example/")).toBe(false);
		expect(trusted("https://app/editor/1")).toBe(false); // the host matches, the scheme does not
		expect(trusted("http://app/")).toBe(false);
		expect(trusted("file://app/x")).toBe(false);
	});

	test("an origin without a host trusts nothing, not even a frame without one", () => {
		const frame = { url: "ccut:///x" };
		const webContents = { mainFrame: frame };
		expect(isTrustedSender({ event: { sender: webContents, senderFrame: frame }, webContents, origin: "ccut:///" })).toBe(false);
	});
});

describe("readSeamEnv", () => {
	test("a packaged build never reads the seam, whatever the environment says", () => {
		expect(readSeamEnv({ isPackaged: true, env: { CCUT_TEST_EXPORT_DIR: dir, CCUT_TEST_EXPORT_FAIL_AFTER_BYTES: "10" } })).toBeNull();
		expect(readSeamEnv({ isPackaged: undefined, env: { CCUT_TEST_EXPORT_DIR: dir } })).toBeNull();
	});

	test("unpackaged: the directory must be absolute; the byte limit is optional and digits only", () => {
		expect(readSeamEnv({ isPackaged: false, env: {} })).toBeNull();
		expect(readSeamEnv({ isPackaged: false, env: { CCUT_TEST_EXPORT_DIR: "relative/dir" } })).toBeNull();
		expect(readSeamEnv({ isPackaged: false, env: { CCUT_TEST_EXPORT_DIR: dir } })).toEqual({ dir, failAfterBytes: null });
		expect(readSeamEnv({ isPackaged: false, env: { CCUT_TEST_EXPORT_DIR: dir, CCUT_TEST_EXPORT_FAIL_AFTER_BYTES: "4096" } })).toEqual({
			dir,
			failAfterBytes: 4096,
		});
		expect(readSeamEnv({ isPackaged: false, env: { CCUT_TEST_EXPORT_DIR: dir, CCUT_TEST_EXPORT_FAIL_AFTER_BYTES: "-1" } })).toEqual({
			dir,
			failAfterBytes: null,
		});
	});
});

describe("verifyContainer", () => {
	for (const container of ["mp4", "webm"]) {
		test(`${container}: a real file passes; every truncated copy fails`, async () => {
			const bytes = await fileBytes({ container, packets: 40 });
			expect(await verifyContainer({ container, size: bytes.length, readAt: readerOf(bytes) })).toBe(true);
			for (const cut of [1, 7, 100, Math.floor(bytes.length / 2), bytes.length - 100, bytes.length - 1]) {
				const truncated = bytes.subarray(0, bytes.length - cut);
				expect(await verifyContainer({ container, size: truncated.length, readAt: readerOf(truncated) })).toBe(false);
			}
		});

		test(`${container}: a file with junk appended fails, and so does the other container's file`, async () => {
			const bytes = await fileBytes({ container, packets: 20 });
			const longer = new Uint8Array(bytes.length + 10);
			longer.set(bytes);
			expect(await verifyContainer({ container, size: longer.length, readAt: readerOf(longer) })).toBe(false);
			const other = await fileBytes({ container: container === "mp4" ? "webm" : "mp4", packets: 20 });
			expect(await verifyContainer({ container, size: other.length, readAt: readerOf(other) })).toBe(false);
		});
	}

	test("mp4 from mediabunny's 'reserve' mode is ftyp, moov, free, mdat", async () => {
		const bytes = await fileBytes({ container: "mp4", packets: 30 });
		const types = [];
		for (let at = 0; at < bytes.length; ) {
			const view = new DataView(bytes.buffer, bytes.byteOffset + at, 8);
			types.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
			at += view.getUint32(0);
		}
		expect(types).toEqual(["ftyp", "moov", "free", "mdat"]);
	});

	test("hostile headers: zero-size boxes in the middle, sizes past the end, empty files, unknown-size segments", async () => {
		const box = (size, type) => {
			const b = new Uint8Array(8);
			new DataView(b.buffer).setUint32(0, size);
			b.set(Array.from(type, (c) => c.charCodeAt(0)), 4);
			return b;
		};
		const join = (...parts) => {
			const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
			let at = 0;
			for (const p of parts) {
				out.set(p, at);
				at += p.length;
			}
			return out;
		};
		const pad = (b, n) => join(b, new Uint8Array(n - b.length));
		const ok = join(pad(box(16, "ftyp"), 16), pad(box(8, "moov"), 8), pad(box(8, "mdat"), 8));
		expect(await verifyContainer({ container: "mp4", size: ok.length, readAt: readerOf(ok) })).toBe(true);
		const noMoov = join(pad(box(16, "ftyp"), 16), pad(box(8, "mdat"), 8));
		expect(await verifyContainer({ container: "mp4", size: noMoov.length, readAt: readerOf(noMoov) })).toBe(false);
		const tooBig = join(pad(box(16, "ftyp"), 16), pad(box(9999, "moov"), 8));
		expect(await verifyContainer({ container: "mp4", size: tooBig.length, readAt: readerOf(tooBig) })).toBe(false);
		const tinyBox = join(pad(box(16, "ftyp"), 16), box(4, "moov"), box(8, "mdat"));
		expect(await verifyContainer({ container: "mp4", size: tinyBox.length, readAt: readerOf(tinyBox) })).toBe(false);
		expect(await verifyContainer({ container: "mp4", size: 0, readAt: readerOf(new Uint8Array()) })).toBe(false);
		// A reader that returns fewer bytes than asked (file shorter than claimed) fails, never throws.
		expect(await verifyContainer({ container: "mp4", size: 64, readAt: readerOf(ok) })).toBe(false);
		// WebM whose Segment has the "unknown size" marker: a cut file could look complete, so refused.
		const webm = await fileBytes({ container: "webm", packets: 10 });
		const unknown = webm.slice();
		const segmentAt = unknown.findIndex((_, i) => unknown[i] === 0x18 && unknown[i + 1] === 0x53 && unknown[i + 2] === 0x80 && unknown[i + 3] === 0x67);
		unknown[segmentAt + 4] = 0x01;
		unknown.fill(0xff, segmentAt + 5, segmentAt + 12);
		expect(await verifyContainer({ container: "webm", size: unknown.length, readAt: readerOf(unknown) })).toBe(false);
	});
});

describe("ExportSessions: a whole export", () => {
	for (const container of ["mp4", "webm"]) {
		test(`${container}: mediabunny streams into the part file, finish renames it, the file is byte-identical and readable`, async () => {
			const { sessions } = createSessions();
			const began = await beginAt({ sessions, name: `clip.${container}`, container });
			const { token, displayName } = began;
			expect(displayName).toBe(`clip.${container}`);
			// What the page gets back: no path, no free-space figure (nothing uses it, it would only leak).
			expect(began).toStrictEqual({ ok: true, token: "token-1", displayName: `clip.${container}` });
			expect(list()).toEqual([`clip.${container}.ccut-part`]);

			let totalBytes = 0;
			await produceFile({
				container,
				write: async ({ position, data }) => {
					totalBytes = Math.max(totalBytes, position + data.byteLength);
					await sessions.write({ ownerId: OWNER, token, position, data: data.slice() });
				},
			});
			expect(await sessions.finish({ ownerId: OWNER, token, totalBytes })).toEqual({ displayName: `clip.${container}`, bytes: totalBytes });
			expect(list()).toEqual([`clip.${container}`]);

			const onDisk = fs.readFileSync(path.join(dir, `clip.${container}`));
			expect(Buffer.compare(onDisk, Buffer.from(await fileBytes({ container, packets: 50 })))).toBe(0);
			const input = new Input({ source: new BufferSource(new Uint8Array(onDisk).buffer), formats: ALL_FORMATS });
			try {
				expect((await input.getPrimaryAudioTrack())?.codec).toBe(container === "mp4" ? "aac" : "opus");
			} finally {
				input.dispose();
			}
			expect(sessions.revealPath({ ownerId: OWNER, token })).toBe(path.join(dir, `clip.${container}`));
		});
	}

	test("overlapping and backwards writes (moov written back at the start) land where they belong", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 10 });
		// Write it forwards in 100-byte pieces, overwrite the start with junk, then with the truth.
		for (let at = 0; at < reference.length; at += 100) {
			await sessions.write({ ownerId: OWNER, token, position: at, data: reference.slice(at, at + 100) });
		}
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(300).fill(0xee) });
		await sessions.write({ ownerId: OWNER, token, position: 50, data: reference.slice(50, 400) });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference.slice(0, 50) });
		await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
		expect(Buffer.compare(fs.readFileSync(path.join(dir, "clip.mp4")), Buffer.from(reference))).toBe(0);
	});

	test("writes sent without waiting are applied in the order they were sent", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 10 });
		const pending = [];
		for (let at = 0; at < reference.length; at += 64) {
			pending.push(sessions.write({ ownerId: OWNER, token, position: at, data: reference.slice(at, at + 64) }));
		}
		pending.push(sessions.write({ ownerId: OWNER, token, position: 0, data: reference.slice(0, 64) }));
		await Promise.all(pending);
		await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
		expect(Buffer.compare(fs.readFileSync(path.join(dir, "clip.mp4")), Buffer.from(reference))).toBe(0);
	});
});

describe("ExportSessions: begin", () => {
	test("a cancelled dialog creates nothing", async () => {
		const { sessions } = createSessions();
		expect(await sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => null })).toEqual({ ok: false, reason: "cancelled" });
		expect(list()).toEqual([]);
		// ... and does not leave the manager busy.
		await beginAt({ sessions });
	});

	test("a second begin while the dialog is open, or while a session writes, is busy (any window)", async () => {
		const { sessions } = createSessions();
		let answer;
		const first = sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: () => new Promise((resolve) => (answer = resolve)) });
		expect(await sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => path.join(dir, "b.mp4") })).toEqual({ ok: false, reason: "busy" });
		answer(path.join(dir, "a.mp4"));
		expect((await first).ok).toBe(true);
		expect(await sessions.begin({ ownerId: 99, container: "mp4", choosePath: async () => path.join(dir, "c.mp4") })).toEqual({ ok: false, reason: "busy" });
		expect(list()).toEqual(["a.mp4.ccut-part"]);
	});

	test("the page reloads (or closes) while its save dialog is open: the answer is void, no part file, not busy", async () => {
		const { sessions } = createSessions();
		let answer;
		const pending = sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: () => new Promise((resolve) => (answer = resolve)) });
		await sessions.abortOwner(OWNER);
		answer(path.join(dir, "a.mp4"));
		expect(await pending).toEqual({ ok: false, reason: "cancelled" });
		expect(list()).toEqual([]);
		await beginAt({ sessions, name: "b.mp4" });
	});

	test("a dialog that throws leaves the manager usable", async () => {
		const { sessions } = createSessions();
		expect(await rejection(sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => { throw new Error("dialog broke"); } }))).toBe("dialog broke");
		await beginAt({ sessions });
	});

	test("an invalid container or chosen path is refused, nothing is created", async () => {
		const { sessions } = createSessions();
		expect(await rejection(sessions.begin({ ownerId: OWNER, container: "exe", choosePath: async () => path.join(dir, "a") }))).toBe("CCUT_EXPORT:INVALID");
		expect(await sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => "relative.mp4" })).toEqual({ ok: false, reason: "invalid" });
		expect(list()).toEqual([]);
	});

	test("an unwritable or missing directory is dir-not-writable", async () => {
		const { sessions } = createSessions();
		expect(await sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => path.join(dir, "missing", "a.mp4") })).toEqual({
			ok: false,
			reason: "dir-not-writable",
		});
	});

	test("a chosen path that is an existing directory is 'invalid' at once: no part file, no export that fails at the end", async () => {
		const { sessions } = createSessions();
		fs.mkdirSync(path.join(dir, "movie.mp4"));
		expect(await sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => path.join(dir, "movie.mp4") })).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(list()).toEqual(["movie.mp4"]);
		await beginAt({ sessions, name: "other.mp4" }); // and the manager is not stuck
	});

	test("a long chosen name: while name + .ccut-part fits in 255 bytes the part file is named that; one byte more and it gets a short hidden name", async () => {
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		const cases = [
			{ name: `${"a".repeat(241)}.mp4`, part: `${"a".repeat(241)}.mp4.ccut-part` }, // 245 + 10 = 255 bytes: still fits
			{ name: `${"a".repeat(242)}.mp4`, part: ".ccut-0a1b2c3d.part" }, // 256
			{ name: `${"a".repeat(251)}.mp4`, part: ".ccut-0a1b2c3d.part" }, // 255-byte final name: fine as a name
			{ name: `${"中".repeat(82)}.mp4`, part: ".ccut-0a1b2c3d.part" }, // 250 bytes in 86 characters
			{ name: `${"中".repeat(80)}.mp4`, part: `${"中".repeat(80)}.mp4.ccut-part` }, // 244 + 10 = 254
		];
		for (const { name, part } of cases) {
			const { sessions } = createSessions();
			const { token, displayName } = await beginAt({ sessions, name });
			expect(displayName).toBe(name);
			expect(list()).toEqual([part]);
			await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
			// Still renamed over the chosen name.
			expect(await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length })).toEqual({ displayName: name, bytes: reference.length });
			expect(list()).toEqual([name]);
			fs.rmSync(path.join(dir, name));
		}
	});

	test("the short part name is created exclusively (wx+) like any other: a leftover of that name is replaced once, a directory refuses", async () => {
		const opened = [];
		const fsApi = {
			...fsp,
			open: (target, flags, ...rest) => {
				opened.push(flags);
				return fsp.open(target, flags, ...rest);
			},
		};
		const { sessions } = createSessions({ fsApi });
		const name = `${"a".repeat(250)}.mp4`;
		fs.writeFileSync(path.join(dir, ".ccut-0a1b2c3d.part"), "stale");
		const { token } = await beginAt({ sessions, name });
		expect(opened).toEqual(["wx+", "wx+"]); // exclusive create, refused once by the leftover, then again
		expect(fs.readFileSync(path.join(dir, ".ccut-0a1b2c3d.part"), "utf8")).toBe("");
		await sessions.abort({ ownerId: OWNER, token });
		expect(list()).toEqual([]);

		fs.mkdirSync(path.join(dir, ".ccut-0a1b2c3d.part"));
		expect(await sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => path.join(dir, name) })).toEqual({ ok: false, reason: "dir-not-writable" });
	});

	test("a final name over 255 bytes (extension included) is 'name-too-long', not dir-not-writable; nothing is created", async () => {
		const { sessions } = createSessions();
		for (const chosen of [`${"a".repeat(252)}.mp4`, `${"a".repeat(252)}`, `${"中".repeat(86)}`, `${"a".repeat(1000)}.mp4`]) {
			expect(await sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => path.join(dir, chosen) })).toEqual({
				ok: false,
				reason: "name-too-long",
			});
		}
		expect(list()).toEqual([]);
		// The same bytes on a Windows path.
		const win = createSessions({ pathApi: path.win32 });
		expect(await win.sessions.begin({ ownerId: OWNER, container: "webm", choosePath: async () => `C:\\Users\\a\\${"a".repeat(251)}.webm` })).toEqual({
			ok: false,
			reason: "name-too-long",
		});
	});

	test("the file system's own ENAMETOOLONG (a path that is too long as a whole) is 'name-too-long'; other refusals stay dir-not-writable", async () => {
		const failing = (code) => ({ ...fsp, open: async () => { throw Object.assign(new Error("x"), { code }); } });
		expect(
			await createSessions({ fsApi: failing("ENAMETOOLONG") }).sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => path.join(dir, "a.mp4") }),
		).toEqual({ ok: false, reason: "name-too-long" });
		for (const code of ["EACCES", "ENOENT", "EROFS", undefined]) {
			expect(await createSessions({ fsApi: failing(code) }).sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => path.join(dir, "a.mp4") })).toEqual({
				ok: false,
				reason: "dir-not-writable",
			});
		}
	});

	test("a leftover part file is replaced; a symlink in its place is removed, its target untouched", async () => {
		const { sessions } = createSessions();
		fs.writeFileSync(path.join(dir, "a.mp4.ccut-part"), "stale");
		const elsewhere = path.join(dir, "victim.txt");
		fs.writeFileSync(elsewhere, "keep me");
		fs.symlinkSync(elsewhere, path.join(dir, "b.mp4.ccut-part"));

		const a = await beginAt({ sessions, name: "a.mp4" });
		expect(fs.readFileSync(path.join(dir, "a.mp4.ccut-part"), "utf8")).toBe("");
		await sessions.abort({ ownerId: OWNER, token: a.token });

		const b = await beginAt({ sessions, name: "b.mp4" });
		await sessions.write({ ownerId: OWNER, token: b.token, position: 0, data: new Uint8Array([1, 2, 3]) });
		expect(fs.readFileSync(elsewhere, "utf8")).toBe("keep me");
		expect(fs.lstatSync(path.join(dir, "b.mp4.ccut-part")).isSymbolicLink()).toBe(false);
		await sessions.abort({ ownerId: OWNER, token: b.token });
		expect(list()).toEqual(["victim.txt"]);
	});

	test("a directory where the part file should be is not deleted: dir-not-writable", async () => {
		const { sessions } = createSessions();
		fs.mkdirSync(path.join(dir, "a.mp4.ccut-part"));
		expect(await sessions.begin({ ownerId: OWNER, container: "mp4", choosePath: async () => path.join(dir, "a.mp4") })).toEqual({
			ok: false,
			reason: "dir-not-writable",
		});
		expect(fs.statSync(path.join(dir, "a.mp4.ccut-part")).isDirectory()).toBe(true);
	});

	test("a final path that is a symlink: the link is replaced by the file, its target is never written", async () => {
		const { sessions } = createSessions();
		const victim = path.join(dir, "victim.mp4");
		fs.writeFileSync(victim, "keep me");
		fs.symlinkSync(victim, path.join(dir, "link.mp4"));
		const { token } = await beginAt({ sessions, name: "link.mp4" });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
		expect(fs.readFileSync(victim, "utf8")).toBe("keep me");
		expect(fs.lstatSync(path.join(dir, "link.mp4")).isSymbolicLink()).toBe(false);
	});
});

describe("ExportSessions: hostile writes", () => {
	async function openSession(options) {
		const { sessions } = createSessions(options);
		const { token } = await beginAt({ sessions });
		return { sessions, token };
	}

	test("a hole (position past everything written) is refused and ends the session, part file deleted", async () => {
		const { sessions, token } = await openSession();
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(10) });
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 11, data: new Uint8Array(1) }))).toBe("CCUT_EXPORT:INVALID");
		expect(list()).toEqual([]);
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(1) }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
	});

	test("bad positions: negative, fractional, NaN, huge, strings", async () => {
		for (const position of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "0", null, undefined]) {
			const { sessions, token } = await openSession();
			expect(await rejection(sessions.write({ ownerId: OWNER, token, position, data: new Uint8Array(1) }))).toBe("CCUT_EXPORT:INVALID");
			expect(list()).toEqual([]);
		}
	});

	test("data must be a Uint8Array of at most 32 MiB", async () => {
		for (const data of ["text", [1, 2, 3], new ArrayBuffer(4), new Uint16Array(2), null, { byteLength: 1 }]) {
			const { sessions, token } = await openSession();
			expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 0, data }))).toBe("CCUT_EXPORT:INVALID");
		}
		const { sessions, token } = await openSession();
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(LIMITS.maxChunkBytes + 1) }))).toBe(
			"CCUT_EXPORT:INVALID",
		);
		const fine = await openSession();
		await fine.sessions.write({ ownerId: OWNER, token: fine.token, position: 0, data: new Uint8Array(LIMITS.maxChunkBytes) });
		await fine.sessions.abort({ ownerId: OWNER, token: fine.token });
	});

	test("a renderer that floods writes without waiting is refused once 64 MiB are pending: no unbounded buffering", async () => {
		const { sessions, token } = await openSession();
		const chunk = new Uint8Array(LIMITS.maxChunkBytes);
		const outcomes = [0, 1, 2].map((i) => rejection(sessions.write({ ownerId: OWNER, token, position: i * chunk.length, data: chunk })));
		const results = await Promise.all(outcomes);
		expect(results[2]).toBe("CCUT_EXPORT:INVALID");
		expect(list()).toEqual([]);
	});

	test("waiting for each write, any amount goes through (pending bytes are released)", async () => {
		const { sessions, token } = await openSession();
		const chunk = new Uint8Array(LIMITS.maxChunkBytes);
		for (let i = 0; i < 4; i++) await sessions.write({ ownerId: OWNER, token, position: i * chunk.length, data: chunk });
		await sessions.abort({ ownerId: OWNER, token });
	});

	test("the total size cap holds, even for writes that start inside the file", async () => {
		const { sessions, token } = await openSession({ limits: { maxTotalBytes: 100 } });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(100) });
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 99, data: new Uint8Array(2) }))).toBe("CCUT_EXPORT:INVALID");
		expect(list()).toEqual([]);
	});

	test("another window's token, an unknown token or a non-string token is refused, and the owner's session goes on", async () => {
		const { sessions, token } = await openSession();
		for (const [ownerId, t] of [
			[99, token],
			[OWNER, "token-999"],
			[OWNER, 1],
			[OWNER, { toString: () => token }],
		]) {
			expect(await rejection(sessions.write({ ownerId, token: t, position: 0, data: new Uint8Array(1) }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
			expect(await rejection(sessions.abort({ ownerId, token: t }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
			expect(await rejection(sessions.finish({ ownerId, token: t, totalBytes: 1 }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
		}
		expect(list()).toEqual(["clip.mp4.ccut-part"]);
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(1) });
	});

	test("write after abort, write after finish, finish twice, abort twice: all refused; the finished file stays", async () => {
		const { sessions, token } = await openSession();
		await sessions.abort({ ownerId: OWNER, token });
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(1) }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
		expect(await rejection(sessions.abort({ ownerId: OWNER, token }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");

		const second = await beginAt({ sessions, name: "done.mp4" });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token: second.token, position: 0, data: reference });
		await sessions.finish({ ownerId: OWNER, token: second.token, totalBytes: reference.length });
		expect(await rejection(sessions.finish({ ownerId: OWNER, token: second.token, totalBytes: reference.length }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
		expect(await rejection(sessions.write({ ownerId: OWNER, token: second.token, position: 0, data: new Uint8Array(1) }))).toBe(
			"CCUT_EXPORT:UNKNOWN_SESSION",
		);
		expect(await rejection(sessions.abort({ ownerId: OWNER, token: second.token }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
		expect(list()).toEqual(["done.mp4"]);
	});

	test("an abort while writes are queued: the queued writes are refused, nothing is left on disk", async () => {
		const { sessions, token } = await openSession();
		const writes = [];
		for (let i = 0; i < 20; i++) writes.push(rejection(sessions.write({ ownerId: OWNER, token, position: i * 1000, data: new Uint8Array(1000) })));
		await sessions.abort({ ownerId: OWNER, token });
		const outcomes = await Promise.all(writes);
		expect(outcomes.every((o) => o === "resolved" || o === "CCUT_EXPORT:UNKNOWN_SESSION")).toBe(true);
		expect(outcomes).toContain("CCUT_EXPORT:UNKNOWN_SESSION");
		expect(list()).toEqual([]);
	});

	test("a write that hits a full disk ends the session as DISK_FULL; later writes are refused; nothing is left", async () => {
		const wrapHandle = (handle) => createFailingHandle({ handle, failAfterBytes: 1500 });
		const { sessions, token } = await openSession({ wrapHandle });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(1000) });
		const second = rejection(sessions.write({ ownerId: OWNER, token, position: 1000, data: new Uint8Array(1000) }));
		const third = rejection(sessions.write({ ownerId: OWNER, token, position: 2000, data: new Uint8Array(1000) }));
		expect(await second).toBe("CCUT_EXPORT:DISK_FULL");
		expect(await third).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
		expect(list()).toEqual([]);
		expect(await rejection(sessions.finish({ ownerId: OWNER, token, totalBytes: 1000 }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
	});

	test("any other write error is WRITE_FAILED, with no system text or path in the message", async () => {
		const wrapHandle = (handle) => ({
			...handle,
			fd: handle.fd,
			write: async () => {
				throw Object.assign(new Error(`EIO: i/o error, write '${dir}/secret'`), { code: "EIO" });
			},
			close: () => handle.close(),
		});
		const { sessions, token } = await openSession({ wrapHandle });
		const message = await rejection(sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(10) }));
		expect(message).toBe("CCUT_EXPORT:WRITE_FAILED");
		expect(list()).toEqual([]);
	});
});

describe("ExportSessions: finish", () => {
	test("a size that is not what was written fails VERIFY_FAILED and deletes the part file; no final file", async () => {
		for (const delta of [-1, 1]) {
			const { sessions } = createSessions();
			const { token } = await beginAt({ sessions });
			const reference = await fileBytes({ container: "mp4", packets: 5 });
			await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
			expect(await rejection(sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length + delta }))).toBe("CCUT_EXPORT:VERIFY_FAILED");
			expect(list()).toEqual([]);
		}
	});

	test("a complete file followed by extra bytes, finished with the file's size, fails: the tail would stay in the file", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		await sessions.write({ ownerId: OWNER, token, position: reference.length, data: new Uint8Array(10).fill(0x41) });
		expect(await rejection(sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length }))).toBe("CCUT_EXPORT:VERIFY_FAILED");
		expect(list()).toEqual([]);
	});

	test("bytes that are not a complete file of the container fail VERIFY_FAILED: no final file", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		const cut = reference.slice(0, reference.length - 50);
		await sessions.write({ ownerId: OWNER, token, position: 0, data: cut });
		expect(await rejection(sessions.finish({ ownerId: OWNER, token, totalBytes: cut.length }))).toBe("CCUT_EXPORT:VERIFY_FAILED");
		expect(list()).toEqual([]);
	});

	test("a WebM's bytes in a session opened as MP4 fail", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		const webm = await fileBytes({ container: "webm", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: webm });
		expect(await rejection(sessions.finish({ ownerId: OWNER, token, totalBytes: webm.length }))).toBe("CCUT_EXPORT:VERIFY_FAILED");
		expect(list()).toEqual([]);
	});

	test("rename locked (Windows EBUSY): 5 tries 200 ms apart, then a free 'name (1)' that is returned as the real name", async () => {
		let renames = 0;
		const fsApi = {
			...fsp,
			rename: async (from, to) => {
				renames++;
				if (to.endsWith("clip.mp4")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
				return fsp.rename(from, to);
			},
		};
		const { sessions, sleeps } = createSessions({ fsApi });
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		expect(await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length })).toEqual({ displayName: "clip (1).mp4", bytes: reference.length });
		expect(renames).toBe(6);
		expect(sleeps).toEqual([200, 200, 200, 200]);
		expect(list()).toEqual(["clip (1).mp4"]);
		expect(sessions.revealPath({ ownerId: OWNER, token })).toBe(path.join(dir, "clip (1).mp4"));
	});

	test("rename failing for another reason is WRITE_FAILED at once, part file deleted", async () => {
		const fsApi = { ...fsp, rename: async () => { throw Object.assign(new Error("x"), { code: "EXDEV" }); } };
		const { sessions, sleeps } = createSessions({ fsApi });
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		expect(await rejection(sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length }))).toBe("CCUT_EXPORT:WRITE_FAILED");
		expect(sleeps).toEqual([]);
		expect(list()).toEqual([]);
	});

	test("overwriting a file the user confirmed keeps that file's permissions (the part file would be 0666 minus umask)", async () => {
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		const control = path.join(dir, "control.txt");
		fs.writeFileSync(control, "");
		const defaultMode = fs.statSync(control).mode & 0o777;
		for (const mode of [0o600, 0o640, 0o755, 0o400]) {
			const { sessions } = createSessions();
			const target = path.join(dir, "old.mp4");
			fs.writeFileSync(target, "the old video");
			fs.chmodSync(target, mode);
			const { token } = await beginAt({ sessions, name: "old.mp4" });
			await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
			await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
			expect(fs.statSync(target).mode & 0o777).toBe(mode);
			expect(Buffer.compare(fs.readFileSync(target), Buffer.from(reference))).toBe(0);
			fs.chmodSync(target, 0o600);
			fs.rmSync(target);
		}
		// A new file is nobody's to preserve: it gets the ordinary default.
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions, name: "new.mp4" });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
		expect(fs.statSync(path.join(dir, "new.mp4")).mode & 0o777).toBe(defaultMode);
	});

	test("only the permission bits are copied: the file type, setuid, setgid and sticky never carry over to the new file", async () => {
		// Fake stat: bun's own chmod drops setuid, so what is asked of the handle is what is checked.
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		for (const [mode, expected] of [
			[0o104755, 0o755],
			[0o102750, 0o750],
			[0o101777, 0o777],
			[0o100600, 0o600],
		]) {
			const asked = [];
			const fsApi = {
				...fsp,
				lstat: async (target) =>
					target === path.join(dir, "old.mp4")
						? { mode, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
						: fsp.lstat(target),
			};
			const wrapHandle = (handle) =>
				passthrough(handle, {
					chmod: async (real, bits) => {
						asked.push(bits);
						return real.chmod(bits & 0o777);
					},
				});
			const { sessions } = createSessions({ fsApi, wrapHandle });
			const { token } = await beginAt({ sessions, name: "old.mp4" });
			await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
			await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
			expect(asked).toEqual([expected]);
			fs.rmSync(path.join(dir, "old.mp4"));
		}
	});

	test("a symlink at the chosen path is replaced by a file with the ordinary default mode, not the link's 0777", async () => {
		const control = path.join(dir, "control.txt");
		fs.writeFileSync(control, "");
		const defaultMode = fs.statSync(control).mode & 0o777;
		const victim = path.join(dir, "victim.mp4");
		fs.writeFileSync(victim, "keep me");
		fs.chmodSync(victim, 0o600);
		fs.symlinkSync(victim, path.join(dir, "link.mp4"));
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions, name: "link.mp4" });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
		expect(fs.lstatSync(path.join(dir, "link.mp4")).isSymbolicLink()).toBe(false);
		expect(fs.statSync(path.join(dir, "link.mp4")).mode & 0o777).toBe(defaultMode);
		expect(fs.statSync(victim).mode & 0o777).toBe(0o600); // the link's target is untouched
	});

	test("the test seam's failing handle passes the permission copy on to the real file too", async () => {
		const { sessions } = createSessions({ wrapHandle: (handle) => createFailingHandle({ handle, failAfterBytes: 1_000_000 }) });
		const target = path.join(dir, "old.mp4");
		fs.writeFileSync(target, "old");
		fs.chmodSync(target, 0o600);
		const { token } = await beginAt({ sessions, name: "old.mp4" });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
	});

	test("a permission that cannot be copied does not fail an export that is otherwise complete", async () => {
		const wrapHandle = (handle) =>
			passthrough(handle, {
				chmod: async () => {
					throw Object.assign(new Error("EPERM"), { code: "EPERM" });
				},
			});
		const { sessions } = createSessions({ wrapHandle });
		fs.writeFileSync(path.join(dir, "old.mp4"), "old");
		const { token } = await beginAt({ sessions, name: "old.mp4" });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		expect(await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length })).toEqual({ displayName: "old.mp4", bytes: reference.length });
		expect(Buffer.compare(fs.readFileSync(path.join(dir, "old.mp4")), Buffer.from(reference))).toBe(0);
	});

	test("a write that arrives while finish is checking the file is refused and never enters the file", async () => {
		const reading = gate();
		const release = gate();
		const wrapHandle = (handle) =>
			passthrough(handle, {
				read: async (real, ...args) => {
					reading.open();
					await release.passed; // finish is now verifying: state is 'finishing'
					return real.read(...args);
				},
			});
		const { sessions } = createSessions({ wrapHandle });
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });

		const finishing = rejection(sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length }));
		await reading.passed;
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(8).fill(0xee) }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
		release.open();
		expect(await finishing).toBe("resolved");
		expect(Buffer.compare(fs.readFileSync(path.join(dir, "clip.mp4")), Buffer.from(reference))).toBe(0);
	});

	test("an abort that lands while finish is closing the file wins: finish says UNKNOWN_SESSION, nothing is renamed into place", async () => {
		const closing = gate();
		const release = gate();
		const wrapHandle = (handle) =>
			passthrough(handle, {
				close: async (real) => {
					closing.open();
					await release.passed;
					return real.close();
				},
			});
		const { sessions } = createSessions({ wrapHandle });
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });

		const finishing = rejection(sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length }));
		await closing.passed;
		const aborting = sessions.abort({ ownerId: OWNER, token });
		release.open();
		await aborting;
		expect(await finishing).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
		expect(list()).toEqual([]);
		expect(sessions.revealPath({ ownerId: OWNER, token })).toBeNull();
	});

	test("finish waits for writes still in the queue", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		void sessions.write({ ownerId: OWNER, token, position: 0, data: reference.slice(0, 100) });
		void sessions.write({ ownerId: OWNER, token, position: 100, data: reference.slice(100) });
		expect((await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length })).bytes).toBe(reference.length);
	});
});

describe("ExportSessions: lifetime", () => {
	const HOUR = 60 * 60 * 1000;
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	test("an abandoned session (no write for more than 6 hours) is dropped and its part file deleted; a slow live export is not dropped by 15 minutes or 5 hours of quiet", async () => {
		let clock = 0;
		const { sessions } = createSessions({ now: () => clock });
		const { token } = await beginAt({ sessions });
		for (const quiet of [20 * 60 * 1000, 5 * HOUR]) {
			clock = quiet;
			sessions.sweep();
			await settle();
			expect(list()).toEqual(["clip.mp4.ccut-part"]);
		}
		clock = 6 * HOUR + 1;
		sessions.sweep();
		await settle();
		expect(list()).toEqual([]);
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(1) }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
		await beginAt({ sessions, name: "next.mp4" }); // no longer busy
	});

	test("a write counts as activity: the idle clock runs from the last one", async () => {
		let clock = 0;
		const { sessions } = createSessions({ now: () => clock });
		const { token } = await beginAt({ sessions });
		clock = 6 * HOUR - 1000;
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(10) });
		clock = 6 * HOUR + 1000; // 2 s since the write, over 6 h since begin
		sessions.sweep();
		await settle();
		expect(list()).toEqual(["clip.mp4.ccut-part"]);
		clock = 12 * HOUR + 1000;
		sessions.sweep();
		await settle();
		expect(list()).toEqual([]);
	});

	test("a write that takes a long time to reach the disk counts as activity when it does", async () => {
		let clock = 0;
		const wrapHandle = (handle) =>
			passthrough(handle, {
				write: async (real, ...args) => {
					clock = 11 * HOUR; // a very slow disk: the write ends 11 hours in
					return real.write(...args);
				},
			});
		const { sessions } = createSessions({ now: () => clock, wrapHandle });
		const { token } = await beginAt({ sessions });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(10) });
		clock = 16 * HOUR; // 5 h after the write ended, 16 h after begin
		sessions.sweep();
		await settle();
		expect(list()).toEqual(["clip.mp4.ccut-part"]);
	});

	test("the renderer's keepalive, a zero-length write, is accepted at any point, keeps the session alive and adds nothing to the file", async () => {
		let clock = 0;
		const { sessions } = createSessions({ now: () => clock });
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		const keepalive = () => sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(0) });
		await keepalive(); // before anything was written: position 0 is not a hole
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference.slice(0, 100) });
		for (let hours = 5; hours <= 20; hours += 5) {
			clock = hours * HOUR;
			await keepalive();
			sessions.sweep();
			await settle();
			expect(list()).toEqual(["clip.mp4.ccut-part"]);
		}
		await sessions.write({ ownerId: OWNER, token, position: 100, data: reference.slice(100) });
		await keepalive();
		expect(await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length })).toEqual({ displayName: "clip.mp4", bytes: reference.length });
		expect(Buffer.compare(fs.readFileSync(path.join(dir, "clip.mp4")), Buffer.from(reference))).toBe(0);
	});

	test("a keepalive after finish has started, or after the end, is refused like any write", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
		await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(0) }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
	});

	test("reveal: only for a completed session of the same window, at most 5 kept, for an hour", async () => {
		let clock = 0;
		const { sessions } = createSessions({ now: () => clock });
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		const tokens = [];
		for (let i = 0; i < 7; i++) {
			const { token } = await beginAt({ sessions, name: `v${i}.mp4` });
			expect(sessions.revealPath({ ownerId: OWNER, token })).toBeNull(); // not completed yet
			await sessions.write({ ownerId: OWNER, token, position: 0, data: reference });
			await sessions.finish({ ownerId: OWNER, token, totalBytes: reference.length });
			tokens.push(token);
		}
		expect(tokens.map((token) => sessions.revealPath({ ownerId: OWNER, token }) !== null)).toEqual([false, false, true, true, true, true, true]);
		expect(sessions.revealPath({ ownerId: 99, token: tokens[6] })).toBeNull();
		expect(sessions.revealPath({ ownerId: OWNER, token: 42 })).toBeNull();
		clock = LIMITS.completedMs + 1;
		expect(sessions.revealPath({ ownerId: OWNER, token: tokens[6] })).toBeNull();
	});

	test("abortOwner (page reload, window closed) deletes that window's part file", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(10) });
		await sessions.abortOwner(OWNER);
		expect(list()).toEqual([]);
		expect(await rejection(sessions.write({ ownerId: OWNER, token, position: 10, data: new Uint8Array(1) }))).toBe("CCUT_EXPORT:UNKNOWN_SESSION");
	});

	test("abortOwner forgets that window's completed exports (no 'show in folder' for a page that is gone) and keeps another window's", async () => {
		const { sessions } = createSessions();
		const reference = await fileBytes({ container: "mp4", packets: 5 });
		const tokens = {};
		for (const ownerId of [OWNER, 99]) {
			const { token } = await beginAt({ sessions, name: `v${ownerId}.mp4`, ownerId });
			await sessions.write({ ownerId, token, position: 0, data: reference });
			await sessions.finish({ ownerId, token, totalBytes: reference.length });
			tokens[ownerId] = token;
		}
		expect(sessions.revealPath({ ownerId: OWNER, token: tokens[OWNER] })).toBe(path.join(dir, `v${OWNER}.mp4`));
		await sessions.abortOwner(OWNER);
		expect(sessions.revealPath({ ownerId: OWNER, token: tokens[OWNER] })).toBeNull();
		expect(sessions.revealPath({ ownerId: 99, token: tokens[99] })).toBe(path.join(dir, "v99.mp4"));
		expect(list()).toEqual(["v7.mp4", "v99.mp4"]); // finished files are the user's: never deleted
	});

	test("abortAllSync (quit) closes and deletes every part file synchronously", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions });
		await sessions.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(10) });
		sessions.abortAllSync({ closeSync: fs.closeSync, unlinkSync: fs.unlinkSync });
		expect(list()).toEqual([]);
		await beginAt({ sessions, name: "after.mp4" });
	});
});

describe("2 GB of synthetic writes through the sessions (opt-in: EXPORT_BIG=1)", () => {
	test.skipIf(!process.env.EXPORT_BIG)("main-side memory stays flat while 2 GiB stream to disk", async () => {
		const { sessions } = createSessions();
		const { token } = await beginAt({ sessions, name: "big.mp4" });
		const chunk = new Uint8Array(16 * 1024 * 1024).fill(7);
		const before = process.memoryUsage().rss;
		let peak = before;
		for (let i = 0; i < 128; i++) {
			await sessions.write({ ownerId: OWNER, token, position: i * chunk.length, data: chunk });
			peak = Math.max(peak, process.memoryUsage().rss);
		}
		console.log(`RSS before ${(before / 2 ** 20).toFixed(0)} MiB, peak ${(peak / 2 ** 20).toFixed(0)} MiB`);
		await sessions.abort({ ownerId: OWNER, token });
		expect(peak - before).toBeLessThan(150 * 2 ** 20);
	}, 300_000);
});
