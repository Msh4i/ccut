import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	downloadText,
	readThroughCache,
	removeStaleTemporaryFiles,
	writeFileAtomic,
	writeFileIfChanged,
} from "../lib/cache-io";

const root = mkdtempSync(join(tmpdir(), "ccut-cache-io-"));
let counter = 0;
function freshDirectory() {
	counter += 1;
	const directory = join(root, `case-${counter}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

afterAll(() => {
	// Only the directory this file created itself.
	rmSync(root, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
	test("creates parent directories and leaves no temporary file", async () => {
		const directory = freshDirectory();
		const path = join(directory, "a", "b", "file.json");
		await writeFileAtomic({ path, content: "hello" });
		expect(readFileSync(path, "utf8")).toBe("hello");
		expect(readdirSync(join(directory, "a", "b"))).toEqual(["file.json"]);
	});

	test("replaces existing content", async () => {
		const path = join(freshDirectory(), "file.txt");
		await writeFileAtomic({ path, content: "one" });
		await writeFileAtomic({ path, content: "two" });
		expect(readFileSync(path, "utf8")).toBe("two");
	});

	test("an interrupted write leaves the old content and no temporary file", async () => {
		const directory = freshDirectory();
		const path = join(directory, "file.txt");
		writeFileSync(path, "old");

		await expect(
			writeFileAtomic({
				path,
				content: "new",
				rename: async () => {
					throw new Error("killed before the rename");
				},
			}),
		).rejects.toThrow(/killed/);

		expect(readFileSync(path, "utf8")).toBe("old");
		expect(readdirSync(directory)).toEqual(["file.txt"]);
	});

	test("concurrent writes to different files do not collide", async () => {
		const directory = freshDirectory();
		await Promise.all(
			Array.from({ length: 50 }, (_, index) =>
				writeFileAtomic({ path: join(directory, `f${index}.txt`), content: String(index) }),
			),
		);
		expect(readdirSync(directory)).toHaveLength(50);
		expect(readFileSync(join(directory, "f7.txt"), "utf8")).toBe("7");
	});
});

describe("writeFileIfChanged", () => {
	test("does not touch a file whose content is already right", async () => {
		const path = join(freshDirectory(), "same.txt");
		await writeFileIfChanged({ path, content: "x" });
		const before = readFileSync(path);
		expect(await writeFileIfChanged({ path, content: "x" })).toBe(false);
		expect(await writeFileIfChanged({ path, content: "y" })).toBe(true);
		expect(before.toString()).toBe("x");
		expect(readFileSync(path, "utf8")).toBe("y");
	});
});

interface TestServer {
	url: string;
	hits: () => number;
	stop: () => void;
}

function serve({ handler }: { handler: (hit: number) => Response | Promise<Response> }): TestServer {
	let hits = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => handler(++hits),
	});
	return { url: `http://localhost:${server.port}/x`, hits: () => hits, stop: () => void server.stop(true) };
}

describe("downloadText", () => {
	test("returns the body", async () => {
		const server = serve({ handler: () => new Response("body") });
		try {
			expect(await downloadText({ url: server.url })).toBe("body");
		} finally {
			server.stop();
		}
	});

	test("gives up on a server that never answers instead of hanging", async () => {
		const server = serve({ handler: () => new Promise<Response>(() => {}) });
		const started = Date.now();
		try {
			await expect(
				downloadText({ url: server.url, timeoutMs: 80, attempts: 2, retryDelayMs: 1 }),
			).rejects.toThrow(/Failed to download/);
			expect(server.hits()).toBe(2);
			expect(Date.now() - started).toBeLessThan(3000);
		} finally {
			server.stop();
		}
	});

	test("retries a failing response and succeeds", async () => {
		const server = serve({
			handler: (hit) => (hit < 3 ? new Response("no", { status: 500 }) : new Response("ok")),
		});
		try {
			expect(await downloadText({ url: server.url, attempts: 4, retryDelayMs: 1 })).toBe("ok");
			expect(server.hits()).toBe(3);
		} finally {
			server.stop();
		}
	});

	test("reports the last status when every attempt fails", async () => {
		const server = serve({ handler: () => new Response("gone", { status: 404 }) });
		try {
			await expect(
				downloadText({ url: server.url, attempts: 2, retryDelayMs: 1 }),
			).rejects.toThrow(/404/);
		} finally {
			server.stop();
		}
	});
});

describe("readThroughCache", () => {
	const isJson = ({ text }: { text: string }) => void JSON.parse(text);

	test("downloads once, then answers from the cache", async () => {
		const cachePath = join(freshDirectory(), "meta.json");
		let downloads = 0;
		const download = async () => {
			downloads += 1;
			return '{"a":1}';
		};
		expect(await readThroughCache({ cachePath, download, validate: isJson })).toBe('{"a":1}');
		expect(await readThroughCache({ cachePath, download, validate: isJson })).toBe('{"a":1}');
		expect(downloads).toBe(1);
	});

	test("a cached file that fails validation (a truncated old run) is downloaded again", async () => {
		const cachePath = join(freshDirectory(), "meta.json");
		writeFileSync(cachePath, '{"a":'); // what an interrupted, non-atomic write left behind
		const text = await readThroughCache({
			cachePath,
			download: async () => '{"a":2}',
			validate: isJson,
		});
		expect(text).toBe('{"a":2}');
		expect(readFileSync(cachePath, "utf8")).toBe('{"a":2}');
	});

	test("a download that fails validation is never cached", async () => {
		const directory = freshDirectory();
		const cachePath = join(directory, "meta.json");
		await expect(
			readThroughCache({
				cachePath,
				download: async () => "<html>rate limited</html>",
				validate: isJson,
			}),
		).rejects.toThrow();
		expect(readdirSync(directory)).toEqual([]);
	});
});

describe("writeFileAtomic never overwrites a temporary file it did not create", () => {
	test("an existing file at the temporary path makes the write fail and is left alone", async () => {
		const directory = freshDirectory();
		const path = join(directory, "file.txt");
		const temporaryPath = join(directory, ".file.txt.1.deadbeef.tmp");
		writeFileSync(temporaryPath, "someone else's");
		writeFileSync(path, "old");

		await expect(writeFileAtomic({ path, content: "new", temporaryPath })).rejects.toThrow(/EEXIST/);
		expect(readFileSync(temporaryPath, "utf8")).toBe("someone else's");
		expect(readFileSync(path, "utf8")).toBe("old");
	});

	test("a failed write does not remove a temporary file that was not its own", async () => {
		const directory = freshDirectory();
		const temporaryPath = join(directory, ".other.txt.1.deadbeef.tmp");
		writeFileSync(temporaryPath, "someone else's");
		await expect(writeFileAtomic({ path: join(directory, "other.txt"), content: "x", temporaryPath })).rejects.toThrow();
		expect(readdirSync(directory)).toContain(".other.txt.1.deadbeef.tmp");
	});
});

describe("removeStaleTemporaryFiles", () => {
	test("removes the temporary files an interrupted run left, in subfolders too, and nothing else", async () => {
		const directory = freshDirectory();
		mkdirSync(join(directory, "sub", "deeper"), { recursive: true });
		const stale = [
			join(directory, ".a.json.123.0a1b2c3d.tmp"),
			join(directory, "sub", ".b.svg.45.ffffffff.tmp"),
			join(directory, "sub", "deeper", ".c.txt.9.00000000.tmp"),
		];
		const keep = [
			join(directory, "a.json"),
			join(directory, "notes.tmp"), // not our naming: a user's file
			join(directory, "sub", "b.svg"),
			join(directory, ".hidden"),
		];
		for (const file of [...stale, ...keep]) writeFileSync(file, "x");

		expect(await removeStaleTemporaryFiles({ directory })).toBe(3);
		for (const file of stale) expect(readdirSync(join(file, "..")).includes(file.split("/").pop() ?? "")).toBe(false);
		for (const file of keep) expect(readdirSync(join(file, "..")).includes(file.split("/").pop() ?? "")).toBe(true);
	});

	test("counts only the files it really removed", async () => {
		const directory = freshDirectory();
		const stuck = join(directory, ".stuck.txt.1.00000001.tmp");
		const gone = join(directory, ".gone.txt.2.00000002.tmp");
		for (const file of [stuck, gone]) writeFileSync(file, "x");
		const attempted: string[] = [];
		const removed = await removeStaleTemporaryFiles({
			directory,
			remove: async (path) => {
				attempted.push(path);
				if (path === stuck) {
					throw new Error("EACCES: permission denied");
				}
				rmSync(path);
			},
		});
		expect(attempted.sort()).toEqual([gone, stuck].sort());
		expect(removed).toBe(1);
		expect(readdirSync(directory)).toEqual([".stuck.txt.1.00000001.tmp"]);
	});

	test("a file another sweep already removed is not counted either", async () => {
		const directory = freshDirectory();
		writeFileSync(join(directory, ".race.txt.3.00000003.tmp"), "x");
		const removed = await removeStaleTemporaryFiles({
			directory,
			remove: async () => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
		});
		expect(removed).toBe(0);
	});

	test("a missing directory is nothing to clean", async () => {
		expect(await removeStaleTemporaryFiles({ directory: join(root, "does-not-exist") })).toBe(0);
	});
});

describe("downloadText body limit (a wrong or hijacked URL must not fill the memory)", () => {
	const text = (length: number) => "a".repeat(length);

	test("a body exactly at the limit is accepted", async () => {
		const server = serve({ handler: () => new Response(text(1000)) });
		try {
			expect(await downloadText({ url: server.url, maxBytes: 1000 })).toHaveLength(1000);
		} finally {
			server.stop();
		}
	});

	test("a body one byte over the limit is refused, and not retried (it would be as big again)", async () => {
		const server = serve({ handler: () => new Response(text(1001)) });
		try {
			await expect(
				downloadText({ url: server.url, maxBytes: 1000, attempts: 4, retryDelayMs: 1 }),
			).rejects.toThrow(/larger than 1000 bytes/);
			expect(server.hits()).toBe(1);
		} finally {
			server.stop();
		}
	});

	test("a stream with no Content-Length is cut when it passes the limit, not after it ends", async () => {
		let sent = 0;
		let finished = false;
		const server = serve({
			handler: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						async pull(controller) {
							if (finished) {
								controller.close();
								return;
							}
							sent += 1;
							controller.enqueue(new Uint8Array(1024).fill(97));
							// Yield between chunks, so what the client does is visible in `sent`.
							await new Promise((done) => setTimeout(done, 0));
						},
						cancel() {
							finished = true;
						},
					}),
				),
		});
		try {
			await expect(
				downloadText({ url: server.url, maxBytes: 4096, attempts: 1 }),
			).rejects.toThrow(/larger than 4096 bytes/);
			// 4 KB allowed, 1 KB chunks: the fifth chunk trips it. Reading to the end would be unbounded.
			expect(sent).toBeLessThan(50);
		} finally {
			finished = true;
			server.stop();
		}
	});

	test("a declared Content-Length over the limit is refused without waiting for the body", async () => {
		// A hand-written HTTP answer: it promises 100,000 bytes, sends 10 and stalls.
		// (Bun.serve would swap a streamed body's Content-Length for chunking.)
		const listener = Bun.listen({
			hostname: "localhost",
			port: 0,
			socket: {
				data(socket) {
					socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100000\r\n\r\naaaaaaaaaa");
				},
			},
		});
		try {
			await expect(
				downloadText({ url: `http://localhost:${listener.port}/x`, maxBytes: 1000, attempts: 1, timeoutMs: 3000 }),
			).rejects.toThrow(/larger than 1000 bytes/);
		} finally {
			listener.stop(true);
		}
	});

	test("the default limit is at least 20 MB (the sources are a few MB)", async () => {
		const server = serve({ handler: () => new Response(text(5_000_000)) });
		try {
			expect(await downloadText({ url: server.url })).toHaveLength(5_000_000);
		} finally {
			server.stop();
		}
	});

	test("multi-byte text split across chunks is decoded intact", async () => {
		// No network: the answer is handed over chunk by chunk, so every character is split.
		const bytes = new TextEncoder().encode("çay ☕ 日本語");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		});
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
		try {
			expect(await downloadText({ url: "http://localhost/unused" })).toBe("çay ☕ 日本語");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("an empty body is an empty string", async () => {
		const server = serve({ handler: () => new Response("") });
		try {
			expect(await downloadText({ url: server.url })).toBe("");
		} finally {
			server.stop();
		}
	});
});

describe("downloadText failures", () => {
	test("keeps the underlying error as the cause", async () => {
		const server = serve({ handler: () => new Response("no", { status: 500 }) });
		try {
			const error = await downloadText({ url: server.url, attempts: 1 }).catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(Error);
			expect(error instanceof Error && error.cause).toBeInstanceOf(Error);
			expect(String(error instanceof Error && error.cause)).toContain("500");
		} finally {
			server.stop();
		}
	});

	test("does not retry a client error: the answer will not change", async () => {
		for (const status of [400, 403, 404, 410]) {
			const server = serve({ handler: () => new Response("no", { status }) });
			try {
				await expect(downloadText({ url: server.url, attempts: 5, retryDelayMs: 1 })).rejects.toThrow(String(status));
				expect(server.hits()).toBe(1);
			} finally {
				server.stop();
			}
		}
	});

	test("does retry 429 (rate limited) and server errors", async () => {
		for (const status of [429, 500, 503]) {
			const server = serve({ handler: (hit) => (hit < 3 ? new Response("later", { status }) : new Response("ok")) });
			try {
				expect(await downloadText({ url: server.url, attempts: 4, retryDelayMs: 1 })).toBe("ok");
				expect(server.hits()).toBe(3);
			} finally {
				server.stop();
			}
		}
	});
});
