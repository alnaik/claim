"""What claim reads out of a file (a spreadsheet's sheets, a PDF's text), kept in claim's temp
folder until the file changes, so the next process that needs it doesn't read the file again."""

import hashlib
import json
import os
from pathlib import Path

from claim.sources.url import scratch

# The newest of claim's own source files: a change to how claim reads a file makes every kept reading stale.
CODE = max(f.stat().st_mtime_ns for f in Path(__file__).parent.rglob("*.py"))


def kept(path, what, read):
    """What read() gives for this file: from the temp folder if this version of the file (same path,
    modification time and size) was read before by this version of claim, else read now and saved.
    `what` names the kind of reading."""
    path = Path(path).expanduser().absolute()
    st = path.stat()
    key = hashlib.sha256(f"{what}\0{path}\0{st.st_mtime_ns}\0{st.st_size}\0{CODE}".encode()).hexdigest()
    saved = scratch() / f"read-{key}.json"
    try:
        return json.loads(saved.read_text(encoding="utf-8"))
    except (OSError, ValueError):  # not there yet, or half written by another process
        value = read()
        part = saved.with_suffix(f".{os.getpid()}")  # write aside, then swap in, so a reader never sees half
        part.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        os.replace(part, saved)
        return value
