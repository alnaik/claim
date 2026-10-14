"""Text source: lay any text file out as a plain monospace PDF, then search that like any PDF."""

import textwrap

import pymupdf

WIDTH, LINES, SIZE, LEAD, MARGIN = 90, 60, 11, 14, 36  # chars per line, lines per page, font size, line height, margin
AROUND = 3  # lines of the file shown above and below a hit


def read(path):
    """The file's own lines, tabs turned into spaces."""
    try:
        return path.read_text(encoding="utf-8").expandtabs(4).splitlines()
    except UnicodeDecodeError:
        raise ValueError(f"can't read {path.suffix or 'this kind of'} files")


def layout(source):
    """The lines as typed on the pages: (line number in the file, text). Long lines wrap onto several."""
    typed = []
    for n, line in enumerate(source, 1):
        typed += [(n, piece) for piece in textwrap.wrap(line, WIDTH, replace_whitespace=False) or [""]]
    return typed


def load(path):
    typed = layout(read(path))
    font = pymupdf.Font("cour")  # a real font object, so curly quotes and accents survive
    doc = pymupdf.open()
    for start in range(0, max(len(typed), 1), LINES):
        page = doc.new_page(width=font.text_length("x" * WIDTH, SIZE) + 2 * MARGIN,
                            height=LINES * LEAD + 2 * MARGIN)
        writer = pymupdf.TextWriter(page.rect)
        for i, (_, line) in enumerate(typed[start:start + LINES]):
            writer.append((MARGIN, MARGIN + SIZE + i * LEAD), line, font=font, fontsize=SIZE)
        writer.write_text(page)
    return doc


def context(path, pno, rects):
    """Turn hit boxes on typed page `pno` back into [first, last] line numbers in the file,
    plus those lines with three either side, as [[number, text], ...]."""
    source = read(path)
    typed = layout(source)

    def number(rect):  # which typed line this box sits on, then which file line that came from
        i = pno * LINES + int(((rect.y0 + rect.y1) / 2 - MARGIN) / LEAD)
        return typed[min(max(i, 0), len(typed) - 1)][0]

    first, last = min(map(number, rects)), max(map(number, rects))
    shown = range(max(first - AROUND, 1), min(last + AROUND, len(source)) + 1)
    return [first, last], [[n, source[n - 1]] for n in shown]
