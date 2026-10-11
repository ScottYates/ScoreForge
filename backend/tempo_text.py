"""backend/tempo_text.py -- read the tempo the engraver printed, as text.

The notes engine reads notes and ignores words, so every scan used to come
back with no tempo at all and the app fell back to its default -- a Moonlight
sonata page, marked "Adagio sostenuto.", played at twice any sane speed. The
words are right there on the page; this module turns them into a tempo.

Two sources, in order of authority:

  * a metronome mark ("= 60", "M.M. = 92"): the printed number wins outright,
    accepted only in the range a metronome mark can plausibly mean;
  * a tempo term ("Adagio sostenuto", "Allegro ma non troppo"): looked up in
    a table of conventional values, longest match first, so a qualified term
    is never mistaken for its stem. The values are midpoints of the ranges
    every metronome agrees on; a convention, not a measurement, and a label
    rides along so the UI can say where the tempo came from.

Pure standard library: detection and injection are exercised by
tools/check-omr-tempo.mjs on machines with no backend stack at all. The OCR
that produces the text lines lives in omr_engine, next to the engine's own
title detection, and degrades to "no tempo found" wherever OCR is missing.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import List, Optional

# Conventional quarter-note BPM per term. Longest match first is the LOOKUP
# rule; the order here is just readable grouping. Values are the midpoints of
# the ranges printed on metronomes since Maelzel; the qualified forms shade
# their stem the way players read them.
TEMPO_TERMS: List[tuple[str, int]] = [
    ("grave", 40),
    ("largo assai", 44),
    ("largo", 48),
    ("larghetto", 56),
    ("lento", 52),
    ("adagio sostenuto", 54),
    ("adagio molto", 56),
    ("adagio", 64),
    ("andante sostenuto", 72),
    ("andante con moto", 92),
    ("andante", 84),
    ("andantino", 88),
    ("moderato", 104),
    ("allegretto", 112),
    ("allegro ma non troppo", 118),
    ("allegro moderato", 118),
    ("allegro con brio", 140),
    ("allegro con fuoco", 144),
    ("allegro assai", 144),
    ("allegro vivace", 152),
    ("allegro", 132),
    ("vivace", 160),
    ("presto", 180),
    ("prestissimo", 204),
]

# "= 92", "M.M. = 60", "♩= 54". OCR rarely survives the note glyph, so the
# number after the equals sign is the anchor; the glyph, when present, is
# whatever OCR made of it and is not trusted to choose a beat unit.
_METRONOME = re.compile(r"=\s*(\d{2,3})")

# Accept only what a metronome can print. OCR turns page numbers and opus
# numbers into digits too, and "= 248" from a page header must not become a
# tempo.
_BPM_LO, _BPM_HI = 30, 220


def detect_tempo(lines: List[str]) -> Optional[dict]:
    """The tempo the page's text declares, or None.

    `lines` are OCR'd text fragments from the top of the page, in reading
    order. A metronome mark beats a term; among terms, the longest match in
    any single line wins, and the earliest line breaks ties -- tempo words
    head the piece, so an "allegro" in a dedication below never outranks the
    heading above it.
    """
    for line in lines:
        m = _METRONOME.search(line or "")
        if m:
            bpm = int(m.group(1))
            if _BPM_LO <= bpm <= _BPM_HI:
                return {"bpm": bpm, "source": "metronome mark", "matched": m.group(0)}

    best: Optional[dict] = None
    for index, line in enumerate(lines):
        lowered = re.sub(r"[^a-zà-ü ]+", " ", (line or "").lower())
        lowered = " " + re.sub(r"\s+", " ", lowered).strip() + " "
        for term, bpm in TEMPO_TERMS:
            if f" {term} " in lowered:
                if best is None or len(term) > len(best["matched"]):
                    best = {"bpm": bpm, "source": "tempo term", "matched": term, "_line": index}
    if best:
        best.pop("_line", None)
    return best


def inject_tempo(xml_text: str, bpm: int, words: str) -> str:
    """Write the detected tempo into a MusicXML document's first measure.

    A document that already declares any tempo -- a <sound tempo> or a
    metronome <per-minute> -- is returned untouched: the page's own markup
    outranks our reading of its prose.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return xml_text

    for el in root.iter("sound"):
        if el.get("tempo"):
            return xml_text
    for el in root.iter("per-minute"):
        return xml_text

    part = root.find("part")
    measure = part.find("measure") if part is not None else None
    if measure is None:
        return xml_text

    direction = ET.Element("direction", {"placement": "above"})
    dtype = ET.SubElement(direction, "direction-type")
    w = ET.SubElement(dtype, "words")
    w.text = words
    ET.SubElement(direction, "sound", {"tempo": str(int(bpm))})

    # Before the first note, after any attributes, which is where a tempo
    # direction belongs and where every parser expects to find it.
    insert_at = 0
    for i, child in enumerate(list(measure)):
        if child.tag == "note":
            insert_at = i
            break
        insert_at = i + 1
    measure.insert(insert_at, direction)
    return ET.tostring(root, encoding="unicode")
