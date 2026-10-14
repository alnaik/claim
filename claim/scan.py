"""Scan a finished answer against the files a session read, without anyone having
to mark what is a quote: every run of eight words the answer shares with a file,
and every figure in the answer, is checked. This is what the plugin runs when an
answer ends; the model's own claim calls are extra, not the gate.
"""

import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NamedTuple

from claim import cache, core
from claim.sources import image, table, text

MAX_SPANS, MAX_FIGURES = 10, 40
EDGE = "\"'.,;:!?()[]{}-"  # punctuation at a word's edges that doesn't change the word
NOWHERE = {"status": "not found", "page": None, "path": "", "sha256": None, "matched": None, "lines": None,
           "excerpt": None, "sheet": None, "link": None, "png": None, "crop": None, "places": 0}  # a figure in no file
NUMBER = re.compile(r"^(-?)[$€£]?-?(\d[\d,]*(?:\.\d+)?)(k|mn|m|bn|b)?(%?)$")  # 4.2m, 1.5bn, 300k, -5.2%
SIZES = {"k": 3, "m": 6, "mn": 6, "b": 9, "bn": 9}
WORDS = {"thousand": "k", "million": "m", "billion": "b", "bn": "b", "mn": "m", "percent": "%", "%": "%"}  # "4.5 billion"
UNITS = re.compile(r"\bin (thousands|millions|billions)\b", re.IGNORECASE)  # a table's "(Amounts in millions)"
# Words too common to tie a figure to what it is about: a line and a sentence sharing "the" share nothing.
STOP = set("""the and for with from that this was were are is been be has have had its it our their they them
which while about into than then also more most other over under such only same each per not but all any can may
will would should could these those there here what when where who how because after before between during
both very just used using his her you your we us of on in at by to as an or if so no""".split())


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
    spans, figures, covered = [], {}, set()  # figures: value -> [(file, spelling, page, the words of its line, its line number)]
    seldom = {}  # file -> the words it uses on one line, or on at most 1 in 100 of its lines
    for file in files:
        try:
            pieces = contents(file)
        except Exception:  # unreadable, missing, an image: nothing to compare with
            continue
        rows = Path(file).expanduser().suffix.lower() in table.KINDS  # pieces are rows, not pages
        lines = pdf_lines(file)  # a PDF's lines as they sit on the page, a table row on one line; else None
        runs = {}  # run of eight words -> the page it is on (None for a spreadsheet)
        used, count = {}, 0  # stem -> on how many of the file's lines
        for n, piece in enumerate(pieces):
            page = None if rows else n + 1
            piece_keys = [key(w) for w in piece.split()]
            piece_keys = [k for k in piece_keys if k]
            for i in range(len(piece_keys) - core.RUN + 1):
                runs.setdefault(tuple(piece_keys[i:i + core.RUN]), page)
            # A page that says its amounts are "in millions" holds 22,270 as $22,270M: each plain
            # number on it also stands for itself times that unit.
            stated = None if rows else UNITS.search(piece)
            scale = {"thousands": 3, "millions": 6, "billions": 9}[stated[1].lower()] if stated else None
            for line in lines[n] if lines else [piece] if rows else piece.split("\n"):
                line_keys = [k for k in (key(w) for w in line.split()) if k]
                found = [(f.figure, f.spelling) for f in figures_in(line_keys)]
                for k in line_keys if scale else []:
                    m = NUMBER.match(k)
                    if m and not m[3] and not m[4]:
                        found.append((f"{Decimal(m[1] + m[2].replace(',', '')).scaleb(scale).normalize():f}", k))
                about = stems(line)
                count += 1
                for stem in about:
                    used[stem] = used.get(stem, 0) + 1
                for figure_, spelling in found:  # the file's own spelling, so claim() finds it
                    figures.setdefault(figure_, []).append((file, spelling, page, about, count))
        seldom[file] = {stem for stem, n in used.items() if n == 1 or n <= count / 100}
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
    # [stop 17] Figures. A figure counts as in a file only where the file's line or table row that
    # holds it shares words with the answer's sentence around it: two words, or one the file seldom
    # uses ("ROA" on 5 of a 10-K's 3,904 lines; "net" is on 190). A model's own 22.2% matched to an
    # unrelated 22.2% in a 10-K is a coincidence, and claim would rather call it worked out than show
    # it in the wrong place. One written short ($284.7B)
    # also counts when such a line holds it in full to that last digit (284,668 in millions), and says so.
    # A figure in no file is "worked out": computed or inferred, never checked. No sum is redone; the
    # card names the answer's other figures in the same sentence and where they are, its likely inputs.
    sentence = sentences(text, words)
    said = {}  # sentence -> the stems of its words
    for (k, _, _), s_ in zip(words, sentence):
        said.setdefault(s_, set()).update(stems(k))
    found = figures_in(keys)
    hits = {f.at: held(f, said[sentence[f.at]], figures, seldom) for f in found}
    shown = {f.at: text[words[f.at][1]:words[f.at + f.width - 1][2]].strip(EDGE.replace("-", "") + " ") for f in found}  # as the answer writes it, sign kept
    seen = set()
    for f in found:
        if f.figure in seen or f.at in covered:
            continue
        seen.add(f.figure)
        if len(seen) > MAX_FIGURES:
            break
        if hits[f.at]:
            (file, spelling, page), count, exact = hits[f.at]
            rounded = {} if exact else {"rounded": spelling}
            results.append({**core.claim(file, spelling, page), "quote": shown[f.at], "kind": "figure", "places": count, **rounded})
        elif files:  # in no file: no file and no picture, since there is nothing to show; its neighbours instead
            near = [{"quote": shown[g.at], "where": where(hits[g.at][0]) if hits[g.at] else None}
                    for g in found if sentence[g.at] == sentence[f.at] and g.figure != f.figure]
            near = [n for i, n in enumerate(near) if n not in near[:i]]
            listed = ", ".join(f"{n['quote']} {n['where'] or '(worked out)'}" for n in near)
            results.append({**NOWHERE, "quote": shown[f.at], "kind": "figure", "near": near,
                            "text": f"worked out · {shown[f.at]} is in none of the files" + (f" · near: {listed}" if near else "")})
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


def held(f, about, figures, seldom):
    """Where a file holds figure f, read in a sentence whose word stems are `about`: ((file, spelling,
    page) of the first line that holds it and shares two words with the sentence, or one the file
    seldom uses, how many pages or rows do, whether the value is exact). A figure written short ($284.7B) falls back to the nearest
    value that rounds to it, to the last digit it shows (284,668 in millions). None if no line fits."""
    def fitting(value):
        return [o for o in figures.get(value, []) if len(o[3] & about) >= 2 or o[3] & about & seldom[o[0]]]
    exact = fitting(f.figure)
    if not exact and f.size:
        value, half = Decimal(f.figure), unit(f.digits, f.size, f.percent) / 2
        close = sorted((abs(Decimal(k) - value), k) for k in figures if abs(Decimal(k) - value) <= half)
        exact = next((fitting(k) for _, k in close if fitting(k)), [])
        if exact:
            return exact[0][:3], places(exact), False
    return (exact[0][:3], places(exact), True) if exact else None


def places(lines):
    """How many pages, or a spreadsheet's rows, these lines holding a figure are on."""
    return len({(o[0], o[4] if o[2] is None else o[2]) for o in lines})


def unit(digits, size, percent):
    """The last digit a figure shows, as a value: 23.0% shows tenths of a percent (0.001),
    $284.7B shows hundreds of millions, 2,100 shows ones."""
    decimals = len(digits.split(".")[1]) if "." in digits else 0
    return Decimal(1).scaleb(size - decimals) / (100 if percent else 1)


def where(hit):
    """A held figure's place in a few words, for the list of a worked-out figure's neighbours."""
    file, _, page = hit
    return f"p.{page}" if Path(file).suffix.lower() == ".pdf" else Path(file).name


def sentences(text, words):
    """Which sentence of the answer each word is in: a new one at a capital after a word ending in
    . ! or ? (so "p. 77" goes on), and at every new line, so a table row or a bullet is one of its own."""
    out, n = [], 0
    for i, (_, start, _) in enumerate(words):
        ended = text[words[i - 1][1]:words[i - 1][2]].rstrip("\"')]*").endswith((".", "!", "?")) and text[start:start + 1].isupper()
        if i and ("\n" in text[words[i - 1][2]:start] or ended):
            n += 1
        out.append(n)
    return out


def stems(line):
    """The words a line is about, each cut to a stem so plurals and endings meet (shares and share,
    repurchased and repurchase): letters only, three or more, common words dropped."""
    found = re.findall(r"[a-z]+", line.translate(core.FOLD).lower())
    return {(w[:-1] if w.endswith("s") and len(w) > 3 else w)[:6] for w in found if len(w) >= 3 and w not in STOP}


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


def pdf_lines(file):
    """A PDF's lines per page as they sit on it, left to right: words whose middles are within half a
    word's height of each other are one line, so a table's label and its numbers come out together
    (the page's own text puts each cell on its own line). None for anything but a PDF."""
    path = Path(file).expanduser()
    if path.suffix.lower() != ".pdf":
        return None

    def read():
        pages = []
        for page in core.load(file, "")[0]:
            rows = []
            for w in sorted(page.get_text("words", flags=core.TEXT_FLAGS), key=lambda w: (w[1] + w[3]) / 2):
                middle = (w[1] + w[3]) / 2
                if not rows or middle - rows[-1][0] > (w[3] - w[1]) / 2:
                    rows.append((middle, []))
                rows[-1][1].append(w)
            pages.append([" ".join(w[4] for w in sorted(r, key=lambda w: w[0])) for _, r in rows])
        return pages
    return cache.kept(path, "lines", read)


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
