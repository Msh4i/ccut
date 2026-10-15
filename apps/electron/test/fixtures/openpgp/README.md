# OpenPGP fixtures (link import: yt-dlp release signature)

Used by `link-import-openpgp.test.js`, `link-import-tool.test.js` and `link-import-ipc.test.js`.
gpg is NOT needed to run the tests: every file here is committed.

`.gitattributes` marks this directory `-text`: the signatures cover exact bytes, so git must
never convert line endings here (a Windows checkout with `core.autocrlf` would otherwise turn
the LF of the sums files into CRLF and every signature check would fail).

## Real yt-dlp files (public)
- `yt-dlp-2026.08.19.SHA2-256SUMS`, `yt-dlp-2026.08.19.SHA2-256SUMS.sig`: the release assets of
  https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19, byte for byte (compared with a fresh
  download on 2026-10-05). `gpg --verify` with the key from
  https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/public.key says "Good signature from
  Simon Sawicki (yt-dlp signing key)", primary key fingerprint
  `AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581`. RSA 4096, SHA-512, signature type 0x00,
  old-format packet header, issuer fingerprint in the hashed area.

## Test key files (made once by `make-fixtures.sh`, GnuPG 2.4.4)
The test key is a throwaway RSA 3072 signing key, fingerprint
`9A837733E6D8970CF21377578E3B95A0078605B9`; its secret half was deleted with the temporary
GNUPGHOME. It is never trusted by Ccut: it stands for "another key" and lets the tests build
install flows for files they control.

| File | What it is | Expected |
|---|---|---|
| `test-key.asc` | the test public key (armored) | parses; its fingerprint is not yt-dlp's |
| `release.sh` | stand-in for the `yt-dlp_linux` binary (a shell script) | - |
| `test-sums` | sha256 sums: `release.sh` as `yt-dlp_linux` and `yt-dlp_macos` | - |
| `test-sums.sig` | SHA-256 | good |
| `test-sums.sha384.sig` | SHA-384 | good |
| `test-sums.sha1.sig` | SHA-1, otherwise valid | refused (hash algorithm) |
| `test-sums.notation.sig` | non-critical notation (and signer's user ID) | good: unknown non-critical subpackets are ignored |
| `test-sums.critical.sig` | CRITICAL notation | refused (critical subpacket) |
| `test-sums.expires.sig` | signature expiration (gpg marks it critical) | refused (critical subpacket, not evaluated) |
| `textmode.txt`, `textmode.txt.sig` | text-mode signature (type 0x01) over data without line endings (canonical form = the bytes) | refused (signature type) |
| `short-mpi.txt`, `.sig` | a signature whose RSA value is 3063 bits (a leading zero octet: the MPI is 383 octets, the modulus 384); the script signs numbered texts until one is that short | good: the value is left-padded before RSA verification |
| `mismatch-sums`, `.sig` | signed sums whose `yt-dlp_linux` hash is all zeros | signature good, binary hash mismatch |
| `no-linux-sums`, `.sig` | signed sums without a `yt-dlp_linux` entry | signature good, no entry |
| `yt-dlp-2026.08.19.SHA2-256SUMS.by-test-key.sig` | the REAL sums signed by the test key | refused against the yt-dlp key (issuer) |

`make-fixtures.sh` prints gpg's own verdict for each signature; at creation every one was
"Good signature" except `test-sums.critical.sig` ("assuming bad signature ... due to an unknown
critical bit"). Running it again makes a new key: the fingerprint above and the tests that pin
it must then be updated.
