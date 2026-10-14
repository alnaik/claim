"""Scan a finished answer against the files a session read, without anyone having
to mark what is a quote: every run of eight words the answer shares with a file,
and every figure in the answer, is checked. This is what the plugin runs when an
answer ends; the model's own claim calls are extra, not the gate.
"""

import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

from claim import cache, core
from claim.sources import image, table, text

MAX_SPANS, MAX_FIGURES = 10, 10
EDGE = "\"'.,;:!?()[]{}-"  # punctuation at a word's edges that doesn't change the word
NOWHERE = {"status": "not found", "page": None, "path": "", "sha256": None, "matched": None, "lines": None,
           "excerpt": None, "sheet": None, "link": None, "png": None, "crop": None, "places": 0}  # a figure in no file
NUMBER = re.compile(r"^(-?)[$€£]?-?(\d[\d,]*(?:\.\d+)?)(k|mn|m|bn|b)?(%?)$")  # 4.2m, 1.5bn, 300k, -5.2%


# [stop 16] The scan. The answer's words are laid out once, then each file's words are
# looked at: a run of eight the answer shares with a file is a quote, marked or not,
# and goes through claim() like any other; a figure is looked up in every file. Each run and
# figure remembers the page it came from, so claim() starts there instead of at page 1.
# A figure also counts the pages and rows that hold it: a common number lit in the first
# cell it turns up in is weak evidence, and the card says "1 of N places" so you can tell.
def scan(answer, files):
    text = flatten(answer)
    words = [(key(m.group()), m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    words = [w for w in words if w[0]]
    keys = [w[0] for w in words]
    # A quotation mark ends a passage: a run of words never bridges one, so the words after
    # a closing quote are not swept into the quote even when the file goes on the same way.
    # A mark that opens and closes inside one word ("__main__" in code) is that word's own and splits nothing.
    part, seen = [], 0
    for _, start, end in words:
        marks = text.count('"', start, end)
        if marks == 1 and text[start] == '"':
            seen += 1  # an opening mark: a new passage starts with this word
        part.append(seen)
        if marks == 1 and text[start] != '"':
            seen += 1  # a closing mark: the passage ends with this word
    spans, figures, places, covered = [], {}, {}, set()
    for file in files:
        try:
            pieces = contents(file)
        except Exception:  # unreadable, missing, an image: nothing to compare with
            continue
        rows = Path(file).expanduser().suffix.lower() in table.KINDS  # pieces are rows, not pages
        runs = {}  # run of eight words -> the page it is on (None for a spreadsheet)
        for n, piece in enumerate(pieces):
            page = None if rows else n + 1
            piece_keys = [key(w) for w in piece.split()]
            piece_keys = [k for k in piece_keys if k]
            for i in range(len(piece_keys) - core.RUN + 1):
                runs.setdefault(tuple(piece_keys[i:i + core.RUN]), page)
            for k in piece_keys:
                figure_ = figure(k)
                if figure_ and figure_ not in figures:
                    figures[figure_] = (file, k, page)  # the file's own spelling, so claim() finds it
            for figure_ in {figure(k) for k in piece_keys} - {None}:  # a page or row counts once
                places[figure_] = places.get(figure_, 0) + 1
        start = None
        for i in range(len(keys) - core.RUN + 1):
            hit = (tuple(keys[i:i + core.RUN]) in runs and part[i] == part[i + core.RUN - 1]
                   and not covered.intersection(range(i, i + core.RUN)))
            if hit and start is None:
                start, page = i, runs[tuple(keys[i:i + core.RUN])]
            if not hit and start is not None:
                spans.append((file, start, i - 1 + core.RUN, page))
                start = None
        if start is not None:
            spans.append((file, start, len(keys), page))
        for _, a, b, _ in spans:
            covered.update(range(a, b))
    results = []
    for file, a, b, page in sorted(spans, key=lambda s: s[1])[:MAX_SPANS]:
        quote = text[words[a][1]:words[b - 1][2]].strip(EDGE + " ")  # the answer's own comma at the cut
        results.append({**core.claim(file, quote, page), "quote": quote, "kind": "quote", "places": 1})
    seen = set()
    for i, (k, _, _) in enumerate(words):
        figure_ = figure(k)
        if not figure_ or figure_ in seen or i in covered:
            continue
        seen.add(figure_)
        if len(seen) > MAX_FIGURES:
            break
        if figure_ in figures:
            file, spelling, page = figures[figure_]
            results.append({**core.claim(file, spelling, page), "quote": k, "kind": "figure", "places": places[figure_]})
        elif files:  # in no file: say so, with no file and no picture, since there is nothing to show
            results.append({**NOWHERE, "quote": k, "kind": "figure", "text": f"not found · {k} is in none of the files"})
    return results


def flatten(answer):
    """The answer as plain words: markdown marks dropped, curly quotes made plain."""
    t = answer.translate(core.FOLD)
    t = re.sub(r"^\s{0,3}(>|#{1,6}|[-*+]|\d+[.)])\s+", " ", t, flags=re.M)  # blockquotes, headings, bullets
    t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)                         # links keep their text
    t = re.sub(r"\*+|`+", "", t)                                                # bold, italics and code marks; underscores stay, code has them (__init__)
    return t.replace("|", " ")                                               # table pipes


def key(word):
    """A word as compared: lower case, punctuation at its edges dropped. A minus sign in front of
    a number stays, so a loss of 5.2% is never the same figure as a gain of 5.2%."""
    k = word.translate(core.FOLD).lower().strip(EDGE)
    if k[:1].isdigit() or k[:1] in "$€£":
        signed = word.translate(core.FOLD).strip(EDGE.replace("-", ""))  # the word with only its quotes and brackets off
        if signed.startswith("-"):
            k = "-" + k.lstrip("-")
    return k


def figure(k):
    """A number the answer could only have taken from somewhere: with a currency or percent sign,
    a decimal point, a thousands comma, a size (k, m, mn, bn, b), or four or more digits, except a
    four-digit year (1900-2099). One to three digits stay quiet: they are counts ("3 files", "300 pages").
    Spelled one way: 1,234.50 is 1234.5, 60% is 0.6, and 4.2m keeps its m so it is never 4.2."""
    m = NUMBER.match(k)
    if not m:
        return None
    sign, digits, size, percent = m[1] or ("-" if "-" in k else ""), m[2], m[3] or "", m[4]
    year = len(digits) == 4 and digits.isdigit() and 1900 <= int(digits) <= 2099
    if not (percent or size or "$" in k or "€" in k or "£" in k or "." in digits or "," in digits or len(digits) >= 4) or year:
        return None
    try:  # a percent is the number it stands for: 60% and a cell shown as 0.60 are one figure
        n = Decimal(sign + digits.replace(",", "")) / (100 if percent else 1)
        return f"{n.normalize():f}{size}"
    except InvalidOperation:
        return None


def contents(file):
    """A file's text as pieces: a PDF's pages (words split by a line-end hyphen joined back up),
    a spreadsheet's rows (every cell both ways), or a text file's lines in the pages claim would
    type them on, read straight from the file so no PDF is laid out just to look."""
    path = Path(file).expanduser()
    if path.suffix.lower() in image.KINDS:
        return []
    if path.suffix.lower() in table.KINDS:
        return [" ".join(" ".join(v.split(table.RAW)) for v in row) for _, rows in table.read_sheets(path) for row in rows]
    if path.suffix.lower() == ".pdf":  # kept on disk until the file changes (cache.py): the next answer reads it from there
        return cache.kept(path, "pages", lambda: [re.sub(r"-\n\s*", "", page.get_textpage(flags=core.TEXT_FLAGS).extractText())
                                                  for page in core.load(file, "")[0]])
    typed = text.layout(text.read(path))
    return ["\n".join(line for _, line in typed[i:i + text.LINES]) for i in range(0, len(typed), text.LINES)]
