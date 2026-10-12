"""backend/staffcount.py -- an independent count of the staves on a page.

The recogniser's dominant failure on dense pages is not misreading notes, it
is losing whole staves before reading begins: the eleven-stave vocal-book
photo that motivated this module came back as ONE melody, presented as a
success. The engine cannot audit itself -- its staff detector is the thing
that failed -- so this is a second opinion from entirely different machinery:
classical line detection, no model, milliseconds on the CPU.

The estimate is deliberately coarse. It exists to catch a transcription that
used dramatically fewer staves than the page shows, not to referee close
calls, so the flag only fires on a strong mismatch (see staff_check).
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Optional

import cv2
import numpy as np

# A horizontal run must span at least this share of the page width to count
# as (part of) a staff line. Staff lines run nearly the full system width;
# barlines, stems and text never produce runs this long.
_MIN_RUN_WIDTH = 0.35
# A row needs at least this share of its width in long-run ink to be a line.
_MIN_ROW_INK = 0.30
# Within a staff, line gaps are regular; a gap this many times the typical
# line gap separates one staff from the next.
_STAFF_SPLIT = 2.5


def estimate_staves(img: np.ndarray) -> dict:
    """Count the 5-line staves visible on a page image (BGR or grayscale)."""
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                   cv2.THRESH_BINARY_INV, 31, 12)
    # Keep only long horizontal runs: erode with a wide kernel so anything
    # narrower than a staff line's span disappears, then restore the length.
    k = max(16, int(w * _MIN_RUN_WIDTH) // 8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1))
    lines_img = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    row_ink = lines_img.sum(axis=1) / 255.0 / max(w, 1)
    line_rows = row_ink > _MIN_ROW_INK

    # Collapse consecutive line rows (a line is a few pixels tall) to centers.
    centers = []
    start: Optional[int] = None
    for y in range(h + 1):
        on = y < h and line_rows[y]
        if on and start is None:
            start = y
        elif not on and start is not None:
            centers.append((start + y - 1) / 2.0)
            start = None
    if len(centers) < 4:
        return {"lines": len(centers), "staves": 0, "spacing": None}

    gaps = np.diff(centers)
    spacing = float(np.median(gaps))
    # Split into staves where the gap opens up well beyond the line spacing.
    clusters = [[centers[0]]]
    for c, g in zip(centers[1:], gaps):
        if g > spacing * _STAFF_SPLIT:
            clusters.append([])
        clusters[-1].append(c)
    # A staff is five lines; tolerate one lost or gained to detection noise.
    staves = sum(1 for cl in clusters if 4 <= len(cl) <= 6)
    return {"lines": len(centers), "staves": staves,
            "spacing": round(spacing, 2), "clusters": [len(c) for c in clusters]}


def used_staves(xml_text: str) -> int:
    """Physical staves the transcription accounts for: systems x staff lines.

    MusicXML counts logical staves per part; the same part printed across
    five systems is five physical staves on paper. System breaks arrive as
    <print new-system="yes"/>, so physical staves = systems x (sum of each
    part's staff count).
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return 0
    parts = root.findall("part")
    if not parts:
        return 0
    total_logical = 0
    systems = 1
    for part in parts:
        staff_nos = set()
        breaks = 0
        for measure in part.findall("measure"):
            pr = measure.find("print")
            if pr is not None and pr.get("new-system") == "yes":
                breaks += 1
            for note in measure.findall("note"):
                st = note.findtext("staff")
                if st and st.strip().isdigit():
                    staff_nos.add(int(st))
        total_logical += max(1, len(staff_nos))
        systems = max(systems, breaks + 1)
    return systems * total_logical


def staff_check(img: np.ndarray, xml_text: str) -> dict:
    """Compare what the page shows with what the transcription used.

    Flags only a STRONG mismatch -- the estimate is a heuristic, and a flag
    that cries wolf teaches people to ignore the panel. "Used" within ~half
    of "estimated", or within two staves, passes without comment.
    """
    est = estimate_staves(img)
    used = used_staves(xml_text)
    estimated = est.get("staves", 0)
    flagged = bool(estimated >= 4 and used > 0
                   and estimated - used >= 3
                   and estimated >= used * 1.8)
    return {"estimated": estimated, "used": used, "flagged": flagged,
            "lines": est.get("lines", 0)}
