"""Web page source: have a headless Chrome print the page to a PDF, styled as on screen.

After the search has decided, screenshot() takes the picture from the live page instead.
"""

WIDTH, HEIGHT = 1280, 960  # the browser window for screenshots, in CSS pixels

# Walk the page's text, fold it the way core.normalize does (curly quotes and long
# dashes made plain, runs of whitespace made one space, lower case), find the
# matched text in it, and return a Range over those characters, or null.
FIND = """needle => {
  const fold = c => ({'“':'"','”':'"','‘':"'",'’':"'",'–':'-','—':'-'})[c] || c;
  let flat = '', where = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walk.nextNode());) {
    if (node.parentElement.closest('script, style, noscript')) continue;
    for (let i = 0; i < node.data.length; i++) {
      let c = fold(node.data[i]);
      if (c === '\\u00ad') continue;  // soft hyphen
      if (/\\s/.test(c)) { if (flat.endsWith(' ')) continue; c = ' '; }
      flat += c.toLowerCase(); where.push([node, i]);
    }
  }
  const at = flat.indexOf(needle.toLowerCase());
  if (at < 0) return null;
  const range = document.createRange();
  range.setStart(...where[at]);
  const [last, i] = where[at + needle.length - 1];
  range.setEnd(last, i + 1);
  return range;
}"""


def load(url, path):
    from playwright.sync_api import sync_playwright  # only needed for web pages

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            raise ValueError("web pages need a browser: run `uv run playwright install chromium`")
        page = browser.new_page()
        page.goto(url, wait_until="networkidle", timeout=30_000)
        page.emulate_media(media="screen")  # look like the site, not its print stylesheet
        page.pdf(path=str(path), format="A4", print_background=True,
                 margin={"top": "20px", "bottom": "20px", "left": "20px", "right": "20px"})
        browser.close()
    return path


def screenshot(url, matched, rgb):
    """A 2x PNG of the live page around `matched`, highlighted by the browser itself; None if not found."""
    from playwright.sync_api import sync_playwright

    colour = "rgba({}, {}, {}, 0.35)".format(*(round(c * 255) for c in rgb))
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=2)
        page.goto(url, wait_until="networkidle", timeout=30_000)
        page.add_style_tag(content=f"::highlight(claim) {{ background-color: {colour}; }}")
        box = page.evaluate(f"""needle => {{
          const range = ({FIND})(needle);
          if (!range) return null;
          CSS.highlights.set('claim', new Highlight(range));
          range.startContainer.parentElement.scrollIntoView({{block: 'center'}});
          const r = range.getBoundingClientRect();
          return {{top: r.top, bottom: r.bottom}};
        }}""", matched)
        if box is None:
            browser.close()
            return None
        height = min(max(HEIGHT / 3, box["bottom"] - box["top"] + 40), HEIGHT)
        top = (box["top"] + box["bottom"]) / 2 - height / 2
        top = max(0, min(top, HEIGHT - height))
        shot = page.screenshot(clip={"x": 0, "y": top, "width": WIDTH, "height": height})
        browser.close()
    return shot
