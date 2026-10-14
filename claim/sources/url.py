"""URL source: download the file to a temp folder, then treat it like a local file."""

import shutil
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from claim.sources import html

BY_TYPE = {"application/pdf": ".pdf", "text/csv": ".csv", "image/png": ".png", "image/jpeg": ".jpg"}


def is_url(file):
    return str(file).startswith(("http://", "https://"))


def name(url):
    return unquote(Path(urlparse(url).path).name) or urlparse(url).netloc


def scratch():
    """claim's own folder in the temp directory, for downloads, crop pictures, what was read out of
    files (cache.py) and the server's hand-off to the plugin. Only its owner can open it.
    Anything in it older than a day is thrown away first, so it never fills up."""
    folder = Path(tempfile.gettempdir()) / "claim"
    folder.mkdir(mode=0o700, exist_ok=True)
    folder.chmod(0o700)  # an older folder, or one another user made first: this fails rather than share it
    for old in folder.iterdir():
        if old.stat().st_mtime < time.time() - 24 * 3600:
            shutil.rmtree(old, ignore_errors=True) if old.is_dir() else old.unlink(missing_ok=True)
    return folder


def download(url):
    """Returns (local path, True if it was a web page printed to a PDF)."""
    request = urllib.request.Request(url, headers={"User-Agent": "claim"})
    with urllib.request.urlopen(request, timeout=20) as response:
        kind = response.headers.get_content_type()
        folder = Path(tempfile.mkdtemp(prefix="dl-", dir=scratch()))
        if kind == "text/html":  # a web page: print it to a PDF instead of saving the HTML
            return html.load(url, folder / (Path(name(url)).stem + ".pdf")), True
        filename = name(url)
        # Trust the server about the type: arxiv.org/pdf/1706.03762 is a PDF despite its "extension".
        if kind in BY_TYPE and Path(filename).suffix.lower() != BY_TYPE[kind]:
            filename += BY_TYPE[kind]
        path = folder / filename
        path.write_bytes(response.read())
    return path, False


def link(url, matched, page=None):
    """A link that opens the source at the quote. A web page gets a text fragment (#:~:text=),
    which Chrome, Edge, Safari and Firefox follow to scroll to the passage and highlight it;
    a long passage is named by its first and last four words. A PDF gets #page=N."""
    base = url.split("#")[0]
    if page:
        return f"{base}#page={page}"
    part = lambda text: quote(text, safe="").replace("-", "%2D")  # a bare - means something in a fragment
    words = matched.split()
    text = part(matched) if len(words) <= 8 else f"{part(' '.join(words[:4]))},{part(' '.join(words[-4:]))}"
    return f"{base}#:~:text={text}"
