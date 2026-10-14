"""Scan a finished answer against the files a session read, without anyone having
to mark what is a quote: every run of eight words the answer shares with a file,
and every figure in the answer, is checked. This is what the plugin runs when an
answer ends; the model's own claim calls are extra, not the gate.
"""

import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NamedTuple

from claim import cache, core, sums
from claim.sources import image, table, text

MAX_SPANS, MAX_FIGURES = 10, 40
EDGE = "\"'.,;:!?()[]{}-"  # punctuation at a word's edges that doesn't change the word
NOWHERE = {"status": "not found", "page": None, "path": "", "sha256": None, "matched": None, "lines": None,
           "excerpt": None, "sheet": None, "link": None, "png": None, "crop": None, "places": 0}  # a figure in no file
NUMBER = re.compile(r"^(-?)[$€£]?-?(\d[\d,]*(?:\.\d+)?)(k|mn|m|bn|b)?(%?)$")  # 4.2m, 1.5bn, 300k, -5.2%
SIZES = {"k": 3, "m": 6, "mn": 6, "b": 9, "bn": 9}
WORDS = {"thousand": "k", "million": "m", "billion": "b", "bn": "b", "mn": "m", "percent": "%", "%": "%"}  # "4.5 billion"
UNITS = re.compile(r"\bin (thousands|millions|billions)\b", re.IGNORECASE)  # a table's "(Amounts in millions)"


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
            found = [(f.figure, f.spelling) for f in figures_in(piece_keys)]
            # A page that says its amounts are "in millions" holds 22,270 as $22,270M: each plain
            # number on it also stands for itself times that unit.
            stated = None if rows else UNITS.search(piece)
            if stated:
                scale = {"thousands": 3, "millions": 6, "billions": 9}[stated[1].lower()]
                for k in piece_keys:
                    m = NUMBER.match(k)
                    if m and not m[3] and not m[4]:
                        found.append((f"{Decimal(m[1] + m[2].replace(',', '')).scaleb(scale).normalize():f}", k))
            for figure_, spelling in found:
                if figure_ not in figures:
                    figures[figure_] = (file, spelling, page)  # the file's own spelling, so claim() finds it
            for figure_ in {f for f, _ in found}:  # a page or row counts once
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
    # [stop 17] Figures. One a file holds is drawn where it first is. One written short ($284.7B)
    # also counts when a file holds it in full to that last digit (284,668 in millions), and says
    # so. One in no file that one simple step makes from figures the answer gives and the files
    # hold is "worked out", with its formula (sums.py); any other is in no file.
    seen, held, missing = set(), {}, []  # held: answer word index -> (value, the answer's spelling, its kind), for sums.py
    for f in figures_in(keys):
        shown = text[words[f.at][1]:words[f.at + f.width - 1][2]].strip(EDGE.replace("-", "") + " ")  # as the answer writes it, sign kept
        hit = figures.get(f.figure) or (f.size and nearest(f, figures))
        if hit:
            held[f.at] = (Decimal(f.figure), shown, kind(f, shown))
        if f.figure in seen or f.at in covered:
            continue
        seen.add(f.figure)
        if len(seen) > MAX_FIGURES:
            break
        if hit:
            file, spelling, page = hit
            rounded = {"rounded": spelling} if f.figure not in figures else {}
            results.append({**core.claim(file, spelling, page), "quote": shown, "kind": "figure", "places": places.get(f.figure, 1), **rounded})
        elif files:
            missing.append((f, shown))
    # Amounts first, each round adding what it worked out, so one made from another is found too;
    # then percents and ratios, with every amount in hand. A percent never makes an amount, so no
    # figure is ever made from itself.
    for amounts, rounds in ((True, 3), (False, 1)):
        for _ in range(rounds):
            for f, shown in [m for m in missing if m[0].at not in held and (kind(*m) == "amount") == amounts]:
                step = sums.worked_out(f.at, Decimal(f.figure), sums.unit(f.digits, f.size, f.percent), kind(f, shown), held)
                if step:
                    held[f.at] = (Decimal(f.figure), shown, kind(f, shown))
                    results.append({**NOWHERE, "status": "worked out", "quote": shown, "kind": "figure", "formula": step[0],
                                    "text": f"worked out · {shown} = {step[0]}"})
    for f, shown in missing:
        if f.at not in held:  # in no file: say so, with no file and no picture, since there is nothing to show
            results.append({**NOWHERE, "quote": shown, "kind": "figure", "text": f"not found · {shown} is in none of the files"})
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


class Figure(NamedTuple):
    at: int          # the answer word it starts at
    width: int       # 1, or 2 for a size or percent written as the next word ("4.5 billion")
    figure: str      # figure(), the one spelling of its value
    spelling: str    # as compared (lower case), what claim() is asked to find
    digits: str      # as written, for the last digit it shows
    size: int        # its size as a power of ten: 6 for m and million
    percent: bool


def figures_in(keys):
    """Every figure in a list of words. A size or percent written as the next word belongs to the
    number: "4.5 billion" is 4.5b, and its spelling takes both words."""
    found = []
    for i, k in enumerate(keys):
        m = NUMBER.match(k)
        after = WORDS.get(keys[i + 1]) if i + 1 < len(keys) and m and not m[3] and not m[4] else None
        figure_ = figure(k + after) if after else figure(k)
        if figure_ and m:
            size = SIZES.get(m[3] or (after if after != "%" else "") or "", 0)
            found.append(Figure(i, 2 if after else 1, figure_, f"{k} {keys[i + 1]}" if after else k,
                                m[2], size, bool(m[4]) or after == "%"))
    return found


def kind(f, shown):
    """What a figure measures, for which steps can make it (sums.py): a percent, an amount (a
    currency sign or a size: $95,315M, 4.5 billion), or a plain number (2.7, as in "2.7 times")."""
    return "percent" if f.percent else "amount" if f.size or any(c in shown for c in "$€£") else "number"


def nearest(f, figures):
    """For a figure written short ($284.7B): a figure the files hold that rounds to it, to the last
    digit it shows (284,668 in millions is $284.7B), as (file, spelling, page). None if none does."""
    value, half = Decimal(f.figure), sums.unit(f.digits, f.size, f.percent) / 2
    near = [(abs(Decimal(k) - value), hit) for k, hit in figures.items() if abs(Decimal(k) - value) <= half]
    return min(near, key=lambda n: n[0])[1] if near else None


def figure(k):
    """A number the answer could only have taken from somewhere: with a currency or percent sign,
    a decimal point, a thousands comma, a size (k, m, mn, bn, b), or four or more digits, except a
    four-digit year (1900-2099). One to three digits stay quiet: they are counts ("3 files", "300 pages").
    Spelled one way, its size and percent worked in: 1,234.50 is 1234.5, 60% is 0.6, 4.5B is
    4500000000, so a figure with a size or a percent is never the bare number (4.5B is not 4.5%)."""
    m = NUMBER.match(k)
    if not m:
        return None
    sign, digits, size, percent = m[1] or ("-" if "-" in k else ""), m[2], m[3] or "", m[4]
    year = len(digits) == 4 and digits.isdigit() and 1900 <= int(digits) <= 2099
    if not (percent or size or "$" in k or "€" in k or "£" in k or "." in digits or "," in digits or len(digits) >= 4) or year:
        return None
    try:  # a percent is the number it stands for: 60% and a cell shown as 0.60 are one figure
        n = Decimal(sign + digits.replace(",", "")).scaleb(SIZES.get(size, 0)) / (100 if percent else 1)
        return f"{n.normalize():f}"
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
