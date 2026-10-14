"""Image source: put the picture on a PDF page as-is. There is no text in it to search."""

import pymupdf

KINDS = (".png", ".jpg", ".jpeg")
MAX_WIDTH = 800  # points; a phone photo is 4000 pixels wide and would make a huge PNG


def load(path):
    pix = pymupdf.Pixmap(str(path))
    width, height = pix.width, pix.height
    scale = min(1, MAX_WIDTH / width)
    doc = pymupdf.open()
    page = doc.new_page(width=width * scale, height=height * scale)
    page.insert_image(page.rect, filename=str(path))
    return doc
