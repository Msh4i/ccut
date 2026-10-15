// Main-process logic of the "export to disk" IPC (export-v2 plan, sections P2 and d).
// Pure or file-system-injected only: no `electron` import, so bun can test all of it.
// export-ipc.js wires it to ipcMain, the save dialog and the shell.
const crypto = require("node:crypto");
const path = require("node:path");

const CONTAINERS = Object.freeze({ mp4: ".mp4", webm: ".webm" });
const PART_SUFFIX = ".ccut-part";
const FALLBACK_NAME = "export";
const MAX_BASE_NAME_CHARS = 120;
// A file name component is limited to 255 BYTES (UTF-8; Windows counts UTF-16 units, never more).
// The base name leaves room for ".webm" and for the part file's ".ccut-part" on top.
const MAX_BASE_NAME_BYTES = 200;
const MAX_NAME_COMPONENT_BYTES = 255;
const MAX_SUGGESTED_NAME_CHARS = 1000;
const MAX_UNIQUE_ATTEMPTS = 99;

const LIMITS = Object.freeze({
	maxChunkBytes: 32 * 1024 * 1024,
	// Bytes accepted but not yet on disk. The renderer waits for each write, so it has
	// at most one in flight; a renderer that floods writes is refused, not buffered.
	maxPendingBytes: 64 * 1024 * 1024,
	maxTotalBytes: 1024 ** 4, // 1 TiB
	// Only an abandoned session expires (its window is gone without the page having been
	// reloaded or closed, which abortOwner handles). The renderer sends a zero-length write
	// every minute while an export runs, but an export that waits for the user (unreadable
	// audio) or encodes one slow frame for minutes must never be cut off by this clock.
	idleMs: 6 * 60 * 60 * 1000,
	completedMs: 60 * 60 * 1000,
	maxCompleted: 5,
	renameAttempts: 5,
	renameDelayMs: 200,
});

// Error codes sent to the renderer. The message is "CCUT_EXPORT:<CODE>" and nothing
// else: no path, no system error text (section d.8).
const CODES = Object.freeze([
	"FORBIDDEN",
	"INVALID",
	"UNKNOWN_SESSION",
	"DISK_FULL",
	"WRITE_FAILED",
	"VERIFY_FAILED",
]);

class ExportIpcError extends Error {
	constructor(code) {
		super(`CCUT_EXPORT:${code}`);
		this.name = "ExportIpcError";
		this.code = code;
	}
}

const fail = (code) => {
	throw new ExportIpcError(code);
};

// Characters Windows refuses in a file name, plus both separators on every platform.
const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g;
// C0/C1 controls and the invisible direction marks that can disguise an extension
// ("clip‮4pm.exe" shows as "clipexe.mp4").
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

function isWindowsReserved(name) {
	// "nul.txt" and "NUL .mp4" are the device too: Windows looks at the part before the first dot, trimmed.
	const stem = name.split(".")[0].trimEnd();
	return WINDOWS_RESERVED.test(stem);
}

function truncateChars(text, max) {
	const chars = Array.from(text); // code points: never split a surrogate pair
	return chars.length > max ? chars.slice(0, max).join("") : text;
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");

/** The longest start of `text` that is at most `max` UTF-8 bytes, cut between code points. */
function truncateBytes(text, max) {
	if (byteLength(text) <= max) return text;
	let bytes = 0;
	let kept = "";
	for (const char of text) {
		bytes += byteLength(char);
		if (bytes > max) break;
		kept += char;
	}
	return kept;
}

/**
 * Turns the renderer's suggested name (the project name, untrusted) into one plain file
 * name: no directory, no drive, no `..`, no control or direction characters, no Windows
 * device name, no leading or trailing dots or spaces, at most 120 characters and 200 UTF-8
 * bytes (a name component may be 255 bytes; the extension and ".ccut-part" come on top).
 * Never empty.
 */
function sanitizeBaseName(input) {
	if (typeof input !== "string") return FALLBACK_NAME;
	let name = truncateChars(input, MAX_SUGGESTED_NAME_CHARS).normalize("NFC");
	name = name.replace(INVISIBLE_CHARS, "");
	// Path segments that are only dots ("..", ".") carry no name: dropped, the rest joined.
	name = name
		.split(/[/\\]/)
		.filter((segment) => !/^[\s.]*$/.test(segment))
		.join("-");
	name = name.replace(FORBIDDEN_CHARS, "-");
	name = name.replace(/\.{2,}/g, ".");
	name = name.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
	name = truncateBytes(truncateChars(name, MAX_BASE_NAME_CHARS), MAX_BASE_NAME_BYTES).replace(/[\s.]+$/, "");
	if (name === "" || /^-+$/.test(name)) return FALLBACK_NAME;
	if (isWindowsReserved(name)) name = `_${name}`;
	return name;
}

function extensionOf(container) {
	if (typeof container !== "string" || !Object.hasOwn(CONTAINERS, container)) fail("INVALID");
	return CONTAINERS[container];
}

/** `name` ending in the container's extension: "clip" -> "clip.mp4", "x.exe" -> "x.exe.mp4", "a.MP4" stays. */
function forceExtension(name, container) {
	const ext = extensionOf(container);
	return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

/** "clip.mp4" -> "clip (1).mp4", "clip (2).mp4", ... the first that `exists` says is free. */
async function uniqueName({ dir, base, exists, pathApi = path }) {
	const ext = pathApi.extname(base);
	const stem = base.slice(0, base.length - ext.length);
	for (let n = 1; n <= MAX_UNIQUE_ATTEMPTS; n++) {
		const candidate = `${stem} (${n})${ext}`;
		if (!(await exists(pathApi.join(dir, candidate)))) return candidate;
	}
	return fail("WRITE_FAILED");
}

/**
 * The final path for what the save dialog returned. The dialog is the only source of a
 * path (the renderer never sends one), but its answer is still checked: absolute, no NUL,
 * a real file name, not an existing directory, and on Windows no alternate data stream and
 * no device-namespace path. The extension is forced; if forcing it produced a different name that
 * already exists, the user never confirmed overwriting THAT file, so a free name is used.
 */
async function resolveChosenPath({ chosenPath, container, exists, isDirectory = async () => false, pathApi = path }) {
	if (typeof chosenPath !== "string" || chosenPath.includes("\0") || !pathApi.isAbsolute(chosenPath)) {
		fail("INVALID");
	}
	if (pathApi === path.win32) {
		const slashed = chosenPath.replace(/\//g, "\\");
		// The device namespace ("\\.\PhysicalDrive0", "\\.\pipe\x") and the NT object root are not files.
		if (/^\\\\\.\\/.test(slashed) || /^\\\\\?\\globalroot(\\|$)/i.test(slashed)) fail("INVALID");
		// After the drive or share, a colon is an alternate data stream ("clip.mp4:payload.exe").
		if (chosenPath.slice(pathApi.parse(chosenPath).root.length).includes(":")) fail("INVALID");
	}
	const dir = pathApi.dirname(chosenPath);
	const chosenBase = pathApi.basename(chosenPath);
	if (chosenBase === "" || chosenBase === "." || chosenBase === "..") fail("INVALID");
	let base = forceExtension(chosenBase, container);
	if (pathApi === path.win32 && isWindowsReserved(base)) fail("INVALID");
	// A directory under the chosen name: the export would run to the end and fail at the rename.
	if (base === chosenBase && (await isDirectory(pathApi.join(dir, base)))) fail("INVALID");
	if (base !== chosenBase && (await exists(pathApi.join(dir, base)))) {
		base = await uniqueName({ dir, base, exists, pathApi });
	}
	return pathApi.join(dir, base);
}

/**
 * The test seam (section d): only an unpackaged build reads these variables. With
 * CCUT_TEST_EXPORT_DIR the save dialog is skipped and files go there;
 * CCUT_TEST_EXPORT_FAIL_AFTER_BYTES makes writes fail like a full disk after N bytes.
 */
function readSeamEnv({ isPackaged, env }) {
	if (isPackaged !== false) return null;
	const dir = env.CCUT_TEST_EXPORT_DIR;
	if (typeof dir !== "string" || dir === "" || !path.isAbsolute(dir)) return null;
	const raw = env.CCUT_TEST_EXPORT_FAIL_AFTER_BYTES;
	let failAfterBytes = null;
	if (typeof raw === "string" && /^\d+$/.test(raw)) failAfterBytes = Number(raw);
	return { dir, failAfterBytes };
}

/**
 * Only the app's own main frame may call the export IPC: the right window, its main frame
 * (not a sub-frame), and the app origin. `senderFrame` can be null (frame gone).
 */
function isTrustedSender({ event, webContents, origin }) {
	if (!event || !webContents || event.sender !== webContents) return false;
	const frame = event.senderFrame;
	if (!frame || frame !== webContents.mainFrame) return false;
	try {
		// Not URL.origin: for a custom scheme like ccut: Node's URL gives the opaque origin "null".
		const url = new URL(frame.url);
		const expected = new URL(origin);
		return url.protocol === expected.protocol && url.host === expected.host && url.host !== "";
	} catch {
		return false;
	}
}

function mapFsError(error) {
	return error && (error.code === "ENOSPC" || error.code === "EDQUOT") ? "DISK_FULL" : "WRITE_FAILED";
}

/** Wraps a FileHandle so that writes past `failAfterBytes` fail with ENOSPC (test seam). */
function createFailingHandle({ handle, failAfterBytes }) {
	let written = 0;
	return {
		fd: handle.fd,
		async write(buffer, offset, length, position) {
			if (written + length > failAfterBytes) {
				const error = new Error("ENOSPC: no space left on device (test seam)");
				error.code = "ENOSPC";
				throw error;
			}
			written += length;
			return handle.write(buffer, offset, length, position);
		},
		read: (...args) => handle.read(...args),
		sync: () => handle.sync(),
		chmod: (...args) => handle.chmod(...args),
		close: () => handle.close(),
	};
}

// --- container check: a file cut short must never be renamed into place ---

async function readExactly({ readAt, position, length }) {
	const bytes = await readAt({ position, length });
	if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) return null;
	return bytes;
}

const fourCC = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

const MAX_TOP_LEVEL_BOXES = 10_000;

/** MP4: the top-level boxes tile the file exactly, the first is ftyp, moov and mdat exist. */
async function verifyMp4({ size, readAt }) {
	const types = [];
	let position = 0;
	while (position < size) {
		if (types.length >= MAX_TOP_LEVEL_BOXES || size - position < 8) return false;
		const header = await readExactly({ readAt, position, length: 8 });
		if (!header) return false;
		const view = new DataView(header.buffer, header.byteOffset, 8);
		let boxSize = view.getUint32(0);
		const type = fourCC(header, 4);
		let headerSize = 8;
		if (boxSize === 1) {
			if (size - position < 16) return false;
			const large = await readExactly({ readAt, position: position + 8, length: 8 });
			if (!large) return false;
			const big = new DataView(large.buffer, large.byteOffset, 8).getBigUint64(0);
			if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
			boxSize = Number(big);
			headerSize = 16;
		} else if (boxSize === 0) {
			// "Up to the end of the file": mediabunny never writes it, and with it a cut file would pass.
			return false;
		}
		if (boxSize < headerSize || position + boxSize > size) return false;
		types.push(type);
		position += boxSize;
	}
	return position === size && types[0] === "ftyp" && types.includes("moov") && types.includes("mdat");
}

/** An EBML variable-size integer at `at`: { length, value, unknown }, or null. */
function readVint(bytes, at) {
	const first = bytes[at];
	if (first === undefined || first === 0) return null;
	let length = 1;
	while (!(first & (0x80 >> (length - 1)))) length++;
	if (at + length > bytes.length) return null;
	let value = BigInt(first & (0xff >> length));
	let allOnes = value === BigInt((0xff >> length));
	for (let i = 1; i < length; i++) {
		value = (value << 8n) | BigInt(bytes[at + i]);
		if (bytes[at + i] !== 0xff) allOnes = false;
	}
	return { length, value, unknown: allOnes };
}

const EBML_ID = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const startsWith = (bytes, at, id) => id.every((byte, i) => bytes[at + i] === byte);

/** WebM: an EBML header, then one Segment of known size that ends exactly at the end of the file. */
async function verifyWebm({ size, readAt }) {
	const headLength = Math.min(size, 4096);
	if (headLength < 12) return false;
	const head = await readExactly({ readAt, position: 0, length: headLength });
	if (!head || !startsWith(head, 0, EBML_ID)) return false;
	const ebmlSize = readVint(head, 4);
	if (!ebmlSize || ebmlSize.unknown) return false;
	const segmentAt = 4 + ebmlSize.length + Number(ebmlSize.value);
	if (segmentAt + 12 > headLength || !startsWith(head, segmentAt, SEGMENT_ID)) return false;
	const segmentSize = readVint(head, segmentAt + 4);
	if (!segmentSize || segmentSize.unknown) return false;
	const end = BigInt(segmentAt + 4 + segmentSize.length) + segmentSize.value;
	return end === BigInt(size);
}

async function verifyContainer({ container, size, readAt }) {
	extensionOf(container);
	if (!Number.isSafeInteger(size) || size <= 0) return false;
	return container === "mp4" ? verifyMp4({ size, readAt }) : verifyWebm({ size, readAt });
}

// --- sessions ---

const isSafeNonNegative = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Export sessions of the main process. One open session at a time (a second `begin`
 * while a dialog is open or a session is writing is `busy`). A session is created only
 * from a path the save dialog returned, is bound to the webContents that began it, and
 * writes to `<final>.ccut-part`, which becomes the final file only after `finish` has
 * checked size and container. Every failure deletes the part file.
 *
 * deps: fs (node:fs/promises-like: open, unlink, rename, lstat), randomUUID, randomHex() ->
 * 8 hex digits (short part file names), now, sleep, wrapHandle(handle) -> handle (test seam),
 * pathApi (node:path or path.win32), limits.
 */
class ExportSessions {
	constructor(deps) {
		this.fs = deps.fs;
		this.randomUUID = deps.randomUUID;
		this.now = deps.now;
		this.sleep = deps.sleep;
		this.randomHex = deps.randomHex ?? (() => crypto.randomBytes(4).toString("hex"));
		this.wrapHandle = deps.wrapHandle ?? ((handle) => handle);
		this.pathApi = deps.pathApi ?? path;
		this.limits = { ...LIMITS, ...deps.limits };
		this.open = new Map(); // token -> session (open or finishing)
		this.completed = new Map(); // token -> { ownerId, finalPath, at }
		this.choosing = false;
		// Bumped by abortOwner: a dialog answered after its page reloaded or closed is void.
		this.ownerEpochs = new Map();
	}

	/** lstat, or null when nothing is there (a name too long for the file system names nothing). */
	async lstatOrNull(target) {
		try {
			return await this.fs.lstat(target);
		} catch (error) {
			if (error && (error.code === "ENOENT" || error.code === "ENAMETOOLONG")) return null;
			throw error;
		}
	}

	async exists(target) {
		return (await this.lstatOrNull(target)) !== null;
	}

	async isDirectory(target) {
		return (await this.lstatOrNull(target))?.isDirectory() === true; // a symlink is not followed: rename replaces the link
	}

	isBusy() {
		return this.choosing || this.open.size > 0;
	}

	/** `choosePath()` shows the save dialog (or the seam) and returns an absolute path or null. */
	async begin({ ownerId, container, choosePath }) {
		this.sweep();
		extensionOf(container);
		if (this.isBusy()) return { ok: false, reason: "busy" };
		this.choosing = true;
		const epoch = this.ownerEpochs.get(ownerId) ?? 0;
		let finalPath;
		let handle;
		let partPath;
		try {
			const chosen = await choosePath();
			if (chosen === null || chosen === undefined) return { ok: false, reason: "cancelled" };
			try {
				finalPath = await resolveChosenPath({
					chosenPath: chosen,
					container,
					exists: (target) => this.exists(target),
					isDirectory: (target) => this.isDirectory(target),
					pathApi: this.pathApi,
				});
			} catch {
				return { ok: false, reason: "invalid" };
			}
			// The final name (extension included) must fit the file system, or the rename at the end would fail.
			if (byteLength(this.pathApi.basename(finalPath)) > MAX_NAME_COMPONENT_BYTES) {
				return { ok: false, reason: "name-too-long" };
			}
			partPath = this.partPathFor(finalPath);
			const created = await this.createPart(partPath);
			if (!created.handle) return { ok: false, reason: created.reason };
			handle = created.handle;
			// The page that asked is gone (reloaded, closed) while the dialog was open.
			if ((this.ownerEpochs.get(ownerId) ?? 0) !== epoch) {
				try {
					await handle.close();
					await this.fs.unlink(partPath);
				} catch {}
				return { ok: false, reason: "cancelled" };
			}
		} finally {
			this.choosing = false;
		}

		const token = this.randomUUID();
		this.open.set(token, {
			token,
			ownerId,
			container,
			finalPath,
			partPath,
			handle: this.wrapHandle(handle),
			claimedEnd: 0, // end of the furthest write accepted into the queue
			writtenEnd: 0, // end of the furthest write that reached the disk
			pendingBytes: 0,
			queue: Promise.resolve(),
			state: "open",
			lastActivity: this.now(),
		});
		// The page gets the token and the name, never a path or what the disk has left.
		return { ok: true, token, displayName: this.pathApi.basename(finalPath) };
	}

	/**
	 * Where the part file goes: next to the final file as "<name>.ccut-part", or, when that
	 * name would be over 255 bytes, as ".ccut-<8 hex>.part" in the same directory. Either way
	 * it is renamed over the chosen name at the end.
	 */
	partPathFor(finalPath) {
		const base = this.pathApi.basename(finalPath);
		if (byteLength(`${base}${PART_SUFFIX}`) <= MAX_NAME_COMPONENT_BYTES) return `${finalPath}${PART_SUFFIX}`;
		return this.pathApi.join(this.pathApi.dirname(finalPath), `.ccut-${this.randomHex()}.part`);
	}

	/**
	 * Creates the part file exclusively; a leftover file (or link) of that name is removed once.
	 * { handle } or { reason: "name-too-long" | "dir-not-writable" }.
	 */
	async createPart(partPath) {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return { handle: await this.fs.open(partPath, "wx+") }; // read back by the container check
			} catch (error) {
				if (error && error.code === "ENAMETOOLONG") return { reason: "name-too-long" };
				if (!error || error.code !== "EEXIST" || attempt > 0) return { reason: "dir-not-writable" };
				try {
					const stat = await this.fs.lstat(partPath);
					if (!stat.isFile() && !stat.isSymbolicLink()) return { reason: "dir-not-writable" };
					await this.fs.unlink(partPath); // a link is removed itself, its target is untouched
				} catch {
					return { reason: "dir-not-writable" };
				}
			}
		}
		return { reason: "dir-not-writable" };
	}

	sessionFor({ ownerId, token }) {
		const session = typeof token === "string" ? this.open.get(token) : undefined;
		if (!session || session.ownerId !== ownerId) fail("UNKNOWN_SESSION");
		return session;
	}

	async write({ ownerId, token, position, data }) {
		this.sweep();
		const session = this.sessionFor({ ownerId, token });
		if (session.state !== "open") fail("UNKNOWN_SESSION");
		const valid =
			data instanceof Uint8Array &&
			data.byteLength <= this.limits.maxChunkBytes &&
			isSafeNonNegative(position) &&
			position <= session.claimedEnd && // no hole: mediabunny fills gaps itself
			position + data.byteLength <= this.limits.maxTotalBytes &&
			session.pendingBytes + data.byteLength <= this.limits.maxPendingBytes;
		if (!valid) {
			// A legitimate renderer never sends this: end the session at once.
			await this.discard(session);
			fail("INVALID");
		}
		session.claimedEnd = Math.max(session.claimedEnd, position + data.byteLength);
		session.pendingBytes += data.byteLength;
		const run = session.queue.then(async () => {
			// "finishing" still runs what was queued before finish; "aborted" runs nothing more.
			if (session.state !== "open" && session.state !== "finishing") fail("UNKNOWN_SESSION");
			try {
				let done = 0;
				// Bounded: each round writes at least one byte or throws.
				for (let round = 0; done < data.byteLength && round < data.byteLength; round++) {
					const { bytesWritten } = await session.handle.write(data, done, data.byteLength - done, position + done);
					if (!(bytesWritten > 0)) throw Object.assign(new Error("short write"), { code: "EIO" });
					done += bytesWritten;
				}
			} catch (error) {
				// This write IS the queue's head: waiting for the queue here would wait for itself.
				await this.discard(session, { waitForQueue: false });
				fail(mapFsError(error));
			}
			session.writtenEnd = Math.max(session.writtenEnd, position + data.byteLength);
			session.lastActivity = this.now(); // a write that reached the disk (the keepalive included) is activity
		}).finally(() => {
			session.pendingBytes -= data.byteLength;
		});
		// The queue goes on after a failure only to refuse what comes next.
		session.queue = run.catch(() => {});
		return run;
	}

	async finish({ ownerId, token, totalBytes }) {
		const session = this.sessionFor({ ownerId, token });
		if (session.state !== "open") fail("UNKNOWN_SESSION");
		session.state = "finishing";
		await session.queue;
		if (!this.open.has(token)) fail("WRITE_FAILED"); // a queued write failed and discarded it
		if (!isSafeNonNegative(totalBytes) || totalBytes !== session.writtenEnd) {
			await this.discard(session);
			fail("VERIFY_FAILED");
		}
		let verified = false;
		try {
			verified = await verifyContainer({
				container: session.container,
				size: totalBytes,
				readAt: async ({ position, length }) => {
					const buffer = new Uint8Array(length);
					const { bytesRead } = await session.handle.read(buffer, 0, length, position);
					return buffer.subarray(0, bytesRead);
				},
			});
		} catch {
			verified = false;
		}
		if (!verified) {
			await this.discard(session);
			fail("VERIFY_FAILED");
		}
		await this.keepTargetMode(session);
		try {
			await session.handle.sync();
			await session.handle.close();
			session.handle = null;
		} catch (error) {
			await this.discard(session);
			fail(mapFsError(error));
		}
		if (session.state !== "finishing") fail("UNKNOWN_SESSION"); // aborted meanwhile
		const finalPath = await this.renameIntoPlace(session);
		this.open.delete(token);
		session.state = "done";
		this.completed.set(token, { ownerId, finalPath, at: this.now() });
		this.trimCompleted();
		return { displayName: this.pathApi.basename(finalPath), bytes: totalBytes };
	}

	/**
	 * Overwriting a file the user confirmed: the new file keeps that file's permission bits (the part
	 * file was created with 0666 minus umask, so a private 0600 file would become world-readable).
	 * Best effort: a mode that cannot be copied does not fail an export that is complete.
	 */
	async keepTargetMode(session) {
		try {
			const existing = await this.fs.lstat(session.finalPath);
			if (existing.isFile()) await session.handle.chmod(existing.mode & 0o777);
		} catch {}
	}

	/** rename, retried for a Windows lock (EBUSY/EPERM), then once to a free "name (n)". */
	async renameIntoPlace(session) {
		let lastError;
		for (let attempt = 0; attempt < this.limits.renameAttempts; attempt++) {
			try {
				await this.fs.rename(session.partPath, session.finalPath);
				return session.finalPath;
			} catch (error) {
				lastError = error;
				if (!error || (error.code !== "EBUSY" && error.code !== "EPERM")) break;
				if (attempt < this.limits.renameAttempts - 1) await this.sleep(this.limits.renameDelayMs);
			}
		}
		if (lastError && (lastError.code === "EBUSY" || lastError.code === "EPERM")) {
			try {
				const dir = this.pathApi.dirname(session.finalPath);
				const base = await uniqueName({
					dir,
					base: this.pathApi.basename(session.finalPath),
					exists: (target) => this.exists(target),
					pathApi: this.pathApi,
				});
				const alternative = this.pathApi.join(dir, base);
				await this.fs.rename(session.partPath, alternative);
				return alternative;
			} catch (error) {
				lastError = error;
			}
		}
		await this.discard(session);
		return fail(mapFsError(lastError));
	}

	async abort({ ownerId, token }) {
		const session = this.sessionFor({ ownerId, token });
		await this.discard(session);
	}

	/** Ends a session for good: no more writes, file closed, part file deleted. Never throws. */
	async discard(session, { waitForQueue = true } = {}) {
		if (session.state === "aborted" || session.state === "done") return;
		session.state = "aborted";
		this.open.delete(session.token);
		if (waitForQueue) await session.queue;
		if (session.handle) {
			try {
				await session.handle.close();
			} catch {}
			session.handle = null;
		}
		try {
			await this.fs.unlink(session.partPath);
		} catch {}
	}

	/** The final path of a COMPLETED session of this owner, or null (reveal only). */
	revealPath({ ownerId, token }) {
		this.sweep();
		const done = typeof token === "string" ? this.completed.get(token) : undefined;
		return done && done.ownerId === ownerId ? done.finalPath : null;
	}

	async abortOwner(ownerId) {
		this.ownerEpochs.set(ownerId, (this.ownerEpochs.get(ownerId) ?? 0) + 1);
		const mine = [...this.open.values()].filter((session) => session.ownerId === ownerId);
		await Promise.all(mine.map((session) => this.discard(session)));
		for (const [token, done] of this.completed) if (done.ownerId === ownerId) this.completed.delete(token);
	}

	async abortAll() {
		await Promise.all([...this.open.values()].map((session) => this.discard(session)));
		this.completed.clear();
	}

	/** For quit: synchronous close + delete of every part file (the app will not wait for promises). */
	abortAllSync({ closeSync, unlinkSync }) {
		for (const session of this.open.values()) {
			session.state = "aborted";
			try {
				if (session.handle && Number.isInteger(session.handle.fd)) closeSync(session.handle.fd);
			} catch {}
			try {
				unlinkSync(session.partPath);
			} catch {}
		}
		this.open.clear();
		this.completed.clear();
	}

	/** Drops sessions idle for longer than `idleMs` and completed ones older than `completedMs`. */
	sweep() {
		const now = this.now();
		for (const session of this.open.values()) {
			if (session.state === "open" && now - session.lastActivity > this.limits.idleMs) {
				void this.discard(session);
			}
		}
		for (const [token, done] of this.completed) {
			if (now - done.at > this.limits.completedMs) this.completed.delete(token);
		}
	}

	trimCompleted() {
		const extra = this.completed.size - this.limits.maxCompleted;
		if (extra <= 0) return;
		const oldest = [...this.completed.keys()].slice(0, extra);
		for (const token of oldest) this.completed.delete(token);
	}
}

module.exports = {
	CODES,
	CONTAINERS,
	ExportIpcError,
	ExportSessions,
	LIMITS,
	MAX_NAME_COMPONENT_BYTES,
	MAX_SUGGESTED_NAME_CHARS,
	PART_SUFFIX,
	createFailingHandle,
	forceExtension,
	isTrustedSender,
	isWindowsReserved,
	readSeamEnv,
	resolveChosenPath,
	sanitizeBaseName,
	uniqueName,
	verifyContainer,
};
