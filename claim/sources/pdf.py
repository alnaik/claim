"""PDF source: PyMuPDF opens it directly. Every other source turns into one of these."""

import pymupdf

from claim import core


def load(path):
    return pymupdf.open(path)


def context(page, rects):
    """The page's own lines around a hit, for a card that can't show the picture: the lines a hit box
    covers, one either side, as [first, last] and [[n, text], ...], n counting from the page's top."""
    if not rects:
        return None, None  # not found: the card shows the quote instead
    lines = []  # (box, text) per line, in PyMuPDF's order
    for block in page.get_text("dict", flags=core.TEXT_FLAGS)["blocks"]:
        for line in block.get("lines", []):
            box, words = pymupdf.Rect(line["bbox"]), "".join(s["text"] for s in line["spans"]).strip()
            if lines and abs(lines[-1][0].y0 - box.y0) < 2 and box.x0 - lines[-1][0].x1 < 20:  # justified text: a word at a time
                lines[-1] = (lines[-1][0] | box, f"{lines[-1][1]} {words}")
            else:
                lines.append((box, words))
    # A hit box covers most of a line's height; one that only grazes its edge is the line above or below.
    hits = [n for n, (box, _) in enumerate(lines, 1) if any(box.intersects(r) and (box & r).height > box.height / 2 for r in rects)]
    if not hits:
        return None, None
    first, last = min(hits), max(hits)
    shown = range(max(first - 1, 1), min(last + 1, len(lines)) + 1)
    return [first, last], [[n, lines[n - 1][1]] for n in shown]
