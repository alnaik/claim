"""claim's picture: which slice of the page to show, and the PNG drawn from it (core.py stops 6 and 7)."""

import textwrap

import pymupdf

COLORS = {"exact": (0.13, 0.72, 0.33), "partial": (1.0, 0.65, 0.0), "not found": (0.8, 0.15, 0.15),
          "not searchable": (0.55, 0.57, 0.6)}
DARK = (0.13, 0.14, 0.16)
WHITE = (1, 1, 1)
SCALE = 2           # render at 2x so text is crisp on high-res screens
HEADER = 18         # header line height in points (36px at 2x)
LINES = 2           # whole lines of text kept above and below the hit
MARGIN = 12         # points kept left and right of the text
MIN_VIEW = 280      # a table is never shown shorter than this, so its header row stays in view


# [stop 6] Choose how much of the page to show.
# Close in on the hit: the hit's lines and two whole lines either side, and only as wide as
# the text around it (one column of a two-column paper), so the words are big enough to read
# in a terminal card. A table (`whole`) keeps a third of the page or more, full width, so its
# header row stays in view. Lines are never sliced in half at the edges, nor the page edge passed.
def region(page, rects, whole=False):
    box = page.rect
    if not rects:
        return box
    hit = pymupdf.Rect(rects[0])
    for r in rects[1:]:
        hit |= r
    lines = text_lines(page)
    if whole:
        height = max(box.height / 3, hit.height + 40, MIN_VIEW)
        top = max(min((hit.y0 + hit.y1) / 2 - height / 2, box.y1 - height), box.y0)
        bottom, near = top + height, []
        # An edge inside a line moves out to take the line whole, once: lines overlap a little,
        # so moving again from the new edge would walk up (or down) the whole column.
        top = min([top] + [line.y0 - 2 for line in lines if line.y0 < top < line.y1])
        bottom = max([bottom] + [line.y1 + 2 for line in lines if line.y0 < bottom < line.y1])
    else:
        # The text lines of the hit's column (they overlap it left to right), one per row:
        # justified text comes back a word at a time, and a row's words share its top edge.
        column = sorted((line for line in lines if line.x0 < hit.x1 and line.x1 > hit.x0), key=lambda r: r.y0)
        rows = []
        for line in column:
            if rows and abs(line.y0 - rows[-1].y0) < 2:
                rows[-1] |= line
            else:
                rows.append(pymupdf.Rect(line))
        mid = [(r.y0 + r.y1) / 2 for r in rows]
        above = [i for i, m in enumerate(mid) if m < hit.y0][-LINES:]
        below = [i for i, m in enumerate(mid) if m > hit.y1][:LINES]
        # Line boxes overlap a little, the empty top of one under the last of the line above:
        # cut at the bottom of the line above, so no sliver of its letters shows.
        top = max(rows[above[0]].y0, rows[above[0] - 1].y1 if above[0] else 0) if above else hit.y0 - 4
        bottom = rows[below[-1]].y1 + 1 if below else hit.y1 + 4
        near = [r for r, m in zip(rows, mid) if top < m < bottom]
    left = min([hit.x0] + [r.x0 for r in near]) - MARGIN if not whole else box.x0
    right = max([hit.x1] + [r.x1 for r in near]) + MARGIN if not whole else box.x1
    return pymupdf.Rect(max(left, box.x0), max(top, box.y0), min(right, box.x1), min(bottom, box.y1))


def text_lines(page):
    blocks = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP)["blocks"]
    return [pymupdf.Rect(line["bbox"]) for b in blocks for line in b.get("lines", [])]


# [stop 7] Draw the picture.
# First the crop: a 2x photo of the chosen slice of the page, the way a PDF viewer
# would show it (stamps, highlights and filled-in form fields too), with see-through
# coloured boxes over each hit. The PNG is that crop under a dark header strip.
# A not-found result gets a red header, the whole page untouched, and the quote
# printed in a box underneath, so the reader can look for it themselves.
# For a web page found in the browser, `shot` is the browser's own picture and is used as the crop.
def render(page, rects, status, where, quote, matched, shot=None, whole=False):
    if shot:
        size = pymupdf.Pixmap(shot)
        clip, crop = pymupdf.Rect(0, 0, size.width / SCALE, size.height / SCALE), shot
    else:
        clip = region(page, rects, whole) if page else pymupdf.Rect(0, 0, 595, 0)
        crop = photo(page, clip, rects, status) if page else None
    lines = [f"{status}  ·  " + where.replace(" · ", "  ·  ")]
    if status == "partial":
        lines.append(f'matched: "{shorten(matched, int(clip.width / 5.2))}"')
    head = HEADER * len(lines)
    box = []
    if status == "not found":
        box = textwrap.wrap(f'quote: "{" ".join(quote.split())}"', width=int(clip.width / 5.6))
    box_h = 14 * len(box) + 24 if box else 0

    out = pymupdf.open()
    canvas = out.new_page(width=clip.width, height=head + clip.height + box_h)
    canvas.draw_rect(pymupdf.Rect(0, 0, clip.width, head), color=None,
                     fill=COLORS[status] if status == "not found" else DARK)
    canvas.draw_rect(pymupdf.Rect(0, 0, 6, head), color=None, fill=COLORS[status])
    for i, line in enumerate(lines):
        canvas.insert_text((14, HEADER * i + 12.5), shorten(line, int(clip.width / 5.2)), fontsize=10, fontname="helv", color=WHITE)
    if crop:
        canvas.insert_image(pymupdf.Rect(0, head, clip.width, head + clip.height), stream=crop)
    if box:
        top = head + clip.height
        canvas.draw_rect(pymupdf.Rect(0, top, clip.width, top + box_h), color=None, fill=(0.96, 0.94, 0.94))
        canvas.draw_line((0, top), (clip.width, top), color=COLORS[status], width=1.5)
        for i, line in enumerate(box):
            canvas.insert_text((14, top + 20 + 14 * i), line, fontsize=10, fontname="helv", color=DARK)
    return canvas.get_pixmap(matrix=pymupdf.Matrix(SCALE, SCALE)).tobytes("png"), crop


def photo(page, clip, rects, status):
    """The page slice at 2x with the highlight boxes on it: the picture without header or quote box."""
    shot = page.get_pixmap(clip=clip, matrix=pymupdf.Matrix(SCALE, SCALE), annots=True)
    canvas = pymupdf.open().new_page(width=clip.width, height=clip.height)
    canvas.insert_image(canvas.rect, pixmap=shot)
    for r in rects:
        trim = r.height * 0.1  # lines overlap slightly; trimming avoids darker stripes between them
        canvas.draw_rect(pymupdf.Rect(r.x0, r.y0 + trim, r.x1, r.y1 - trim) - (clip.x0, clip.y0, clip.x0, clip.y0),
                         color=None, fill=COLORS[status], fill_opacity=0.35)
    return canvas.get_pixmap(matrix=pymupdf.Matrix(SCALE, SCALE)).tobytes("png")


def shorten(text, n):
    return text if len(text) <= n else text[: n - 3] + "..."
