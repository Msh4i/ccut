#!/usr/bin/env python3
"""Downloads the offline font pack into apps/web/public/fonts/files/.

For every family in FAMILIES (all verified to have the Turkish letters, see
generate-turkish-support.py) it takes the @fontsource/<id> npm package, pinned
to an exact version, through jsDelivr and keeps, UNMODIFIED:
  - the Regular (400) and Bold (700) normal-style WOFF2 files of the `latin`
    and `latin-ext` subsets (a weight the package lacks is skipped),
  - the package's LICENSE next to them.
It then writes files/manifest.json:
  { family: { id, version, weights, files: [{ weight, subset, url, unicodeRange, sha256 }] } }
The unicode ranges come from the package's own <weight>.css, so the browser
only fetches the subset a text needs. The app registers these files with
FontFace (src/fonts/google-fonts.ts); families not listed use Google's CSS.

Every file is checked: "wOF2" magic and the WOFF2 header length against the real
size, and its sha256 goes into the manifest (the tests compare it with the file on
disk). Every family/weight is checked to contain ç ğ ı İ ö ş ü Ç Ğ Ö Ş Ü: if one
does not, the script exits 1 and writes no manifest.
A version is the one already in manifest.json, otherwise npm's `latest` at the
time of the run, so reruns reproduce the same files (@latest is never fetched).
fontsource.json (the Fontsource font list) maps family names to package ids.

Usage: python3 apps/web/scripts/bundle-font-pack.py [--cache DIR] [--out DIR] [--notice FILE]
Needs: fonttools and brotli (pip install fonttools brotli).
  --cache  where fontsource.json lives (default apps/web/.font-cache/turkish)
  --out    default apps/web/public/fonts/files
  --notice also writes one attribution line per family (for THIRD_PARTY_NOTICES)
"""

import argparse
import hashlib
import io
import json
import re
import struct
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fontTools.ttLib import TTFont

WEB = Path(__file__).resolve().parent.parent
NPM_REGISTRY = "https://registry.npmjs.org/@fontsource/{id}/latest"
NPM_CDN = "https://cdn.jsdelivr.net/npm/@fontsource/{id}@{version}/{path}"
FONTSOURCE_API = "https://api.fontsource.org/v1/fonts"
WEIGHTS = (400, 700)
SUBSETS = ("latin", "latin-ext")
LETTERS = "ÇçĞğıİÖöŞşÜü"
MIN_FILE_BYTES = 1000

FAMILIES = """
Inter, Roboto, Open Sans, Montserrat, Poppins, Nunito, Raleway, Rubik, Barlow, Oswald,
Work Sans, DM Sans, Manrope, Outfit, Source Sans 3, Noto Sans, Fira Sans, Josefin Sans,
Quicksand, Mulish, Karla, Space Grotesk, Archivo,
Bebas Neue, Anton, Bangers, Lobster, Righteous, Bungee, Press Start 2P, Black Ops One,
Staatliches, Alfa Slab One, Abril Fatface, Baloo 2, Shrikhand, Monoton, Audiowide,
Archivo Black, Russo One, Paytone One, League Gothic, Teko, Comfortaa, Sigmar One,
Tilt Warp, Rubik Bubbles, Gabarito,
Playfair Display, Merriweather, Lora, Cinzel, DM Serif Display, Cormorant Garamond,
EB Garamond, Libre Baskerville, Bitter,
Pacifico, Caveat, Dancing Script, Great Vibes, Indie Flower, Shadows Into Light,
Patrick Hand, Kalam, Courgette, Sacramento, Amatic SC, Gloria Hallelujah, Parisienne,
Kaushan Script, Pangolin, Caveat Brush,
JetBrains Mono, Fira Code, Space Mono, Roboto Mono,
Luckiest Guy, Yellowtail, Special Elite
"""

FACE = re.compile(r"/\*[^*]*\*/\s*@font-face\s*\{(?P<body>[^}]*)\}")


def get(url: str) -> bytes | None:
    """The body, or None for a 404. Other failures are retried, then raised."""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if attempt == 3:
                raise
        except OSError:
            if attempt == 3:
                raise
        time.sleep(attempt + 1)
    return None


def check_woff2(data: bytes, name: str) -> None:
    if data[:4] != b"wOF2":
        raise ValueError(f"{name}: not a WOFF2 file")
    if len(data) < MIN_FILE_BYTES:
        raise ValueError(f"{name}: only {len(data)} bytes")
    if struct.unpack(">I", data[8:12])[0] != len(data):
        raise ValueError(f"{name}: WOFF2 header length differs from the {len(data)} bytes received")


def faces(css: str, font_id: str, weight: int) -> dict[str, dict]:
    """Subset -> {file, range} for the normal-style latin faces of a <weight>.css."""
    found = {}
    for match in FACE.finditer(css):
        body = match["body"]
        file = re.search(rf"url\(\./files/({re.escape(font_id)}-(.+)-{weight}-normal\.woff2)\)", body)
        unicode_range = re.search(r"unicode-range:\s*([^;]+);", body)
        if file and unicode_range and file[2] in SUBSETS:
            found[file[2]] = {"file": file[1], "range": unicode_range[1].strip()}
    return found


def build(name: str, font: dict, version: str, out: Path) -> tuple[dict, list[str]]:
    font_id = font["id"]
    folder = out / font_id
    folder.mkdir(parents=True, exist_ok=True)
    files, weights, problems = [], [], []
    points: dict[int, set[int]] = {}

    for weight in WEIGHTS:
        css = get(NPM_CDN.format(id=font_id, version=version, path=f"{weight}.css"))
        if css is None:
            continue
        found = faces(css.decode("utf-8"), font_id, weight)
        if "latin" not in found:
            problems.append(f"{name} {weight}: no latin face")
            continue
        weights.append(weight)
        points[weight] = set()
        for subset in SUBSETS:
            if subset not in found:
                continue
            data = get(NPM_CDN.format(id=font_id, version=version, path=f"files/{found[subset]['file']}"))
            if data is None:
                raise ValueError(f"{name}: {found[subset]['file']} is listed but missing")
            check_woff2(data, found[subset]["file"])
            local = f"{subset}-{weight}-normal.woff2"
            (folder / local).write_bytes(data)
            points[weight] |= set(TTFont(io.BytesIO(data)).getBestCmap())
            files.append(
                {
                    "weight": weight,
                    "subset": subset,
                    "url": f"/fonts/files/{font_id}/{local}",
                    "unicodeRange": found[subset]["range"],
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        lacking = [letter for letter in LETTERS if ord(letter) not in points[weight]]
        if lacking:
            problems.append(f"{name} {weight}: missing {''.join(lacking)}")

    license_text = get(NPM_CDN.format(id=font_id, version=version, path="LICENSE"))
    if license_text is None:
        raise ValueError(f"{name}: package has no LICENSE")
    (folder / "LICENSE").write_bytes(license_text)
    return {"id": font_id, "version": version, "weights": weights, "files": files}, problems


def pinned_version(font_id: str, known: dict) -> str:
    if font_id in known:
        return known[font_id]
    latest = get(NPM_REGISTRY.format(id=font_id))
    if latest is None:
        raise ValueError(f"@fontsource/{font_id} is not on npm")
    return json.loads(latest)["version"]


def attribution(folder: Path) -> str:
    """The copyright statements at the top of the package LICENSE, without the
    per-file repeats. A LICENSE without one (Apache texts, or a bare "Google Inc.")
    falls back to the copyright record of the font file itself, and says so."""
    text = (folder / "LICENSE").read_text("utf-8")
    top = re.split(r"This Font Software is licensed|Apache License", text)[0]
    top = re.sub(r"\S+\.ttf:\s*", "", " ".join(top.split()))
    statements: list[str] = []
    for part in re.split(r"(?=Copyright)", top):
        part = part.strip()
        if part.startswith("Copyright") and part not in statements:
            statements.append(part)
    if statements:
        return " ".join(statements)
    name = TTFont(folder / "latin-400-normal.woff2")["name"].getDebugName(0)
    return f"[LICENSE has no copyright line; font file says:] {' '.join(name.split())}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=WEB / ".font-cache" / "turkish")
    parser.add_argument("--out", type=Path, default=WEB / "public/fonts/files")
    parser.add_argument("--notice", type=Path)
    args = parser.parse_args()

    listing = args.cache / "fontsource.json"
    if not listing.exists():
        data = get(FONTSOURCE_API)
        if data is None:
            raise SystemExit("Could not read the Fontsource font list (404)")
        listing.parent.mkdir(parents=True, exist_ok=True)
        listing.write_bytes(data)
    fonts = {f["family"]: f for f in json.loads(listing.read_text("utf-8")) if f["type"] == "google"}

    names = [name.strip() for name in FAMILIES.replace("\n", " ").split(",") if name.strip()]
    absent = [name for name in names if name not in fonts]
    if absent:
        raise SystemExit(f"Not in Fontsource: {absent}")

    manifest_path = args.out / "manifest.json"
    previous = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {}
    known = {entry["id"]: entry["version"] for entry in previous.values()}

    args.out.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(8) as pool:
        results = list(
            pool.map(
                lambda name: build(name, fonts[name], pinned_version(fonts[name]["id"], known), args.out),
                names,
            )
        )

    manifest, problems = {}, []
    for name, (entry, issues) in zip(names, results):
        problems += issues
        if entry["weights"]:
            manifest[name] = entry
    if problems:
        for problem in problems:
            print("PROBLEM:", problem, file=sys.stderr)
        sys.exit(f"{len(problems)} problems; manifest not written")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", "utf-8")

    total = sum((args.out / e["id"] / Path(f["url"]).name).stat().st_size for e in manifest.values() for f in e["files"])
    count = sum(len(e["files"]) for e in manifest.values())
    print(f"{len(manifest)} families, {count} WOFF2 files, {total / 1e6:.2f} MB -> {args.out}")

    if args.notice:
        lines = [
            f"- {name} {entry['version']}: {fonts[name]['license']}. "
            f"{attribution(args.out / entry['id'])}"
            for name, entry in sorted(manifest.items())
        ]
        args.notice.write_text("\n".join(lines) + "\n", "utf-8")


if __name__ == "__main__":
    main()
