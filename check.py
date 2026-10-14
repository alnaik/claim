"""Run every case in fixtures/cases.yaml and print a table."""

import functools
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

from claim.core import claim
from claim.scan import scan

CASES = Path("fixtures/cases.yaml")
SCANS = Path("fixtures/scans.yaml")
OUT = Path("fixtures/out")


def main():
    server = serve_fixtures()  # cases can say {server}/paper.pdf to test downloading
    base = f"http://localhost:{server.server_port}"
    cases = yaml.safe_load(CASES.read_text().replace("{server}", base)) or []
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"{'file':<22}{'page':<6}{'expect':<16}{'got':<16}{'ms':<6}ok")
    passed = confident_wrong = 0
    for i, case in enumerate(cases):
        result, ms = run_case(case, i)
        got, at = result["status"], result["page"]
        wrong_place = "at" in case and got != "not found" and at != case["at"]
        wrong_lines = "lines" in case and result["lines"] != case["lines"]
        wrong_sheet = "sheet" in case and result.get("sheet") != case["sheet"]
        wrong_link = "link" in case and result.get("link") != case["link"]
        wrong_cells = "cells" in case and (result["excerpt"] or {}).get("cells") != case["cells"]
        wrong_header = "header" in case and (result["excerpt"] or {}).get("header") != case["header"]
        wrong_matched = "matched" in case and result["matched"] != case["matched"]
        ok = (got == case["expect"] and not wrong_place and not wrong_lines and not wrong_sheet and not wrong_link
              and not wrong_cells and not wrong_header and not wrong_matched)
        passed += ok
        if got == "exact" and (case["expect"] != "exact" or wrong_place or wrong_cells):
            confident_wrong += 1
        page = case.get("page") or "-"
        name = ("url:" if case["file"].startswith("http") else "") + Path(case["file"]).name
        print(f"{name:<22}{page!s:<6}{case['expect']:<16}{got:<16}{ms:<6}{'✓' if ok else '✗'}")
    scanned = 0
    for scan_ in yaml.safe_load(SCANS.read_text()) or []:
        start = time.perf_counter()
        found = scan(scan_["answer"], scan_["files"])
        ms = round((time.perf_counter() - start) * 1000)
        for kind, status, piece, *places in scan_["find"]:
            hits = [r for r in found if r["kind"] == kind and (piece == r["quote"] if kind == "figure" else piece.lower() in r["quote"].lower())]
            # a made-up quote must leave no record at all, since no file was ever involved
            ok = (not hits) if status == "not found" and kind == "quote" else any(r["status"] == status for r in hits)
            # a number after it: how many places hold the figure; words: what its text line must say
            ok = ok and (not places or any(r["places"] == places[0] if isinstance(places[0], int) else places[0] in r.get("text", "") for r in hits))
            got = hits[0]["status"] if hits else "no record"
            scanned += 1; passed += ok
            if got == "exact" and status != "exact":
                confident_wrong += 1
            print(f"{'scan':<22}{'-':<6}{status:<16}{got:<16}{ms:<6}{'✓' if ok else '✗'}  {piece[:40]}")
        for token in scan_["skip"] + scan_.get("never", []):
            ok = not any(r["quote"] == token or (token in scan_.get("never", []) and token in r["quote"]) for r in found)
            scanned += 1; passed += ok
            print(f"{'scan':<22}{'-':<6}{'no record':<16}{'no record' if ok else 'record':<16}{'':<6}{'✓' if ok else '✗'}  {token}")
    print(f"{passed}/{len(cases) + scanned} passed. {confident_wrong} confident-wrong.")


def serve_fixtures():
    """A tiny local web server for the fixtures folder, so URL cases work offline."""
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory="fixtures")
    server = ThreadingHTTPServer(("localhost", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_case(case, i):
    """Run one case, save its picture to fixtures/out/, return (result, ms)."""
    start = time.perf_counter()
    result = claim(case["file"], case["quote"], case.get("page"))
    ms = round((time.perf_counter() - start) * 1000)
    (OUT / f"{i + 1:02d}-{Path(case['file'].split('#')[0]).stem}.png").write_bytes(result["png"])
    return result, ms


if __name__ == "__main__":
    main()
