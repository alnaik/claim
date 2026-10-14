"""Generate the fixture documents. Run: uv run python fixtures/make_fixtures.py

Every document is made with PyMuPDF so the fixtures are reproducible and each
one exercises a specific failure mode (columns, hyphens, curly quotes, ...).
"""

import random
from pathlib import Path

import pymupdf

HERE = Path(__file__).parent
W, H = 595, 842  # A4 in points
rng = random.Random(7)

SUBJECTS = ["the sampling procedure", "our second model", "the control group", "each annotator",
            "the validation split", "the tokenizer", "the reward signal", "a smaller learning rate",
            "the retrieval index", "the held-out set", "every ablation", "the cleaned corpus"]
VERBS = ["reduces", "stabilizes", "complicates", "explains", "depends on", "overlaps with",
         "was compared against", "barely affects", "changes", "is sensitive to"]
OBJECTS = ["the variance across seeds", "the length of generated answers", "the final ranking",
           "how quickly training converges", "the number of rejected samples", "label noise",
           "the cost of each evaluation", "agreement between raters", "rare entity names",
           "the shape of the loss curve"]
TAILS = ["in most settings", "when the budget is small", "for the larger datasets", "on the second benchmark",
         "after the first epoch", "only in English", "under heavy noise", "without any tuning"]


def filler(n):
    """n plausible but distinct sentences, so random 8-word runs don't repeat by accident."""
    out = []
    for _ in range(n):
        s = f"{rng.choice(SUBJECTS)} {rng.choice(VERBS)} {rng.choice(OBJECTS)} {rng.choice(TAILS)}"
        out.append(s[0].upper() + s[1:] + ".")
    return " ".join(out)


def paper():
    """Two-column academic paper, 6 pages. Key sentences are planted on known pages."""
    planted = {
        2: "We observe a 12% improvement over the baseline when the retrieval step is enabled.",
        3: "Surprisingly, the gain disappears entirely once documents are shorter than two hundred words.",
        4: "All experiments were run three times and we report the median of the three runs.",
        5: "Future work should test whether the effect holds for languages with rich morphology.",
    }
    doc = pymupdf.open()
    for n in range(1, 7):
        page = doc.new_page(width=W, height=H)
        if n == 1:
            page.insert_htmlbox(pymupdf.Rect(60, 50, W - 60, 130),
                                "<h2 style='text-align:center'>Retrieval Helps, Sometimes</h2>"
                                "<p style='text-align:center'>A. Author, B. Author</p>")
            top = 140
        else:
            top = 50
        cols = [pymupdf.Rect(50, top, 290, H - 50), pymupdf.Rect(305, top, W - 50, H - 50)]
        for c, rect in enumerate(cols):
            body = [filler(6), filler(6), filler(6)]
            if n in planted and c == 1:
                body[1] = filler(2) + " " + planted[n] + " " + filler(3)
            html = "".join(f"<p style='font-size:9.5pt;text-align:justify'>{b}</p>" for b in body)
            page.insert_htmlbox(rect, html)
        page.insert_text((W / 2 - 5, H - 25), str(n), fontsize=9)
    doc.save(HERE / "paper.pdf")


def contract():
    """A contract with numbered clauses, 4 pages."""
    clauses = [
        ("Term", "This Agreement begins on the Effective Date and continues for twenty-four (24) months unless terminated earlier under Clause 9."),
        ("Fees", "The Client shall pay the Supplier the fees set out in Schedule 2 within thirty (30) days of receiving a valid invoice."),
        ("Late payment", "Interest accrues on any overdue amount at four percent (4%) per year above the base rate, calculated daily."),
        ("Confidentiality", "Each party shall keep the other party's Confidential Information secret and shall not disclose it to any third party without prior written consent."),
        ("Intellectual property", "All Intellectual Property Rights in the Deliverables shall vest in the Client upon full payment of the relevant fees."),
        ("Warranties", "The Supplier warrants that the Services will be performed with reasonable skill and care and in accordance with good industry practice."),
        ("Liability", "Neither party's total liability under this Agreement shall exceed the total fees paid in the twelve (12) months preceding the claim."),
        ("Force majeure", "Neither party shall be liable for any delay caused by events beyond its reasonable control, including flood, fire, or pandemic."),
        ("Termination", "Either party may terminate this Agreement by giving not less than ninety (90) days' written notice to the other party."),
        ("Notices", "Any notice under this Agreement shall be in writing and delivered by hand, by recorded post, or by email to the address in Schedule 1."),
        ("Assignment", "The Client may not assign or transfer any of its rights under this Agreement without the Supplier's prior written consent."),
        ("Governing law", "This Agreement and any dispute arising from it shall be governed by the laws of England and Wales."),
    ]
    html = "<h2>SERVICES AGREEMENT</h2>"
    for i, (title, text) in enumerate(clauses, 1):
        html += f"<p><b>{i}. {title}.</b> {text}</p>"
        html += f"<p>{i}.1 {filler(3)}</p><p>{i}.2 {filler(3)}</p>"
    write_story(html, HERE / "contract.pdf", fontsize="11pt")


def report():
    """A financial report with a table and narrative text, 3 pages."""
    rows = [("Product revenue", "41.2", "38.9"), ("Services revenue", "12.7", "10.1"),
            ("Total revenue", "53.9", "49.0"), ("Cost of sales", "(21.4)", "(20.3)"),
            ("Gross profit", "32.5", "28.7"), ("Operating expenses", "(18.0)", "(16.6)"),
            ("Operating profit", "14.5", "12.1")]
    table = "".join(f"<tr><td>{a}</td><td style='text-align:right'>{b}</td><td style='text-align:right'>{c}</td></tr>"
                    for a, b, c in rows)
    html = (
        "<h2>Annual Report 2025</h2><h3>Chair's statement</h3>"
        f"<p>{filler(5)}</p><p>{filler(5)}</p>"
        "<p>Revenue grew by 10% to 53.9 million, driven mainly by new services contracts in the second half.</p>"
        f"<p>{filler(6)}</p><p>{filler(6)}</p>"
        "<h3>Income statement (in millions)</h3>"
        "<table border='1' cellpadding='4'><tr><th>Item</th><th>2025</th><th>2024</th></tr>"
        f"{table}</table>"
        f"<p>{filler(6)}</p><p>{filler(6)}</p>"
        "<h3>Outlook</h3>"
        "<p>The board expects operating margins to remain broadly stable in the coming year.</p>"
        f"<p>{filler(8)}</p><p>{filler(8)}</p><p>{filler(8)}</p>"
    )
    write_story(html, HERE / "report.pdf", fontsize="11pt")


def hyphen():
    """Words split across lines with a hyphen, the way justified PDFs often do."""
    doc = pymupdf.open()
    page = doc.new_page(width=W, height=H)
    text = ("The committee reviewed the proposal and found that the implemen-\n"
            "tation plan was realistic, although the budget for mainte-\n"
            "nance looked too optimistic for a project of this size. The board asked\n"
            "the director to re-sign the contract before the co-op meeting.\n\n"
            + filler(4))
    page.insert_textbox(pymupdf.Rect(72, 72, 400, 500), text, fontsize=11)
    doc.save(HERE / "hyphen.pdf")


def pagebreak():
    """One sentence that starts at the bottom of page 1 and ends at the top of page 2."""
    doc = pymupdf.open()
    p1 = doc.new_page(width=W, height=H)
    p1.insert_textbox(pymupdf.Rect(72, 72, W - 72, H - 90),
                      filler(20) + "\n\nIn the end the committee agreed that the", fontsize=11)
    p2 = doc.new_page(width=W, height=H)
    p2.insert_textbox(pymupdf.Rect(72, 72, W - 72, H - 72),
                      "budget would be frozen until the spring review. " + filler(15), fontsize=11)
    doc.save(HERE / "pagebreak.pdf")


def curly():
    """Typographic quotes and dashes in the source; agents usually type plain ones."""
    html = (f"<p>{filler(4)}</p>"
            "<p>The director said the launch was “not a failure — just early” and asked "
            "the team to keep going. It’s the team’s call what happens next.</p>"
            f"<p>{filler(4)}</p>")
    write_story(html, HERE / "curly.pdf", fontsize="11pt")


def scanned():
    """A page that is only a picture of text. No OCR, so this must come back not found."""
    src = pymupdf.open(HERE / "contract.pdf")
    pix = src[0].get_pixmap(dpi=100)
    doc = pymupdf.open()
    page = doc.new_page(width=W, height=H)
    page.insert_image(page.rect, pixmap=pix)
    doc.save(HERE / "scanned.pdf")


def notes():
    """A markdown file long enough to span several generated pages, with typographic punctuation."""
    parts = ["# Meeting notes", ""]
    for week in range(1, 9):
        parts += [f"## Week {week}", ""]
        for _ in range(4):
            parts += [f"- {filler(1)}"]
        parts += ["", filler(5), ""]
        if week == 5:
            parts += ["Decision: we’ll ship the beta on 14 March — after the security review, not before.", ""]
    (HERE / "notes.md").write_text("\n".join(parts))


CITIES = ["Lisbon", "Porto", "Madrid", "Seville", "Lyon", "Nantes", "Turin", "Bologna", "Ghent", "Utrecht",
          "Leipzig", "Bremen", "Krakow", "Gdansk", "Brno", "Graz", "Malmo", "Aarhus", "Tampere", "Bergen",
          "Cork", "Galway", "Bilbao", "Valencia", "Marseille", "Nice", "Genoa", "Verona", "Antwerp", "Basel"]


def tables():
    """The same city table as CSV, TSV and XLSX (second sheet has different data)."""
    rows = [["city", "country", "population", "note"]]
    for i, city in enumerate(CITIES):
        rows.append([city, rng.choice(["PT", "ES", "FR", "IT", "BE", "NL", "DE", "PL", "CZ", "AT"]),
                     str(100_000 + i * 37_123), rng.choice(["port city", "university town", "old town", "river crossing"])])
    rows[17][3] = "host of the 2031 regional games"
    (HERE / "cities.csv").write_text("\n".join(",".join(r) for r in rows) + "\n")
    (HERE / "cities.tsv").write_text("\n".join("\t".join(r) for r in rows) + "\n")
    import openpyxl
    book = openpyxl.Workbook()
    book.active.title = "cities"
    for r in rows:
        book.active.append(r)
    budget = book.create_sheet("budget")
    for r in [["item", "amount"], ["rent", 1200], ["travel", 340], ["conference fees", 910]]:
        budget.append(r)
    book.save(HERE / "cities.xlsx")


def photo():
    """A screenshot-like PNG of the contract's first page: an image, so it can't be searched."""
    pymupdf.open(HERE / "contract.pdf")[0].get_pixmap(dpi=72).save(HERE / "photo.png")


def stamped():
    """Body text plus things only a viewer shows: a filled form field, a highlight and a red stamp."""
    doc = pymupdf.open()
    page = doc.new_page(width=W, height=H)
    marked = "The invoice was checked against the purchase order before payment was released."
    body = (filler(4) + "\n\n" + marked + " " + filler(3) + "\n\n"
            + "The finance team signed off on the amount shown in the field below. " + filler(3))
    page.insert_textbox(pymupdf.Rect(72, 72, W - 72, 290), body, fontsize=11)
    for r in page.search_for(marked):
        page.add_highlight_annot(r)
    page.insert_text((72, 322), "Amount approved:", fontsize=11)
    field = pymupdf.Widget()
    field.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    field.field_name = "amount"
    field.field_value = "$4,200.00"
    field.rect = pymupdf.Rect(170, 308, 300, 328)
    field.text_fontsize = 11
    page.add_widget(field)
    stamp = page.add_freetext_annot(pymupdf.Rect(360, 300, 520, 340), "APPROVED", fontsize=22,
                                    text_color=(0.85, 0.1, 0.1), align=1)
    stamp.set_border(width=2)
    stamp.update()
    doc.save(HERE / "stamped.pdf")


TABS = {
    "summary": [["quarter", "revenue", "cost"], ["Q1", 41000, 30500], ["Q2", 45500, 31900]],
    "q2 detail": [["month", "region", "revenue"], ["April", "north", 15100], ["May", "south", 14800], ["June", "east", 15600]],
    "feedback": [["customer", "comment"],
                 ["Arvo Ltd", "Setup took two days because the import tool rejected our older spreadsheets."],
                 ["Brightline", "Support answered within the hour every time we opened a ticket this quarter."],
                 ["Cobalt Foods", "We would renew if the reporting screen could export straight to PDF."]],
}


def workbook():
    """Three tabs; the long written comments are on the last one, where claim has to go looking.
    The same book as .xlsx, .xlsm (the macro-enabled kind) and .xls (the pre-2007 kind)."""
    import openpyxl
    book = openpyxl.Workbook()
    book.remove(book.active)
    for name, rows in TABS.items():
        ws = book.create_sheet(name)
        for r in rows:
            ws.append(r)
    book.save(HERE / "tabs.xlsx")
    book.save(HERE / "tabs.xlsm")
    try:
        import xlwt  # only here; run with `uv run --with xlwt` to rewrite tabs.xls
    except ImportError:
        return
    old = xlwt.Workbook()
    for name, rows in TABS.items():
        ws = old.add_sheet(name)
        for i, r in enumerate(rows):
            for j, v in enumerate(r):
                ws.write(i, j, v)
    old.save(str(HERE / "tabs.xls"))


def formats():
    """Cells stored one way and shown another: money, a date, a percentage."""
    import datetime
    import openpyxl
    book = openpyxl.Workbook()
    ws = book.active
    ws.title = "expenses"
    ws.append(["item", "cost", "date", "share"])
    for item, cost, day, share in [("Hotel in Lisbon", 1234.5, 5, 0.125), ("Train to Porto", 48, 6, 0.02),
                                   ("Conference ticket", 2100, 8, 0.31), ("Taxi", 2.5, 9, 0.5)]:
        ws.append([item, cost, datetime.datetime(2024, 1, day), share])
    for row in ws.iter_rows(min_row=2):
        row[1].number_format, row[2].number_format, row[3].number_format = '"$"#,##0.00', "d-mmm-yy", "0.0%"
    # The last row: a cost rounded to a whole number (2.5 shows as 3, not 2), a date with words in it, a padded id.
    ws["B5"].number_format, ws["C5"].number_format = "0", '"on" d mmm'
    ws["E1"], ws["E5"] = "ref", 42
    ws["E5"].number_format = "0000"
    ws["F1"], ws["F5"] = "ratio", 0.599969  # shown as 0.60; an answer saying 60% means this cell
    ws["F5"].number_format = "0.00"
    ws["G1"], ws["G2"] = "change", -0.052  # shown as -5.2%; an answer saying 5.2% has dropped the sign
    ws["G2"].number_format = "0.0%"
    ws.append(["Total", "=SUM(B2:B5)"])  # a formula with no saved result, as any script writes it
    book.save(HERE / "formats.xlsx")


def titled():
    """A sheet as people make them: a title on its own line and a blank row above the real header."""
    import openpyxl
    book = openpyxl.Workbook()
    ws = book.active
    ws.title = "travel"
    ws.append(["Q3 travel expenses"])
    ws.append([])
    ws.append(["item", "cost", "city"])
    for row in [["Hotel", 640, "Lisbon"], ["Train", 48, "Porto"], ["Flight", 212, "Madrid"]]:
        ws.append(row)
    book.save(HERE / "titled.xlsx")


def write_story(html, path, fontsize):
    """Flow HTML across as many A4 pages as it needs."""
    story = pymupdf.Story(html=html, user_css=f"body {{font-size:{fontsize}; font-family:serif}}")
    writer = pymupdf.DocumentWriter(str(path))
    more = True
    while more:
        dev = writer.begin_page(pymupdf.Rect(0, 0, W, H))
        more, _ = story.place(pymupdf.Rect(60, 60, W - 60, H - 60))
        story.draw(dev)
        writer.end_page()
    writer.close()


def units():
    """Figures with a size or percent beside them, so a bare number never passes for one."""
    Path(HERE / "units.md").write_text(
        "# Quarter in numbers\n\nRevenue grew 4.5% this quarter.\nSales were 4.5 billion in total.\n"
        "Costs were $2.1B, and headcount reached 3,000.\n")


def filing():
    """A statement whose amounts are in millions, as a 10-K writes them: the numbers are bare."""
    Path(HERE / "filing.md").write_text(
        "# Consolidated statement (Amounts in millions)\n\n"
        "Net income attributable to shareholders 21,893\n"
        "Total shareholders' equity 99,617 at year-end and 91,013 a year earlier\n"
        "Total assets 284,668\n")


if __name__ == "__main__":
    paper(); contract(); report(); hyphen(); pagebreak(); curly(); scanned(); notes(); tables(); photo()
    stamped(); workbook(); formats(); titled(); units(); filing()
    print("fixtures written")
