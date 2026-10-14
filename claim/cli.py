"""For testing: claim file.pdf "quote" --page 3  ->  writes out.png and prints the text line.
With --json it prints every field as one JSON object instead, with the crop saved to a temp file
(and a half-size copy of it as crop1x). claim-scan "<answer>" file... prints a JSON list of
the same objects, one per quote or figure the scan found in the answer (see scan.py)."""

import argparse
import json
import os
import tempfile
from pathlib import Path

import pymupdf

from claim import scan
from claim.core import claim
from claim.sources.url import scratch


def main():
    ap = argparse.ArgumentParser(prog="claim")
    ap.add_argument("file")
    ap.add_argument("quote")
    ap.add_argument("--page", type=int)
    ap.add_argument("--out", default="out.png")
    ap.add_argument("--json", action="store_true", help="print all fields as JSON; the crop goes to a temp file")
    args = ap.parse_args()
    result = claim(args.file, args.quote, args.page)
    if not args.json:
        Path(args.out).write_bytes(result["png"])
        print(result["text"])
        return
    print(json.dumps(dump(result), ensure_ascii=False))


def scan_main():
    ap = argparse.ArgumentParser(prog="claim-scan")
    ap.add_argument("answer", help="the answer's text")
    ap.add_argument("files", nargs="*", help="the files to look in, newest first")
    args = ap.parse_args()
    print(json.dumps([dump(r) for r in scan.scan(args.answer, args.files)], ensure_ascii=False))


def dump(result):
    """A result as plain JSON: the png left out, the crop written to a temp file and named."""
    result.pop("png")
    if result["crop"]:
        handle, crop = tempfile.mkstemp(prefix="crop-", suffix=".png", dir=scratch())
        os.write(handle, result["crop"])
        os.close(handle)
        result["crop"] = crop
        # A half-size copy for hosts that must carry the picture inline (the
        # plugin's desktop card), so it fits their size limit more often.
        half = pymupdf.Pixmap(crop)
        result["size"] = [half.width, half.height]  # so the plugin needn't open the picture to learn its shape
        half.shrink(1)
        handle, crop1x = tempfile.mkstemp(prefix="crop-", suffix="-1x.png", dir=scratch())
        os.close(handle)
        half.save(crop1x)
        result["crop1x"] = crop1x
    else:
        result["crop1x"] = result["size"] = None
    return result


if __name__ == "__main__":
    main()
