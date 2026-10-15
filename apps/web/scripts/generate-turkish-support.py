#!/usr/bin/env python3
"""Writes apps/web/public/fonts/turkish-support.json.

The file lists the picker's catalog families (public/fonts/font-atlas.json)
whose Regular (400) has every Turkish letter: Ç ç Ğ ğ ı İ Ö ö Ş ş Ü ü.

How it is measured: for each catalog family the 400 normal WOFF2 files of the
`latin` and `latin-ext` subsets are read from the @fontsource/<id> npm package
(through jsDelivr), and the union of their cmaps must contain all twelve
letters. Families without a `latin-ext` subset are checked on `latin` alone;
some of them still pass. These are the same package files, at the same pinned
version (FONTSOURCE_VERSION, which must match public/fonts/files/manifest.json),
that the offline pack ships, so a rerun gives the same list.

Failures are never read as "not ready": a request is retried, only a 404 means
"no such file", and any other failure (or a family without any `latin` file)
makes the script list the families and exit 1 without writing anything.

Last run (2026-10-03, @fontsource 5.3.0): 1354 of 1920 catalog families have all
the letters: 1247 of those have a latin-ext subset, 107 are latin only.

Usage: python3 apps/web/scripts/generate-turkish-support.py [--cache DIR]
Needs: fonttools and brotli (pip install fonttools brotli).
DIR holds fontsource.json and <version>/<id>-<subset>-400-normal.woff2, so a
rerun with the same DIR makes no request. Default: apps/web/.font-cache/turkish
(git-ignored).
"""

import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fontTools.ttLib import TTFont

WEB = Path(__file__).resolve().parent.parent
LETTERS = "ÇçĞğıİÖöŞşÜü"
FONTSOURCE_API = "https://api.fontsource.org/v1/fonts"
FONTSOURCE_VERSION = "5.3.0"
WOFF2_URL = "https://cdn.jsdelivr.net/npm/@fontsource/{id}@{version}/files/{id}-{subset}-400-normal.woff2"


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


def cached(cache: Path, url: str, name: str) -> bytes | None:
    path = cache / name
    if path.exists():
        return path.read_bytes()
    data = get(url)
    if data is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return data


def measure(cache: Path, font: dict) -> tuple[set[int], list[str]]:
    """The code points of the family and the subsets that have no file (404)."""
    found: set[int] = set()
    absent: list[str] = []
    for subset in ("latin", "latin-ext"):
        if subset not in font["subsets"]:
            continue
        name = f"{FONTSOURCE_VERSION}/{font['id']}-{subset}-400-normal.woff2"
        url = WOFF2_URL.format(id=font["id"], version=FONTSOURCE_VERSION, subset=subset)
        data = cached(cache, url, name)
        if data is None:
            absent.append(subset)
        else:
            found |= set(TTFont(io.BytesIO(data)).getBestCmap())
    return found, absent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=WEB / ".font-cache" / "turkish")
    cache = parser.parse_args().cache

    pack = json.loads((WEB / "public/fonts/files/manifest.json").read_text("utf-8"))
    versions = {entry["version"] for entry in pack.values()}
    if versions != {FONTSOURCE_VERSION}:
        raise SystemExit(f"The pack uses {sorted(versions)}, this script is pinned to {FONTSOURCE_VERSION}")

    catalog = json.loads((WEB / "public/fonts/font-atlas.json").read_text("utf-8"))["fonts"]
    listing = cache / "fontsource.json"
    if not listing.exists():
        data = get(FONTSOURCE_API)
        if data is None:
            raise SystemExit("Could not read the Fontsource font list (404)")
        listing.parent.mkdir(parents=True, exist_ok=True)
        listing.write_bytes(data)
    fonts = {f["family"]: f for f in json.loads(listing.read_text("utf-8")) if f["type"] == "google"}

    missing = sorted(set(catalog) - set(fonts))
    if missing:
        raise SystemExit(f"Not in Fontsource: {missing}")

    names = sorted(catalog)

    def run(name: str) -> tuple[set[int], list[str]] | Exception:
        try:
            return measure(cache, fonts[name])
        except Exception as error:  # reported below, never read as "not ready"
            return error

    with ThreadPoolExecutor(16) as pool:
        outcomes = list(pool.map(run, names))

    failed = [(n, str(o)) for n, o in zip(names, outcomes) if isinstance(o, Exception)]
    no_latin = [n for n, o in zip(names, outcomes) if not isinstance(o, Exception) and "latin" in o[1]]
    if failed or no_latin:
        for name, error in failed:
            print(f"FAILED {name}: {error}", file=sys.stderr)
        for name in no_latin:
            print(f"NO latin FILE at {FONTSOURCE_VERSION}: {name}", file=sys.stderr)
        sys.exit(f"{len(failed) + len(no_latin)} families could not be measured; nothing written")

    ready = [
        name
        for name, outcome in zip(names, outcomes)
        if all(ord(letter) in outcome[0] for letter in LETTERS)
    ]
    no_ext = {n for n in names if "latin-ext" not in fonts[n]["subsets"]}
    absent_ext = [n for n, o in zip(names, outcomes) if "latin-ext" in o[1]]

    out = WEB / "public/fonts/turkish-support.json"
    out.write_text(json.dumps(ready, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    without_ext = sum(1 for n in ready if n in no_ext)
    print(
        f"{len(ready)} of {len(catalog)} catalog families have all Turkish letters "
        f"({len(ready) - without_ext} with latin-ext, {without_ext} latin only) -> {out}"
    )
    if absent_ext:
        print(f"latin-ext listed by Fontsource but 404 at {FONTSOURCE_VERSION}: {absent_ext}")


if __name__ == "__main__":
    main()
