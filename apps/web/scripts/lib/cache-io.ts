/**
 * Download and cache helpers shared by the asset generators
 * (generate-emoji.ts, generate-icons.ts).
 *
 * Two promises: a request never hangs (every attempt has a timeout), and an
 * interrupted run never leaves a half-written file where a later run would
 * trust it (writes go to a temporary file and are renamed into place).
 */

import { randomBytes } from "node:crypto";
import {
	mkdir,
	open,
	readdir,
	readFile,
	rename as fsRename,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 500;
/**
 * What one download may weigh. The sources are pinned GitHub files of a few MB
 * at most; the limit only has to stop a wrong or replaced URL from filling the
 * memory, so it is generous.
 */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;

/** `.<name>.<pid>.<8 hex>.tmp`: how writeFileAtomic names its temporary files. */
const TEMPORARY_FILE_PATTERN = /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/;

class HttpStatusError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

class ResponseTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`the response is larger than ${maxBytes} bytes`);
	}
}

/**
 * A client error will give the same answer again (only 408 and 429 are worth
 * another try), and so will a body that is too big.
 */
function isPermanentFailure({ error }: { error: unknown }): boolean {
	if (error instanceof ResponseTooLargeError) {
		return true;
	}
	return (
		error instanceof HttpStatusError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== HTTP_REQUEST_TIMEOUT &&
		error.status !== HTTP_TOO_MANY_REQUESTS
	);
}

/**
 * Reads the body as UTF-8 text, stopping as soon as it passes `maxBytes`
 * (counted after decompression, so a small compressed bomb is caught too).
 */
async function readBodyText({
	response,
	maxBytes,
}: {
	response: Response;
	maxBytes: number;
}): Promise<string> {
	const body = response.body;
	if (!body) {
		return "";
	}
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await body.cancel().catch(() => {});
		throw new ResponseTooLargeError(maxBytes);
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return text + decoder.decode();
		}
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new ResponseTooLargeError(maxBytes);
		}
		text += decoder.decode(value, { stream: true });
	}
}

export async function downloadText({
	url,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	attempts = DEFAULT_ATTEMPTS,
	retryDelayMs = DEFAULT_RETRY_DELAY_MS,
	maxBytes = DEFAULT_MAX_BYTES,
}: {
	url: string;
	timeoutMs?: number;
	attempts?: number;
	retryDelayMs?: number;
	maxBytes?: number;
}): Promise<string> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			// The signal covers the body too, so a stalled transfer is also cut.
			const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
			if (!response.ok) {
				throw new HttpStatusError(response.status);
			}
			return await readBodyText({ response, maxBytes });
		} catch (error) {
			lastError = error;
			if (isPermanentFailure({ error })) {
				break;
			}
			if (attempt < attempts) {
				await new Promise((done) => setTimeout(done, retryDelayMs * attempt));
			}
		}
	}
	throw new Error(`Failed to download ${url}: ${String(lastError)}`, {
		cause: lastError,
	});
}

/**
 * Writes `content` to a temporary file next to `path`, then renames it into
 * place. A crash or Ctrl-C leaves either the old file or the new one, never a
 * truncated one. The temporary file is created exclusively ("wx"): a file that
 * is already there is not ours, so the write fails and leaves it alone; one we
 * created is removed if the write fails.
 */
export async function writeFileAtomic({
	path,
	content,
	rename = fsRename,
	temporaryPath = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
	),
}: {
	path: string;
	content: string;
	rename?: (from: string, to: string) => Promise<void>;
	/** Tests pin the temporary file name; normally it is unique per write. */
	temporaryPath?: string;
}): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const handle = await open(temporaryPath, "wx");
	try {
		await handle.writeFile(content);
		await handle.close();
		await rename(temporaryPath, path);
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

/** Atomic write that skips files whose content is already right. Returns whether it wrote. */
export async function writeFileIfChanged({
	path,
	content,
}: {
	path: string;
	content: string;
}): Promise<boolean> {
	if ((await readFile(path, "utf8").catch(() => null)) === content) {
		return false;
	}
	await writeFileAtomic({ path, content });
	return true;
}

/**
 * Removes the temporary files that an interrupted run of `writeFileAtomic`
 * left behind (matched by their exact naming), in `directory` and below.
 * Returns how many it really removed: a file that could not be removed, or
 * that another sweep removed first, is not counted.
 *
 * It does not check whether the process id in the name is still alive. If two
 * generators run in the same folders at once, one sweep can delete the other's
 * temporary file between its write and its rename; that write then fails with
 * ENOENT and the run exits with an error. No half-written file is ever left in
 * place (the rename is what publishes a file), so this is accepted: run the
 * generators one at a time.
 */
export async function removeStaleTemporaryFiles({
	directory,
	remove = unlink,
}: {
	directory: string;
	/** Tests replace the deletion to make it fail; normally `fs.unlink`. */
	remove?: (path: string) => Promise<void>;
}): Promise<number> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);
	let removed = 0;
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			removed += await removeStaleTemporaryFiles({ directory: path, remove });
		} else if (TEMPORARY_FILE_PATTERN.test(entry.name)) {
			try {
				await remove(path);
				removed += 1;
			} catch {
				// Not ours to remove any more (or not removable): leave it, do not count it.
			}
		}
	}
	return removed;
}

/**
 * Returns the cached text when it is there and `validate` accepts it,
 * otherwise downloads it, validates it and caches it. A cached file that fails
 * validation (a leftover of an older, non-atomic run) is replaced; a download
 * that fails validation (an HTML error page) is never cached. `validate`
 * throws to reject.
 */
export async function readThroughCache({
	cachePath,
	download,
	validate,
}: {
	cachePath: string;
	download: () => Promise<string>;
	validate: ({ text }: { text: string }) => void;
}): Promise<string> {
	const cached = await readFile(cachePath, "utf8").catch(() => null);
	if (cached !== null) {
		try {
			validate({ text: cached });
			return cached;
		} catch {
			// fall through: fetch a fresh copy
		}
	}

	const text = await download();
	validate({ text });
	await writeFileAtomic({ path: cachePath, content: text });
	return text;
}
