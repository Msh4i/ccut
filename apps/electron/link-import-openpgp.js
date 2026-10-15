// "Import from link": OpenPGP detached-signature verification, only as much as checking a yt-dlp
// release needs (RFC 4880 / RFC 9580, version 4). Pure Node (node:crypto), no dependency.
//
// What is accepted, everything else is refused with an OpenPgpError (its `reason` names the rule):
// - Key: a transferable public key whose FIRST packet is a v4 RSA primary key (algorithm 1 or 3,
//   2048..8192 bits, an odd exponent of at most 64 bits); after it only user IDs, signatures,
//   subkeys and user attributes, which are skipped (they are not verified: the key is a pinned
//   constant, its v4 fingerprint must equal the pin). Armor: one block with the expected label,
//   strict base64, CRC24 checked when present.
// - Signature: a file holding exactly ONE signature packet: v4, type 0x00 (binary document), RSA,
//   SHA-256/384/512. Its hashed area must hold exactly one creation time and exactly one v4
//   issuer fingerprint equal to the key's; an issuer key ID there must match too; any other
//   hashed subpacket marked critical is refused (signature expiration included: it is not
//   evaluated); the unhashed area is not signed, so it is only bounded, never used.
//   Then: hash(data || version..hashed area || 0x04 0xff || length), the left 16 bits must match,
//   and RSA PKCS#1 v1.5 must verify with the key.
// Every length field is checked against the bytes that are really there before it is used.
const crypto = require("node:crypto");

const LIMITS = Object.freeze({
	maxArmorChars: 64 * 1024,
	maxKeyBytes: 32 * 1024,
	maxSignatureBytes: 16 * 1024,
	maxPackets: 32,
	maxSubpackets: 64,
	minRsaBits: 2048,
	maxRsaBits: 8192,
	maxExponentBytes: 8,
});
const HASH_ALGORITHMS = Object.freeze({ 8: "sha256", 9: "sha384", 10: "sha512" });
const RSA_ALGORITHMS = Object.freeze([1, 3]); // RSA (encrypt or sign), RSA sign-only
const TAG = Object.freeze({ signature: 2, publicKey: 6, userId: 13, publicSubkey: 14, userAttribute: 17 });
const AFTER_PRIMARY_TAGS = Object.freeze([TAG.signature, TAG.userId, TAG.publicSubkey, TAG.userAttribute]);
const SUBPACKET = Object.freeze({ creationTime: 2, issuerKeyId: 16, issuerFingerprint: 33 });
const BINARY_DOCUMENT = 0x00;

class OpenPgpError extends Error {
	constructor(reason) {
		super(`OpenPGP: ${reason}`);
		this.name = "OpenPgpError";
		this.reason = reason;
	}
}
const fail = (reason) => {
	throw new OpenPgpError(reason);
};

const asBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const hexOf = (bytes) => Buffer.from(bytes).toString("hex").toUpperCase();

/** Sequential reads from `bytes`; reading past the end is `reason`. */
function cursor({ bytes, reason }) {
	let at = 0;
	const need = (count) => {
		if (count > bytes.length - at) fail(reason);
	};
	return {
		offset: () => at,
		remaining: () => bytes.length - at,
		u8() {
			need(1);
			return bytes[at++];
		},
		u16() {
			need(2);
			const value = bytes.readUInt16BE(at);
			at += 2;
			return value;
		},
		u32() {
			need(4);
			const value = bytes.readUInt32BE(at);
			at += 4;
			return value;
		},
		take(count) {
			need(count);
			const value = bytes.subarray(at, at + count);
			at += count;
			return value;
		},
	};
}

// --- armor ---

function crc24(bytes) {
	let crc = 0xb704ce;
	for (const byte of bytes) {
		crc ^= byte << 16;
		for (let bit = 0; bit < 8; bit++) {
			crc <<= 1;
			if (crc & 0x1000000) crc ^= 0x1864cfb;
		}
	}
	return crc & 0xffffff;
}

/** The bytes of one ASCII-armored block labelled `label` (only white space around it). */
function dearmor({ text, label }) {
	if (typeof text !== "string" || text.length > LIMITS.maxArmorChars) fail("armor");
	const lines = text.trim().split(/\r?\n/);
	if (lines[0] !== `-----BEGIN ${label}-----` || lines.at(-1) !== `-----END ${label}-----`) fail("armor");
	let index = 1;
	// Armor headers ("Key: value") up to the blank line, which is required.
	for (; index < lines.length - 1 && lines[index] !== ""; index++) {
		if (!/^[A-Za-z][A-Za-z0-9-]*: /.test(lines[index])) fail("armor");
	}
	if (lines[index] !== "") fail("armor");
	const body = lines.slice(index + 1, -1);
	const checksum = body.length > 0 && /^=[A-Za-z0-9+/]{4}$/.test(body.at(-1)) ? body.pop() : null;
	const joined = body.join("");
	if (joined === "" || body.some((line) => !/^[A-Za-z0-9+/]+={0,2}$/.test(line))) fail("armor");
	const bytes = Buffer.from(joined, "base64");
	// Node's decoder is lenient (padding in the middle, missing padding): require the canonical form.
	if (bytes.toString("base64") !== joined) fail("armor");
	if (checksum !== null && Buffer.from(checksum.slice(1), "base64").readUIntBE(0, 3) !== crc24(bytes)) fail("armor");
	return bytes;
}

// --- packets ---

/** [{ tag, body }] of a packet sequence; partial and indeterminate lengths are refused. */
function readPackets({ bytes, maxPackets }) {
	const packets = [];
	const reader = cursor({ bytes, reason: "packet-length" });
	// Bounded: every round consumes at least the two header octets, and maxPackets.
	for (let round = 0; reader.remaining() > 0; round++) {
		if (round >= maxPackets) fail("too-many-packets");
		const first = reader.u8();
		if ((first & 0x80) === 0) fail("packet-header");
		let tag;
		let length;
		if (first & 0x40) {
			tag = first & 0x3f;
			const octet = reader.u8();
			if (octet < 192) length = octet;
			else if (octet < 224) length = ((octet - 192) << 8) + reader.u8() + 192;
			else if (octet === 255) length = reader.u32();
			else fail("partial-length");
		} else {
			tag = (first >> 2) & 0x0f;
			const lengthType = first & 0x03;
			if (lengthType === 3) fail("indeterminate-length");
			length = lengthType === 0 ? reader.u8() : lengthType === 1 ? reader.u16() : reader.u32();
		}
		if (tag === 0) fail("packet-header");
		packets.push({ tag, body: reader.take(length) });
	}
	return packets;
}

/** A multiprecision integer: two octets of bit count, then exactly that many bits (no leading zero bits). */
function readMpi(reader) {
	if (reader.remaining() < 2) fail("mpi");
	const bits = reader.u16();
	const length = (bits + 7) >> 3;
	if (bits === 0 || length > reader.remaining()) fail("mpi");
	const value = reader.take(length);
	if (value[0] >> ((bits - 1) % 8) !== 1) fail("mpi");
	return { bits, value };
}

// --- keys ---

function parsePublicKeyBody(body) {
	const reader = cursor({ bytes: body, reason: "key-structure" });
	if (reader.u8() !== 4) fail("key-version");
	const created = reader.u32();
	if (!RSA_ALGORITHMS.includes(reader.u8())) fail("key-algorithm");
	const n = readMpi(reader);
	const e = readMpi(reader);
	if (reader.remaining() !== 0) fail("trailing-bytes");
	if (n.bits < LIMITS.minRsaBits || n.bits > LIMITS.maxRsaBits) fail("key-size");
	const exponentIsOne = e.value.length === 1 && e.value[0] === 1;
	if (e.value.length > LIMITS.maxExponentBytes || (e.value.at(-1) & 1) === 0 || exponentIsOne) fail("key-exponent");
	// v4 fingerprint: SHA-1 over 0x99, the two-octet body length, the body (RFC 4880 12.2).
	const prefix = Buffer.from([0x99, body.length >> 8, body.length & 0xff]);
	const fingerprint = crypto.createHash("sha1").update(prefix).update(body).digest("hex").toUpperCase();
	return { fingerprint, keyId: fingerprint.slice(-16), created, bits: n.bits, n: n.value, e: e.value };
}

/** The primary key of a binary transferable public key: { fingerprint, keyId, created, bits, n, e }. */
function parsePublicKey({ bytes }) {
	if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.maxKeyBytes) fail("key-structure");
	const packets = readPackets({ bytes: asBuffer(bytes), maxPackets: LIMITS.maxPackets });
	if (packets.length === 0 || packets[0].tag !== TAG.publicKey) fail("key-structure");
	if (packets.slice(1).some((packet) => !AFTER_PRIMARY_TAGS.includes(packet.tag))) fail("key-structure");
	return parsePublicKeyBody(packets[0].body);
}

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");

/**
 * The armored key, only if its v4 fingerprint is exactly `fingerprint` (40 upper-case hex
 * digits): { fingerprint, keyId, created, bits, modulusBytes, publicKey (a KeyObject) }.
 */
function loadPinnedKey({ armored, fingerprint }) {
	if (typeof fingerprint !== "string" || !/^[0-9A-F]{40}$/.test(fingerprint)) fail("fingerprint");
	const key = parsePublicKey({ bytes: dearmor({ text: armored, label: "PGP PUBLIC KEY BLOCK" }) });
	if (key.fingerprint !== fingerprint) fail("fingerprint");
	let publicKey;
	try {
		publicKey = crypto.createPublicKey({ key: { kty: "RSA", n: base64url(key.n), e: base64url(key.e) }, format: "jwk" });
	} catch {
		fail("key-structure");
	}
	return Object.freeze({ fingerprint: key.fingerprint, keyId: key.keyId, created: key.created, bits: key.bits, modulusBytes: key.n.length, publicKey });
}

// --- signatures ---

/** [{ type, critical, data }] of a subpacket area. */
function readSubpackets({ area }) {
	const list = [];
	const reader = cursor({ bytes: area, reason: "subpacket" });
	// Bounded: every round consumes at least two octets (a length of 0 is refused), and maxSubpackets.
	for (let round = 0; reader.remaining() > 0; round++) {
		if (round >= LIMITS.maxSubpackets) fail("subpacket");
		const first = reader.u8();
		const length = first < 192 ? first : first < 255 ? ((first - 192) << 8) + reader.u8() + 192 : reader.u32();
		if (length === 0) fail("subpacket");
		const content = reader.take(length);
		list.push({ type: content[0] & 0x7f, critical: (content[0] & 0x80) !== 0, data: content.subarray(1) });
	}
	return list;
}

/** The hashed area's rules: { created, issuerFingerprint, issuerKeyId }. */
function readHashedSubpackets(area) {
	let created = null;
	let issuerFingerprint = null;
	let issuerKeyId = null;
	for (const { type, critical, data } of readSubpackets({ area })) {
		if (type === SUBPACKET.creationTime) {
			if (created !== null || data.length !== 4) fail("creation-time");
			created = data.readUInt32BE(0);
		} else if (type === SUBPACKET.issuerFingerprint) {
			if (issuerFingerprint !== null || data.length !== 21 || data[0] !== 4) fail("issuer");
			issuerFingerprint = hexOf(data.subarray(1));
		} else if (type === SUBPACKET.issuerKeyId) {
			if (issuerKeyId !== null || data.length !== 8) fail("issuer");
			issuerKeyId = hexOf(data);
		} else if (critical) {
			fail("critical-subpacket");
		}
	}
	if (created === null) fail("creation-time");
	// A missing issuer fingerprint (null) never equals the key's: verifyDetachedSignature refuses it.
	return { created, issuerFingerprint, issuerKeyId };
}

/** The one v4 binary-document RSA signature packet of a detached signature file. */
function parseSignature({ bytes }) {
	if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.maxSignatureBytes) fail("signature-size");
	const packets = readPackets({ bytes: asBuffer(bytes), maxPackets: LIMITS.maxPackets });
	if (packets.length !== 1 || packets[0].tag !== TAG.signature) fail("signature-structure");
	const { body } = packets[0];
	const reader = cursor({ bytes: body, reason: "signature-structure" });
	if (reader.u8() !== 4) fail("signature-version");
	if (reader.u8() !== BINARY_DOCUMENT) fail("signature-type");
	if (!RSA_ALGORITHMS.includes(reader.u8())) fail("signature-algorithm");
	const hashId = reader.u8();
	if (!Object.hasOwn(HASH_ALGORITHMS, hashId)) fail("hash-algorithm");
	const hashedArea = reader.take(reader.u16());
	const hashedEnd = reader.offset();
	readSubpackets({ area: reader.take(reader.u16()) }); // unhashed: bounded, not used
	const left16 = reader.take(2);
	const { value } = readMpi(reader);
	if (reader.remaining() !== 0) fail("trailing-bytes");
	return { hash: HASH_ALGORITHMS[hashId], hashedPart: body.subarray(0, hashedEnd), left16, value, ...readHashedSubpackets(hashedArea) };
}

/**
 * Verifies the detached `signature` (the bytes of a .sig file) of `data` with `key` (from
 * loadPinnedKey). Returns { created, hash }; anything else throws an OpenPgpError.
 */
function verifyDetachedSignature({ data, signature, key }) {
	if (!(data instanceof Uint8Array)) fail("input");
	const sig = parseSignature({ bytes: signature });
	if (sig.issuerFingerprint !== key.fingerprint) fail("issuer");
	if (sig.issuerKeyId !== null && sig.issuerKeyId !== key.keyId) fail("issuer");
	if (sig.value.length > key.modulusBytes) fail("signature-size");
	// v4 trailer: version, 0xff, the four-octet length of the hashed part (RFC 4880 5.2.4).
	const trailer = Buffer.alloc(6);
	trailer[0] = 4;
	trailer[1] = 0xff;
	trailer.writeUInt32BE(sig.hashedPart.length, 2);
	const signed = Buffer.concat([asBuffer(data), sig.hashedPart, trailer]);
	const digest = crypto.createHash(sig.hash).update(signed).digest();
	if (digest[0] !== sig.left16[0] || digest[1] !== sig.left16[1]) fail("quick-check");
	// The MPI drops leading zero octets; RSA verification wants exactly the modulus length.
	const padded = Buffer.alloc(key.modulusBytes);
	sig.value.copy(padded, key.modulusBytes - sig.value.length);
	let good = false;
	try {
		good = crypto.verify(sig.hash, signed, { key: key.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, padded);
	} catch {
		good = false;
	}
	if (!good) fail("bad-signature");
	return { created: sig.created, hash: sig.hash };
}

module.exports = { HASH_ALGORITHMS, LIMITS, OpenPgpError, dearmor, loadPinnedKey, parsePublicKey, verifyDetachedSignature };
