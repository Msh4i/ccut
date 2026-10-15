// Stems (round 5): pull ONE regular file out of a .tar.gz, streaming, no dependency. Used for the
// `uv` binary of its release archive, after the archive's SHA-256 matched the pin. Only the member
// whose path equals `member` is written (to a new 0600 file); every other entry is skipped, so no
// path from the archive ever reaches the file system. ustar names (with prefix), GNU long names
// ("L") and pax "path" records are understood; sparse or base-256 sizes are refused.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const zlib = require("node:zlib");

const BLOCK = 512;
const MAX_META_BYTES = 64 * 1024;

const cString = (buffer) => {
	const end = buffer.indexOf(0);
	return buffer.toString("utf8", 0, end === -1 ? buffer.length : end);
};

/** null for an all-zero block (end marker); else { name, size, type }. */
function parseHeader(block) {
	if (block.every((byte) => byte === 0)) return null;
	if (block[124] & 0x80) throw new Error("unsupported tar size field");
	const sizeText = cString(block.subarray(124, 136)).trim();
	if (!/^[0-7]{1,11}$/.test(sizeText)) throw new Error("bad tar size");
	const prefix = block.toString("latin1", 257, 262) === "ustar" ? cString(block.subarray(345, 500)) : "";
	const name = cString(block.subarray(0, 100));
	return { name: prefix ? `${prefix}/${name}` : name, size: Number.parseInt(sizeText, 8), type: String.fromCharCode(block[156] || 0x30) };
}

/** The `path=` value of a pax extended header body, or null. */
function paxPath(body) {
	let rest = body;
	while (rest.length > 0) {
		const space = rest.indexOf(0x20);
		const length = Number(rest.toString("latin1", 0, space));
		if (space < 1 || !Number.isSafeInteger(length) || length < space + 2 || length > rest.length) return null;
		const record = rest.toString("utf8", space + 1, length - 1); // up to the final newline
		if (record.startsWith("path=")) return record.slice(5);
		rest = rest.subarray(length);
	}
	return null;
}

const normalise = (name) => name.replace(/^(\.\/)+/, "");

/** Writes the member to `destPath` (never overwrites). Resolves its size; throws if absent or malformed. */
async function extractMember({ archivePath, member, destPath, maxBytes, createReadStream = fs.createReadStream, fsApi = fsp }) {
	const gunzip = zlib.createGunzip();
	const source = createReadStream(archivePath);
	source.on("error", (error) => gunzip.destroy(error));
	source.pipe(gunzip);
	let buffer = Buffer.alloc(0);
	// header | body (a member's bytes, or meta bytes to collect, or entry bytes to skip) | pad
	let state = { kind: "header" };
	let nextName = null;
	let handle = null;
	let written = 0;
	let finished = false;
	try {
		for await (const chunk of gunzip) {
			buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
			while (!finished && buffer.length > 0) {
				if (state.kind === "header") {
					if (buffer.length < BLOCK) break;
					const header = parseHeader(buffer.subarray(0, BLOCK));
					buffer = buffer.subarray(BLOCK);
					if (!header) continue;
					const name = normalise(nextName ?? header.name);
					const regular = header.type === "0";
					if (header.type === "L" || header.type === "x") {
						if (header.size > MAX_META_BYTES) throw new Error("tar meta entry too large");
						state = { kind: "body", remaining: header.size, pad: (BLOCK - (header.size % BLOCK)) % BLOCK, meta: header.type, parts: [] };
						continue;
					}
					nextName = null;
					if (regular && name === member) {
						if (header.size < 1 || header.size > maxBytes) throw new Error("tar member size out of range");
						handle = await fsApi.open(destPath, "wx", 0o600);
						state = { kind: "body", remaining: header.size, pad: 0, file: true };
					} else {
						state = { kind: "body", remaining: header.size, pad: (BLOCK - (header.size % BLOCK)) % BLOCK };
					}
					if (header.size === 0) state = { kind: "header" };
					continue;
				}
				// Body or padding: consume up to what is left of this part.
				const take = buffer.subarray(0, Math.min(buffer.length, state.remaining));
				buffer = buffer.subarray(take.length);
				if (state.file) {
					await handle.write(take);
					written += take.length;
				} else if (state.meta) {
					state.parts.push(Buffer.from(take));
				}
				state.remaining -= take.length;
				if (state.remaining > 0) break;
				if (state.file) {
					finished = true;
				} else if (state.meta) {
					const body = Buffer.concat(state.parts);
					nextName = state.meta === "L" ? cString(body) : (paxPath(body) ?? nextName);
					state = state.pad > 0 ? { kind: "pad", remaining: state.pad } : { kind: "header" };
				} else {
					state = state.pad > 0 ? { kind: "pad", remaining: state.pad } : { kind: "header" };
				}
			}
			if (finished) break;
		}
		if (!finished) throw new Error("member not found in archive");
		await handle.sync();
		return written;
	} catch (error) {
		if (handle) {
			await handle.close().catch(() => {});
			handle = null;
			await fsApi.unlink(destPath).catch(() => {});
		}
		throw error;
	} finally {
		source.destroy();
		gunzip.destroy();
		if (handle) await handle.close().catch(() => {});
	}
}

module.exports = { extractMember };
