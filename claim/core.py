"""claim core: load -> search -> region -> render.

Read the numbered [stop N] comments in order.
"""

import hashlib
import re
import textwrap
from pathlib import Path

import pymupdf

from claim.sources import html, image, pdf, table, text, url

COLORS = {"exact": (0.13, 0.72, 0.33), "partial": (1.0, 0.65, 0.0), "not found": (0.8, 0.15, 0.15),
          "not searchable": (0.55, 0.57, 0.6)}
DARK = (0.13, 0.14, 0.16)
WHITE = (1, 1, 1)
SCALE = 2           # render at 2x so text is crisp on high-res screens
HEADER = 18         # header line height in points (36px at 2x)
LONG_QUOTE = 400    # above this, search_for gets unreliable, so skip the full-quote search
MIN_SENTENCE = 5    # a "sentence" shorter than this many words is too common to trust
MIN_VIEW = 280      # never show less than this many points of height (a third of an A4 page)
RUN = 8             # words in the smallest piece we will still call a partial match

# Curly quotes and long dashes become plain ones. Every replacement is one
# character for one character, so positions in folded text match the original.
FOLD = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'",
                      "–": "-", "—": "-", " ": " "})
TEXT_FLAGS = pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP  # expands ligatures like "fi"


# [stop 1] The one function everything else calls.
# It takes a file and a quote and returns a PNG plus one line of text, which is
# exactly what the MCP tool hands back to the chat, and the same facts as plain
# fields (where the file is, its fingerprint, the lines or rows) for a host that draws its own card.
def claim(file, quote, page=None):
    name = url.name(file) if url.is_url(file) else Path(file).name
    given = file if url.is_url(file) else str(Path(file).expanduser().absolute())
    result = {"status": "not found", "page": None, "path": given, "sha256": None,
              "matched": None, "lines": None, "excerpt": None, "sheet": None,
              "link": None}
    try:
        doc, path, sheet, result["sha256"] = load(file, normalize(quote))
    except Exception as e:  # missing file, unknown type, broken PDF: say so instead of crashing
        where = f"{name} · {str(e) or type(e).__name__}"
        png, crop = render(None, [], "not found", where, quote, None)
        return {**result, "png": png, "crop": crop, "text": f"not found · {where}"}
    if not url.is_url(file):
        result["path"] = str(path)
    if path.suffix.lower() in image.KINDS:  # a picture has no text to search: show it, say so
        png, crop = render(doc[0], [], "not searchable", name, quote, None)
        return {**result, "png": png, "crop": crop, "text": f"not searchable · {name}", "status": "not searchable"}
    status, pno, rects, matched = search(doc, normalize(quote), page)
    if status == "not found" and path.suffix.lower() in table.KINDS:  # values from one row, not side by side
        row = table.row_values(path, normalize(quote), sheet)
        hits = row and table.row_rects(doc[0], *row)
        if hits:
            status, rects, matched = "exact", hits, " · ".join(row[1])
    where = f"{name} · sheet {sheet}" if sheet else f"{name} · page {pno + 1}"
    shot = None
    if result["sha256"] == "web" and matched:  # a web page: the picture comes from the live page (html.py)
        try:
            shot = html.screenshot(file, matched, COLORS[status])  # None if the text isn't in the live page
        except Exception:  # browser hiccup: keep the PDF picture
            pass
    png, crop = render(doc[pno], rects, status, where, quote, matched, shot)
    text = f"{status} · {where}"
    if status == "partial":
        text += f' · matched: "{matched}"'
    if status == "not found":
        text += " (showing the page; quote printed below)"
    link = None
    if matched and result["sha256"] == "web":  # a web page: a link that opens it at the quote
        link = url.link(file, matched)
    elif matched and url.is_url(file) and path.suffix.lower() == ".pdf":  # a PDF online: at the page
        link = url.link(file, matched, pno + 1)
    if link:
        text += f" · {link}"
    lines, excerpt = context(path, sheet, normalize(quote), pno, rects, matched)
    return {**result, "png": png, "crop": crop, "text": text, "status": status, "page": pno + 1, "sheet": sheet,
            "matched": matched, "lines": lines, "excerpt": excerpt, "link": link}


# [stop 2] Turn whatever file we got into a PDF.
# Links are downloaded first. PDFs open as they are. Everything else is converted
# to a PDF first (see claim/sources/), so there is only one way to search and one way to draw.
# We also take a fingerprint (sha256) of the bytes we read, so anyone can tell later if the file changed.
def load(file, quote):
    web = False
    if url.is_url(file):
        file, web = url.download(file)
    named = re.match(r"(.+\.xls[xm]?)#(.+)$", str(file), re.IGNORECASE)  # "book.xlsx#Sheet2" picks a sheet
    name, sheet = (named[1], named[2]) if named else (str(file), None)
    path = Path(name).expanduser().absolute()
    if not path.exists():
        raise ValueError("file does not exist")
    digest = "web" if web else hashlib.sha256(path.read_bytes()).hexdigest()
    kind = path.suffix.lower()
    if kind == ".pdf":
        doc = pdf.load(path)
    elif kind in image.KINDS:
        doc = image.load(path)
    elif kind in table.KINDS:
        if kind in table.BOOKS and not sheet:  # no sheet named: use the one the quote is on
            sheet = table.pick_sheet(path, quote)
        doc = table.load(path, quote, sheet or None)
    else:
        doc = text.load(path)
    return doc, path, sheet or None, digest


def context(path, sheet, quote, pno, rects, matched):
    """Line numbers and the lines around a hit (a text file's, or a PDF page's), the rows shown for tables."""
    if path.suffix.lower() in table.KINDS:
        return None, table.excerpt(path, quote, sheet, matched)
    if path.suffix.lower() == ".pdf":  # web pages and online PDFs are PDFs by now
        return pdf.context(pymupdf.open(path)[pno], rects)
    return text.context(path, pno, rects) if rects else (None, None)


# [stop 3] Clean up the quote the way the agent probably mangled it.
# Agents add surrounding quote marks and "..." and type plain quotes where the
# document has curly ones. We strip and fold those, but keep the original for display.
def normalize(quote):
    q = " ".join(quote.translate(FOLD).split())
    q = re.sub(r"^(\.\.\.|…)|(\.\.\.|…)$", "", q.strip(" \"'"))
    return q.strip(" \"'")


# Decide which pages to look at, and in what order (search, below, walks them this way).
# The hinted page first, then its neighbours up to two away, then everything else.
# With no hint we simply go front to back.
def page_order(count, hint):
    if not hint or not 1 <= hint <= count:
        return list(range(count))
    h = hint - 1
    near = [p for p in (h, h - 1, h + 1, h - 2, h + 2) if 0 <= p < count]
    return near + [p for p in range(count) if p not in near]


# [stop 4] Look for the quote, page by page, and stop at the first hit.
# First the whole quote (exact). If the agent reworded it, try its longest sentence,
# then every run of 8 words in a row (partial). A run that is found is widened word by
# word while the page still has it, and the rest of the quote is searched the same way,
# so every stretch of the quote on that page is lit, not just its first 8 words.
# Each page's text is pulled out once, and PyMuPDF is only asked for rectangles on a hit.
def search(doc, quote, hint):
    order = page_order(len(doc), hint)
    pages = {}  # page number -> (page, textpage, text), so each page's text is pulled out once

    def find(pno, needle):
        if pno not in pages:
            page = doc[pno]
            tp = page.get_textpage(flags=TEXT_FLAGS)
            pages[pno] = (page, tp, tp.extractText())
        page, tp, text = pages[pno]
        spelled = spelling_on_page(text, needle)
        return merge_lines(page.search_for(spelled, textpage=tp)) if spelled else []

    tries = []
    if len(quote) <= LONG_QUOTE:
        tries.append(("exact", quote))
    sentence = max(re.split(r"(?<=[.?!])\s+", quote), key=len)
    if sentence != quote and len(sentence.split()) >= MIN_SENTENCE:
        tries.append(("partial", sentence))
    words = quote.split()
    for i in range(len(words) - RUN + 1 if len(words) > RUN else 0):
        tries.append(("partial", i))
    for status, needle in tries:
        for pno in order:
            if isinstance(needle, str):
                rects = find(pno, needle)
                if rects:
                    return status, pno, rects, needle
            elif find(pno, " ".join(words[needle:needle + RUN])):
                stretches = widen(lambda a, b: find(pno, " ".join(words[a:b])), len(words), needle)
                rects = merge_lines([r for a, b in stretches for r in find(pno, " ".join(words[a:b]))])
                return status, pno, rects, " … ".join(" ".join(words[a:b]) for a, b in stretches)
    return "not found", order[0] if order else 0, [], None


def widen(found, count, i):
    """From a run found at word i: each stretch (start, end) of the quote the page has, in order."""
    stretches = []
    while i <= count - RUN:
        if not found(i, i + RUN):
            i += 1
            continue
        end = i + RUN
        while end < count and found(i, end + 1):
            end += 1
        stretches.append((i, end))
        i = end
    return stretches


# [stop 5] Find how the page itself spells the quote.
# The page might say "implemen-" at the end of one line and "tation" on the next,
# or use curly quotes. We match loosely against the page's text, then return the
# page's exact characters so PyMuPDF's search_for can find the rectangles.
# Only a hyphen at a line end is skipped: "re-sign" in the middle of a line is
# not "resign", and must not come back green for it. A number has to stand on its
# own, sign included: "2.5" is not the "2.5" inside "12.5", nor the one in "-2.5".
def spelling_on_page(text, needle):
    letters = [r"(?:-\s+)?".join(re.escape(c) for c in word) for word in needle.split()]
    pattern = r"\s+".join(letters)
    if needle[0].isdigit():
        pattern = r"(?<!\d)(?<!\d[.,])(?<!\s-)(?<!^-)" + pattern
    if needle[-1].isdigit():
        pattern += r"(?!\d|[.,]\d)"
    m = re.search(pattern, text.translate(FOLD), re.IGNORECASE)
    return text[m.start():m.end()] if m else None


def merge_lines(rects):
    """Justified text comes back as one box per word; join boxes that sit on the same line."""
    merged = []
    for r in sorted(rects, key=lambda r: (round(r.y0), r.x0)):
        last = merged[-1] if merged else None
        if last and abs(last.y0 - r.y0) < 2 and r.x0 - last.x1 < 12:
            merged[-1] = last | r
        else:
            merged.append(pymupdf.Rect(r))
    return merged


# [stop 6] Choose how much of the page to show.
# A third of the page, centred on the highlight and full width, so the reader
# sees the surrounding paragraph and not just the sentence. Short pages (like a
# small table) are shown whole. Never past the page edge.
def region(page, rects):
    box = page.rect
    if not rects:
        return box
    hit = pymupdf.Rect(rects[0])
    for r in rects[1:]:
        hit |= r
    height = max(box.height / 3, hit.height + 40, MIN_VIEW)
    top = (hit.y0 + hit.y1) / 2 - height / 2
    top = max(min(top, box.y1 - height), box.y0)
    bottom = min(top + height, box.y1)
    lines = text_lines(page)  # don't slice a line of text in half at the edges
    for line in sorted(lines, key=lambda r: -r.y1):  # walk upwards, so each move is re-checked
        if line.y0 < top < line.y1:
            top = line.y0 - 2
    for line in sorted(lines, key=lambda r: r.y0):   # walk downwards
        if line.y0 < bottom < line.y1:
            bottom = line.y1 + 2
    return pymupdf.Rect(box.x0, max(top, box.y0), box.x1, min(bottom, box.y1))


def text_lines(page):
    blocks = page.get_text("dict", flags=TEXT_FLAGS)["blocks"]
    return [pymupdf.Rect(line["bbox"]) for b in blocks for line in b.get("lines", [])]


# [stop 7] Draw the picture.
# First the crop: a 2x photo of the chosen slice of the page, the way a PDF viewer
# would show it (stamps, highlights and filled-in form fields too), with see-through
# coloured boxes over each hit. The PNG is that crop under a dark header strip.
# A not-found result gets a red header, the whole page untouched, and the quote
# printed in a box underneath, so the reader can look for it themselves.
# For a web page found in the browser, `shot` is the browser's own picture and is used as the crop.
def render(page, rects, status, where, quote, matched, shot=None):
    if shot:
        size = pymupdf.Pixmap(shot)
        clip, crop = pymupdf.Rect(0, 0, size.width / SCALE, size.height / SCALE), shot
    else:
        clip = region(page, rects) if page else pymupdf.Rect(0, 0, 595, 0)
        crop = photo(page, clip, rects, status) if page else None
    lines = [f"{status}  ·  " + where.replace(" · ", "  ·  ")]
    if status == "partial":
        lines.append(f'matched: "{shorten(matched, 110)}"')
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
        canvas.insert_text((14, HEADER * i + 12.5), line, fontsize=10, fontname="helv", color=WHITE)
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
