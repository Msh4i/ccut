#!/bin/sh
# Regenerates the TEST-KEY fixtures of this directory with GnuPG (see README.md). Run once by
# hand when a fixture must change; the tests never run gpg. The real yt-dlp files
# (yt-dlp-2026.08.19.*) are copies of the release assets and are not touched here.
set -eu
cd "$(dirname "$0")"
GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
UID_TEXT="Ccut link import tests (test key, never trusted) <tests@ccut.invalid>"
gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key "$UID_TEXT" rsa3072 sign never
gpg --armor --export "$UID_TEXT" > test-key.asc
sign() { # sign <output> <input> [extra gpg options...]
	out=$1
	in=$2
	shift 2
	rm -f "$out"
	gpg --batch --yes --pinentry-mode loopback --passphrase '' --local-user "$UID_TEXT" --output "$out" "$@" --detach-sign "$in"
}

sha=$(sha256sum release.sh | cut -d' ' -f1)
zero=0000000000000000000000000000000000000000000000000000000000000000
printf '%s  yt-dlp\n%s  yt-dlp.exe\n%s  yt-dlp_linux\n%s  yt-dlp_macos\n' "$zero" "$zero" "$sha" "$sha" > test-sums
printf '%s  yt-dlp\n%s  yt-dlp_linux\n' "$sha" "$zero" > mismatch-sums
printf '%s  yt-dlp.exe\n' "$sha" > no-linux-sums
printf 'Ccut text-mode test, no line ending' > textmode.txt

sign test-sums.sig test-sums --digest-algo SHA256
sign test-sums.sha384.sig test-sums --digest-algo SHA384
sign test-sums.sha1.sig test-sums --digest-algo SHA1
sign test-sums.notation.sig test-sums --digest-algo SHA256 --sig-notation 'ccut@tests.invalid=plain'
sign test-sums.critical.sig test-sums --digest-algo SHA256 --sig-notation '!ccut@tests.invalid=critical'
sign test-sums.expires.sig test-sums --digest-algo SHA256 --default-sig-expire 1y
sign mismatch-sums.sig mismatch-sums --digest-algo SHA256
sign no-linux-sums.sig no-linux-sums --digest-algo SHA256
sign textmode.txt.sig textmode.txt --digest-algo SHA256 --textmode
sign yt-dlp-2026.08.19.SHA2-256SUMS.by-test-key.sig yt-dlp-2026.08.19.SHA2-256SUMS --digest-algo SHA512
# A signature whose RSA value has a leading zero octet (about 1 in 256): its MPI is one octet
# shorter than the 384-octet modulus, so the verifier must left-pad it.
i=0
while [ "$i" -lt 4000 ]; do
	printf 'Ccut short MPI test %s' "$i" > short-mpi.txt
	sign short-mpi.txt.sig short-mpi.txt --digest-algo SHA256
	bits=$(gpg --list-packets short-mpi.txt.sig | sed -n 's/.*data: \[\([0-9]*\) bits\].*/\1/p')
	[ "$bits" -le 3064 ] && break
	i=$((i + 1))
done
echo "short-mpi.txt: attempt $i, RSA value $bits bits"

gpg --with-colons --fingerprint "$UID_TEXT" | awk -F: '$1 == "fpr" { print "test key fingerprint: " $10; exit }'
for pair in test-sums.sig:test-sums test-sums.sha384.sig:test-sums test-sums.sha1.sig:test-sums test-sums.notation.sig:test-sums \
	test-sums.critical.sig:test-sums test-sums.expires.sig:test-sums mismatch-sums.sig:mismatch-sums no-linux-sums.sig:no-linux-sums \
	textmode.txt.sig:textmode.txt short-mpi.txt.sig:short-mpi.txt yt-dlp-2026.08.19.SHA2-256SUMS.by-test-key.sig:yt-dlp-2026.08.19.SHA2-256SUMS; do
	printf '%s: ' "${pair%%:*}"
	gpg --batch --verify "${pair%%:*}" "${pair#*:}" 2>&1 | grep -E 'Good signature|BAD signature|critical' | head -1 || echo "(no good signature line)"
done
