const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { HASH_ALGORITHMS, LIMITS, OpenPgpError, dearmor, loadPinnedKey, parsePublicKey, verifyDetachedSignature } = require("../link-import-openpgp");
const { YT_DLP_SIGNING_KEY_ARMORED, YT_DLP_SIGNING_KEY_FINGERPRINT } = require("../link-import-ytdlp-key");

// The yt-dlp release check: SHA2-256SUMS is trusted only with a valid OpenPGP v4 signature by
// the pinned yt-dlp key. Real release files plus gpg-made test-key files (fixtures/openpgp/README.md).

const FIXTURES = path.join(__dirname, "fixtures", "openpgp");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));
// Pinned here on purpose (not read from the module): changing the module's constant must fail a test.
const YT_DLP_FINGERPRINT = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581";
const TEST_FINGERPRINT = "9A837733E6D8970CF21377578E3B95A0078605B9";

const ytDlpKey = () => loadPinnedKey({ armored: YT_DLP_SIGNING_KEY_ARMORED, fingerprint: YT_DLP_SIGNING_KEY_FINGERPRINT });
const testKey = () => loadPinnedKey({ armored: fixture("test-key.asc").toString("utf8"), fingerprint: TEST_FINGERPRINT });
const REAL_SUMS = fixture("yt-dlp-2026.08.19.SHA2-256SUMS");
const REAL_SIG = fixture("yt-dlp-2026.08.19.SHA2-256SUMS.sig");

/** The OpenPgpError reason of a call, "ok" when it returns, or the text of any other error. */
function reasonOf(fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof OpenPgpError ? error.reason : `not an OpenPgpError: ${error && error.message}`;
	}
	return "ok";
}

const verifyReal = ({ data = REAL_SUMS, signature = REAL_SIG, key = ytDlpKey() } = {}) => reasonOf(() => verifyDetachedSignature({ data, signature, key }));
const withByte = ({ bytes, at, value }) => {
	const copy = Buffer.from(bytes);
	copy[at] = value;
	return copy;
};

// The real signature packet: old-format header 0x89 (tag 2, two-octet length 0x0233), then
// v4, type 0x00, RSA, SHA-512, hashed area of 29 bytes at 6..34 (issuer fingerprint, creation
// time), unhashed area of 10 bytes (issuer key ID), left 16 bits 0x03bc at 47..48, the MPI.
const HEADER = 3;
const BODY = REAL_SIG.subarray(HEADER);
const at = (bodyOffset) => HEADER + bodyOffset;
const newFormat = ({ tag = 2, body = BODY, lengthBytes }) => Buffer.concat([Buffer.from([0xc0 | tag]), lengthBytes, body]);

describe("the embedded yt-dlp signing key", () => {
	test("parses as an RSA 4096 v4 key whose fingerprint is the pinned one", () => {
		expect(YT_DLP_SIGNING_KEY_FINGERPRINT).toBe(YT_DLP_FINGERPRINT);
		const key = ytDlpKey();
		expect(key.fingerprint).toBe(YT_DLP_FINGERPRINT);
		expect(key.keyId).toBe("57CF65933B5A7581");
		expect(key.bits).toBe(4096);
		expect(key.created).toBe(1677455406); // 2023-02-26, gpg --list-packets
		expect(key.publicKey.asymmetricKeyType).toBe("rsa");
	});

	test("a key whose fingerprint differs from the pin is refused at load, whatever it is", () => {
		const armored = fixture("test-key.asc").toString("utf8");
		expect(reasonOf(() => loadPinnedKey({ armored, fingerprint: YT_DLP_FINGERPRINT }))).toBe("fingerprint");
		expect(reasonOf(() => loadPinnedKey({ armored: YT_DLP_SIGNING_KEY_ARMORED, fingerprint: TEST_FINGERPRINT }))).toBe("fingerprint");
		// The pin itself must be a full upper-case v4 fingerprint (no key-ID prefix, no spaces).
		for (const fingerprint of [YT_DLP_FINGERPRINT.toLowerCase(), YT_DLP_FINGERPRINT.slice(24), "AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581", "", undefined]) {
			expect(reasonOf(() => loadPinnedKey({ armored: YT_DLP_SIGNING_KEY_ARMORED, fingerprint }))).toBe("fingerprint");
		}
		expect(testKey().fingerprint).toBe(TEST_FINGERPRINT);
		expect(testKey().keyId).toBe("8E3B95A0078605B9");
		expect(testKey().bits).toBe(3072);
	});
});

describe("verifyDetachedSignature: the real yt-dlp 2026.08.19 SHA2-256SUMS", () => {
	test("good signature: the sums file, its signature and the pinned key", () => {
		expect(verifyDetachedSignature({ data: REAL_SUMS, signature: REAL_SIG, key: ytDlpKey() })).toEqual({ created: 1787183289, hash: "sha512" });
		// a Uint8Array (not a Buffer) is fine too
		expect(verifyReal({ data: new Uint8Array(REAL_SUMS), signature: new Uint8Array(REAL_SIG) })).toBe("ok");
	});

	test("one flipped byte anywhere in the sums file, a byte more or less: refused", () => {
		for (const offset of [0, 64, 66, 800, REAL_SUMS.length - 2, REAL_SUMS.length - 1]) {
			expect(["quick-check", "bad-signature"]).toContain(verifyReal({ data: withByte({ bytes: REAL_SUMS, at: offset, value: REAL_SUMS[offset] ^ 0x01 }) }));
		}
		expect(["quick-check", "bad-signature"]).toContain(verifyReal({ data: Buffer.concat([REAL_SUMS, Buffer.from("\n")]) }));
		expect(["quick-check", "bad-signature"]).toContain(verifyReal({ data: REAL_SUMS.subarray(0, -1) }));
		expect(["quick-check", "bad-signature"]).toContain(verifyReal({ data: Buffer.alloc(0) }));
	});

	test("a flipped byte in the RSA value (the quick check still passes): bad-signature", () => {
		// (the first value byte keeps its top bit: the MPI's bit count stays right)
		for (const offset of [at(51), at(300), REAL_SIG.length - 1]) {
			expect(verifyReal({ signature: withByte({ bytes: REAL_SIG, at: offset, value: REAL_SIG[offset] ^ 0x01 }) })).toBe("bad-signature");
		}
	});

	test("only the left 16 bits changed (the RSA value is still valid): quick-check", () => {
		expect(REAL_SIG.subarray(at(47), at(49))).toEqual(Buffer.from([0x03, 0xbc]));
		expect(verifyReal({ signature: withByte({ bytes: REAL_SIG, at: at(47), value: 0x04 }) })).toBe("quick-check");
		expect(verifyReal({ signature: withByte({ bytes: REAL_SIG, at: at(48), value: 0xbd }) })).toBe("quick-check");
	});

	test("a flipped byte in the hashed area (creation time): refused, it is part of what is signed", () => {
		expect(["quick-check", "bad-signature"]).toContain(verifyReal({ signature: withByte({ bytes: REAL_SIG, at: at(34), value: REAL_SIG[at(34)] ^ 0x01 }) }));
	});

	test("the unhashed area is not signed: its issuer key ID is not used (a changed one is not trusted, the hashed issuer decides)", () => {
		// unhashed subpacket 16 (issuer key ID) data at body 39..46
		expect(verifyReal({ signature: withByte({ bytes: REAL_SIG, at: at(46), value: REAL_SIG[at(46)] ^ 0xff }) })).toBe("ok");
	});

	test("a signature by another key over the same file: refused against the yt-dlp key (issuer), good against its own key", () => {
		const other = fixture("yt-dlp-2026.08.19.SHA2-256SUMS.by-test-key.sig");
		expect(verifyReal({ signature: other })).toBe("issuer");
		expect(verifyReal({ signature: other, key: testKey() })).toBe("ok");
		// and the real signature does not verify with the test key
		expect(verifyReal({ key: testKey() })).toBe("issuer");
	});

	test("the same packet with a new-format header (2 and 5 octet lengths) is the same signature", () => {
		const twoOctet = Buffer.from([((BODY.length - 192) >> 8) + 192, (BODY.length - 192) & 0xff]);
		const fiveOctet = Buffer.from([0xff, 0, 0, BODY.length >> 8, BODY.length & 0xff]);
		expect(verifyReal({ signature: newFormat({ lengthBytes: twoOctet }) })).toBe("ok");
		expect(verifyReal({ signature: newFormat({ lengthBytes: fiveOctet }) })).toBe("ok");
	});
});

describe("verifyDetachedSignature: what is accepted and refused (test key, gpg-made)", () => {
	const sums = fixture("test-sums");
	const check = ({ name, data = sums }) => reasonOf(() => verifyDetachedSignature({ data, signature: fixture(name), key: testKey() }));

	test("SHA-256, SHA-384 and SHA-512 are accepted", () => {
		expect(check({ name: "test-sums.sig" })).toBe("ok");
		expect(check({ name: "test-sums.sha384.sig" })).toBe("ok");
		expect(verifyReal()).toBe("ok"); // SHA-512
		expect(Object.values(HASH_ALGORITHMS).sort()).toEqual(["sha256", "sha384", "sha512"]);
	});

	test("an RSA value with a leading zero octet (3063 bits, the MPI is one octet shorter than the modulus) is padded and verifies", () => {
		const signature = fixture("short-mpi.txt.sig");
		const bits = signature.readUInt16BE(signature.length - 383 - 2);
		expect(bits).toBe(3063);
		expect(check({ name: "short-mpi.txt.sig", data: fixture("short-mpi.txt") })).toBe("ok");
		expect(check({ name: "short-mpi.txt.sig", data: fixture("textmode.txt") })).not.toBe("ok");
	});

	test("a valid SHA-1 signature is refused", () => {
		expect(check({ name: "test-sums.sha1.sig" })).toBe("hash-algorithm");
	});

	test("a valid text-mode signature (type 0x01) is refused: only binary documents", () => {
		expect(check({ name: "textmode.txt.sig", data: fixture("textmode.txt") })).toBe("signature-type");
	});

	test("unknown NON-critical hashed subpackets (notation, signer's user ID) are ignored; a critical unknown one is refused", () => {
		expect(check({ name: "test-sums.notation.sig" })).toBe("ok");
		expect(check({ name: "test-sums.critical.sig" })).toBe("critical-subpacket");
		// signature expiration: gpg marks it critical and Ccut does not evaluate it, so it is refused
		expect(check({ name: "test-sums.expires.sig" })).toBe("critical-subpacket");
	});

	test("other versions, types and algorithms in the packet are refused before anything else", () => {
		const real = ({ offset, value }) => verifyReal({ signature: withByte({ bytes: REAL_SIG, at: at(offset), value }) });
		expect(real({ offset: 0, value: 3 })).toBe("signature-version");
		expect(real({ offset: 0, value: 5 })).toBe("signature-version");
		expect(real({ offset: 0, value: 6 })).toBe("signature-version");
		expect(real({ offset: 1, value: 0x01 })).toBe("signature-type");
		expect(real({ offset: 1, value: 0x13 })).toBe("signature-type");
		expect(real({ offset: 1, value: 0x1f })).toBe("signature-type");
		expect(real({ offset: 2, value: 17 })).toBe("signature-algorithm"); // DSA
		expect(real({ offset: 2, value: 22 })).toBe("signature-algorithm"); // EdDSA
		expect(real({ offset: 3, value: 2 })).toBe("hash-algorithm"); // SHA-1
		expect(real({ offset: 3, value: 1 })).toBe("hash-algorithm"); // MD5
		expect(real({ offset: 3, value: 3 })).toBe("hash-algorithm"); // RIPEMD-160
		expect(real({ offset: 3, value: 11 })).toBe("hash-algorithm"); // SHA-224
		expect(real({ offset: 3, value: 12 })).toBe("hash-algorithm"); // SHA3-256 (not allowed here)
	});
});

describe("hostile signature files: every length is bounded, every failure is an OpenPgpError", () => {
	const reason = (signature) => verifyReal({ signature });

	test("every truncation of the real signature is refused (never another kind of error)", () => {
		for (let length = 0; length < REAL_SIG.length; length++) {
			const got = reason(REAL_SIG.subarray(0, length));
			expect(got).not.toBe("ok");
			expect(got.startsWith("not an OpenPgpError")).toBe(false);
		}
	});

	test("lengths that point past the data: packet, hashed area, unhashed area, subpacket, MPI", () => {
		// old-format two-octet packet length 0xffff
		expect(reason(withByte({ bytes: withByte({ bytes: REAL_SIG, at: 1, value: 0xff }), at: 2, value: 0xff }))).toBe("packet-length");
		// old-format four-octet length 0xffffffff
		expect(reason(Buffer.concat([Buffer.from([0x8a, 0xff, 0xff, 0xff, 0xff]), BODY]))).toBe("packet-length");
		// new-format five-octet length 0xffffffff
		expect(reason(newFormat({ lengthBytes: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]) }))).toBe("packet-length");
		// hashed area length (body 4..5) larger than the packet
		expect(reason(withByte({ bytes: withByte({ bytes: REAL_SIG, at: at(4), value: 0xff }), at: at(5), value: 0xff }))).toBe("signature-structure");
		// unhashed area length (body 35..36) larger than the packet
		expect(reason(withByte({ bytes: REAL_SIG, at: at(35), value: 0xff }))).toBe("signature-structure");
		// first hashed subpacket length 0x16 -> 0xbf: past the 29-byte hashed area
		expect(reason(withByte({ bytes: REAL_SIG, at: at(6), value: 0xbf }))).toBe("subpacket");
		// first hashed subpacket: a five-octet length (0xff, then 0x2104ac0c from the bytes after it)
		expect(reason(withByte({ bytes: REAL_SIG, at: at(6), value: 0xff }))).toBe("subpacket");
		// a subpacket of length 0 (no type octet)
		expect(reason(withByte({ bytes: REAL_SIG, at: at(6), value: 0x00 }))).toBe("subpacket");
		// MPI bit count (body 49..50) larger than what follows
		expect(reason(withByte({ bytes: REAL_SIG, at: at(49), value: 0xff }))).toBe("mpi");
	});

	test("header forms that a signature file never needs: partial lengths, indeterminate length, not a packet, reserved tag 0", () => {
		expect(reason(newFormat({ lengthBytes: Buffer.from([0xe0]) }))).toBe("partial-length");
		expect(reason(newFormat({ lengthBytes: Buffer.from([0xfe]) }))).toBe("partial-length");
		expect(reason(Buffer.concat([Buffer.from([0x8b]), BODY]))).toBe("indeterminate-length");
		expect(reason(withByte({ bytes: REAL_SIG, at: 0, value: 0x09 }))).toBe("packet-header");
		expect(reason(withByte({ bytes: REAL_SIG, at: 0, value: 0x81 }))).toBe("packet-header"); // old format, tag 0
	});

	test("exactly one signature packet: two, another packet kind, or trailing bytes are refused", () => {
		expect(reason(Buffer.concat([REAL_SIG, REAL_SIG]))).toBe("signature-structure");
		expect(reason(Buffer.concat([REAL_SIG, Buffer.from([0x00])]))).toBe("packet-header");
		expect(reason(withByte({ bytes: REAL_SIG, at: 0, value: 0xad }))).toBe("signature-structure"); // tag 11, literal data
		expect(reason(Buffer.alloc(0))).toBe("signature-structure");
		const many = Buffer.concat(Array.from({ length: LIMITS.maxPackets + 1 }, () => Buffer.from([0xc2, 0x00])));
		expect(reason(many)).toBe("too-many-packets");
	});

	test("the MPI: a leading zero bit count, bytes after it, a value longer than the modulus", () => {
		// 4096 bits announced as 4095: same byte count, but the top byte has a bit set above the count
		expect(reason(withByte({ bytes: withByte({ bytes: REAL_SIG, at: at(49), value: 0x0f }), at: at(50), value: 0xff }))).toBe("mpi");
		// announced as 4097: one byte more than there is
		expect(reason(withByte({ bytes: REAL_SIG, at: at(50), value: 0x01 }))).toBe("mpi");
		// one extra byte after the MPI (packet length + 1)
		const longer = Buffer.concat([REAL_SIG, Buffer.from([0])]);
		longer.writeUInt16BE(REAL_SIG.readUInt16BE(1) + 1, 1);
		expect(reason(longer)).toBe("trailing-bytes");
		// a 4104-bit value (one byte more than the 4096-bit modulus), same structure otherwise
		const value = Buffer.alloc(513, 0x7f);
		value[0] = 0x80;
		const body = Buffer.concat([BODY.subarray(0, 49), Buffer.from([0x10, 0x08]), value]);
		expect(reason(Buffer.concat([Buffer.from([0x89, body.length >> 8, body.length & 0xff]), body]))).toBe("signature-size");
		// a zero-bit MPI
		const empty = Buffer.concat([BODY.subarray(0, 49), Buffer.from([0x00, 0x00])]);
		expect(reason(Buffer.concat([Buffer.from([0x88, empty.length]), empty]))).toBe("mpi");
	});

	test("hashed area rules: creation time and issuer fingerprint exactly once and well formed", () => {
		// hashed subpackets: [6] length 22, [7] type 33, [8] version 4, [9..28] fingerprint; [29] length 5, [30] type 2, [31..34] time
		expect(reason(withByte({ bytes: REAL_SIG, at: at(7), value: 0x80 | 30 }))).toBe("critical-subpacket"); // issuer fpr turned into critical "features"
		expect(reason(withByte({ bytes: REAL_SIG, at: at(7), value: 30 }))).toBe("issuer"); // no issuer fingerprint left
		expect(reason(withByte({ bytes: REAL_SIG, at: at(30), value: 30 }))).toBe("creation-time"); // no creation time left
		expect(reason(withByte({ bytes: REAL_SIG, at: at(30), value: 33 }))).toBe("issuer"); // two issuer fingerprints
		expect(reason(withByte({ bytes: REAL_SIG, at: at(7), value: 2 }))).toBe("creation-time"); // a 21-byte "creation time"
		expect(reason(withByte({ bytes: REAL_SIG, at: at(8), value: 5 }))).toBe("issuer"); // v5 issuer fingerprint
	});

	test("oversized input is refused before parsing; non-bytes are refused", () => {
		expect(reason(Buffer.alloc(LIMITS.maxSignatureBytes + 1, 0x89))).toBe("signature-size");
		expect(reason("not bytes")).toBe("signature-size");
		expect(reasonOf(() => verifyDetachedSignature({ data: "text", signature: REAL_SIG, key: ytDlpKey() }))).toBe("input");
	});
});

describe("keys and armor", () => {
	const armored = YT_DLP_SIGNING_KEY_ARMORED;
	const keyBytes = dearmor({ text: armored, label: "PGP PUBLIC KEY BLOCK" });

	test("the armor decodes to the key block (packet 6, user ID 13, self-signature 2) and its CRC24 matches", () => {
		expect(keyBytes[0]).toBe(0x99);
		expect(parsePublicKey({ bytes: keyBytes }).fingerprint).toBe(YT_DLP_FINGERPRINT);
		// surrounding white space and CRLF line ends are fine
		expect(dearmor({ text: `\n\n${armored.replace(/\n/g, "\r\n")}\n`, label: "PGP PUBLIC KEY BLOCK" })).toEqual(keyBytes);
	});

	test("broken armor is refused: wrong label, no end line, bad CRC, bad base64, text around it, too long", () => {
		const lines = armored.trim().split("\n");
		const crcLine = lines.findIndex((line) => /^=[A-Za-z0-9+/]{4}$/.test(line));
		expect(crcLine).toBeGreaterThan(0);
		const variants = [
			armored.replace("PUBLIC KEY BLOCK-----\n", "SIGNATURE-----\n"),
			lines.slice(0, -1).join("\n"),
			[...lines.slice(0, crcLine), "=AAAA", ...lines.slice(crcLine + 1)].join("\n"),
			[...lines.slice(0, 3), `${lines[3].slice(0, 10)}*${lines[3].slice(11)}`, ...lines.slice(4)].join("\n"),
			[...lines.slice(0, 3), `${lines[3]}=`, ...lines.slice(4)].join("\n"),
			`hello\n${armored}`,
			`${armored}\nbye`,
			`${armored}\n${armored}`,
			armored.replace("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n", "-----BEGIN PGP PUBLIC KEY BLOCK-----\n"),
			`${"x".repeat(LIMITS.maxArmorChars + 1)}`,
			42,
		];
		for (const text of variants) expect(reasonOf(() => dearmor({ text, label: "PGP PUBLIC KEY BLOCK" }))).toBe("armor");
		// an armor header line ("Comment: ...") before the blank line is allowed
		const withHeader = armored.replace("-----BEGIN PGP PUBLIC KEY BLOCK-----\n", "-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: yt-dlp\n");
		expect(dearmor({ text: withHeader, label: "PGP PUBLIC KEY BLOCK" })).toEqual(keyBytes);
	});

	// A public key packet built by hand: v4, time, algorithm, n, e.
	const mpi = (bytes) => Buffer.concat([Buffer.from([(bytes.length * 8 - Math.clz32(bytes[0]) + 24) >> 8, (bytes.length * 8 - Math.clz32(bytes[0]) + 24) & 0xff]), bytes]);
	const keyPacket = ({ version = 4, algorithm = 1, n, e = Buffer.from([1, 0, 1]), extra = Buffer.alloc(0) }) => {
		const body = Buffer.concat([Buffer.from([version, 0x63, 0xfb, 0xf0, 0x2e, algorithm]), mpi(n), mpi(e), extra]);
		return Buffer.concat([Buffer.from([0x99, body.length >> 8, body.length & 0xff]), body]);
	};
	const modulus = (bytes) => Buffer.concat([Buffer.from([0xc1]), Buffer.alloc(bytes - 1, 0x35)]);

	test("key packet rules: v4, RSA, 2048..8192 bits, an odd exponent of at most 64 bits, nothing after", () => {
		const key = (options) => reasonOf(() => parsePublicKey({ bytes: keyPacket(options) }));
		expect(key({ n: modulus(256) })).toBe("ok");
		expect(key({ n: modulus(1024) })).toBe("ok");
		expect(key({ algorithm: 3, n: modulus(256) })).toBe("ok"); // RSA sign-only
		expect(key({ version: 3, n: modulus(256) })).toBe("key-version");
		expect(key({ version: 5, n: modulus(256) })).toBe("key-version");
		expect(key({ algorithm: 2, n: modulus(256) })).toBe("key-algorithm"); // RSA encrypt-only
		expect(key({ algorithm: 17, n: modulus(256) })).toBe("key-algorithm"); // DSA
		expect(key({ algorithm: 22, n: modulus(256) })).toBe("key-algorithm"); // EdDSA
		expect(key({ n: modulus(255) })).toBe("key-size"); // 2040 bits
		expect(key({ n: modulus(1025) })).toBe("key-size"); // 8200 bits
		expect(key({ n: modulus(256), e: Buffer.from([1, 0, 0]) })).toBe("key-exponent"); // even
		expect(key({ n: modulus(256), e: Buffer.from([1]) })).toBe("key-exponent");
		expect(key({ n: modulus(256), e: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 1]) })).toBe("key-exponent"); // 65 bits
		expect(key({ n: modulus(256), extra: Buffer.from([0]) })).toBe("trailing-bytes");
	});

	test("key block rules: the primary key first, one primary key, only user IDs, signatures, subkeys and user attributes after it", () => {
		const block = (...parts) => reasonOf(() => parsePublicKey({ bytes: Buffer.concat(parts) }));
		const primary = keyPacket({ n: modulus(256) });
		const userId = Buffer.from([0xb4, 0x01, 0x41]);
		expect(block(primary, userId)).toBe("ok");
		expect(block(userId, primary)).toBe("key-structure");
		expect(block(primary, primary)).toBe("key-structure");
		expect(block(primary, Buffer.from([0xac, 0x01, 0x00]))).toBe("key-structure"); // literal data (tag 11)
		expect(block(Buffer.alloc(0))).toBe("key-structure");
		expect(block(primary.subarray(0, 100))).toBe("packet-length");
		expect(reasonOf(() => parsePublicKey({ bytes: Buffer.alloc(LIMITS.maxKeyBytes + 1, 0x99) }))).toBe("key-structure");
	});
});
