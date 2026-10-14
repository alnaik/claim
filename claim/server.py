"""The MCP server: one tool, `claim`, that returns one picture and one line of text."""

import hashlib
import json

from mcp.server.mcpserver import Image, MCPServer

from claim.cli import dump
from claim.core import claim as find_and_draw
from claim.sources.url import scratch

server = MCPServer("claim")


# [stop 8] The tool the AI sees, and the server that carries it.
# The description tells the AI when to call it; the tool runs core's claim() and hands
# back the picture, then one text line ending in the first 8 characters of the file's
# fingerprint. main() talks to the host over stdin/stdout, so there is no port and no network.
@server.tool(description=(
    "Show the source page for a quote, with the quote highlighted. Call this "
    "after citing any document so the user can visually verify the citation. "
    "Pass the quote as you wrote it and the page number if you know it. "
    "claim runs on the user's computer, so `file` is a full path there (or a URL). "
    "A file uploaded to the chat is not on that computer: ask the user for its path."
))
def claim(file: str, quote: str, page: int | None = None) -> list:
    result = find_and_draw(file, quote, page)
    text = result["text"] + (f" · {result['sha256'][:8]}" if result["sha256"] else "")
    hand_off(file, quote, page, result)
    return [Image(data=result["png"], format="png"), text]


def hand_off(file, quote, page, result):
    """Leave the plain fields (what `claim --json` prints) in the temp folder for the Claude Code
    plugin, named after the call, so it can draw the card without running claim a second time.
    The name is the sha256 of [file, quote, page] written the way JavaScript's JSON.stringify writes it."""
    try:
        call = json.dumps([file, quote, page], ensure_ascii=False, separators=(",", ":"))
        out = scratch() / f"call-{hashlib.sha256(call.encode()).hexdigest()}.json"
        out.write_text(json.dumps(dump(dict(result)), ensure_ascii=False), encoding="utf-8")
    except Exception:  # the picture for the model matters more; the plugin runs claim itself instead
        pass


def main():
    server.run("stdio")


if __name__ == "__main__":
    main()
