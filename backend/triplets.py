"""backend/triplets.py -- repair triplet runs the recogniser read as straight.

The failure this repairs, seen on a real page (the Moonlight sonata, first
movement): the music is continuous triplets, the engraving prints the "3" on
the first group of a passage and trusts the reader for the rest, and the
recogniser does the same -- it marks the groups it saw a digit over and reads
every other group as straight eighths. Each such bar then holds half again as
much time as its signature allows, and the piece is rhythmic rubble even
though nearly every PITCH was read correctly.

The repair is arithmetic, not guesswork, and it only acts where the numbers
prove it:

  * a bar is examined only when a voice's content OVERFLOWS the measure's
    nominal length -- a bar that adds up is never touched;
  * only maximal runs of consecutive, equal-duration, unmarked notes are
    candidates, taken in whole groups of three;
  * groups are converted (duration x 2/3, plus the 3:2 time-modification)
    only if some combination of whole groups accounts for the overflow
    EXACTLY. If the overflow cannot be explained exactly by 3:2 groups, the
    bar is left alone and reported, because a repair that merely shrinks the
    error replaces honest rubble with confident rubble.

Pure standard library on purpose: the pass runs inside the service, but it is
also exercised by `tools/check-omr-triplets.mjs` on machines with no backend
stack at all, and by tools/score_omr.py so the README's accuracy table
describes what the service actually returns.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class RepairReport:
    measures_seen: int = 0
    measures_overfull: int = 0
    measures_repaired: int = 0
    notes_converted: int = 0
    measures_unrepairable: List[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "measuresSeen": self.measures_seen,
            "measuresOverfull": self.measures_overfull,
            "measuresRepaired": self.measures_repaired,
            "notesConverted": self.notes_converted,
            "measuresUnrepairable": list(self.measures_unrepairable),
        }


def _nominal_length(divisions: int, beats: int, beat_type: int) -> int:
    # divisions are per quarter; a bar holds beats * (4/beat_type) quarters.
    return divisions * beats * 4 // beat_type


def _is_marked(note: ET.Element) -> bool:
    return note.find("time-modification") is not None


def _chord_groups(notes: List[ET.Element]) -> List[List[ET.Element]]:
    """Group a voice's notes into onsets: a <chord> note shares its head's."""
    groups: List[List[ET.Element]] = []
    for n in notes:
        if n.find("chord") is not None and groups:
            groups[-1].append(n)
        else:
            groups.append([n])
    return groups


def _dur(note: ET.Element) -> int:
    try:
        return int(note.findtext("duration") or 0)
    except ValueError:
        return 0


def _convert_group(group: List[ET.Element]) -> None:
    """Turn one onset into a triplet member: 2/3 duration, 3:2 marking."""
    for n in group:
        d = _dur(n)
        el = n.find("duration")
        if el is not None:
            el.text = str(d * 2 // 3)
        tm = ET.Element("time-modification")
        actual = ET.SubElement(tm, "actual-notes")
        actual.text = "3"
        normal = ET.SubElement(tm, "normal-notes")
        normal.text = "2"
        # Schema order: time-modification sits after duration/tie/voice/type;
        # inserting before <stem>/<notations>/<staff> keeps validators happy,
        # and our own parser reads it positionally-agnostically either way.
        anchor = None
        for i, child in enumerate(list(n)):
            if child.tag in ("stem", "notehead", "staff", "beam", "notations", "lyric"):
                anchor = i
                break
        if anchor is None:
            n.append(tm)
        else:
            n.insert(anchor, tm)


def repair_measure_voice(groups: List[List[ET.Element]], overflow: int) -> Optional[List[List[ET.Element]]]:
    """Choose whole triplet-groups whose 3:2 conversion equals `overflow`.

    Returns the onset-groups to convert, or None when no exact fit exists.
    Runs are maximal stretches of equal-duration, unmarked, divisible-by-3
    onsets; each contributes savings in steps of one whole triplet (three
    onsets saving one onset-duration of time).
    """
    runs: List[List[List[ET.Element]]] = []
    current: List[List[ET.Element]] = []
    cur_d = None
    for g in groups:
        d = _dur(g[0])
        plain = (not any(_is_marked(n) for n in g)) and d > 0 and (d * 2) % 3 == 0 \
            and g[0].find("rest") is None and not any(n.find("grace") is not None for n in g)
        if plain and d == cur_d:
            current.append(g)
        else:
            if len(current) >= 3:
                runs.append(current)
            current = [g] if plain else []
            cur_d = d if plain else None
    if len(current) >= 3:
        runs.append(current)
    if not runs:
        return None

    # Each run of length k (in onsets) offers floor(k/3) whole triplets, each
    # saving d (one onset-duration per converted group of three). Exact subset
    # sum over these small step sizes; totals here are tiny, so brute force by
    # dynamic programming on the overflow amount.
    options = []  # (savings_per_step, max_steps, run_index)
    for idx, run in enumerate(runs):
        d = _dur(run[0][0])
        options.append((d, len(run) // 3, idx))

    best: dict[int, List[tuple[int, int]]] = {0: []}
    for step, max_steps, idx in options:
        new_best = dict(best)
        for reached, picks in best.items():
            for k in range(1, max_steps + 1):
                tot = reached + step * k
                if tot > overflow:
                    break
                if tot not in new_best:
                    new_best[tot] = picks + [(idx, k)]
        best = new_best
    picks = best.get(overflow)
    if picks is None:
        return None

    to_convert: List[List[ET.Element]] = []
    for idx, k in picks:
        to_convert.extend(runs[idx][: 3 * k])
    return to_convert


def repair_triplets(xml_text: str) -> tuple[str, RepairReport]:
    """Repair unmarked triplet runs in a MusicXML document; see module doc."""
    report = RepairReport()
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return xml_text, report

    for part in root.findall("part"):
        divisions = 1
        beats, beat_type = 4, 4
        for measure in part.findall("measure"):
            report.measures_seen += 1
            d = measure.find(".//divisions")
            if d is not None and (d.text or "").strip().isdigit():
                divisions = int(d.text)
            ts = measure.find(".//time")
            if ts is not None:
                try:
                    beats = int(ts.findtext("beats") or beats)
                    beat_type = int(ts.findtext("beat-type") or beat_type)
                except ValueError:
                    pass
            nominal = _nominal_length(divisions, beats, beat_type)
            if nominal <= 0:
                continue

            # Partition the measure's notes by voice; chords count once.
            by_voice: dict[str, List[ET.Element]] = {}
            for n in measure.findall("note"):
                by_voice.setdefault(n.findtext("voice") or "1", []).append(n)

            overfull = False
            repaired_all = True
            for voice, notes in by_voice.items():
                groups = _chord_groups(notes)
                length = sum(_dur(g[0]) for g in groups)
                overflow = length - nominal
                if overflow <= 0:
                    continue
                overfull = True
                chosen = repair_measure_voice(groups, overflow)
                if chosen is None:
                    repaired_all = False
                    continue
                for g in chosen:
                    _convert_group(g)
                    report.notes_converted += len(g)
            if overfull:
                report.measures_overfull += 1
                if repaired_all:
                    report.measures_repaired += 1
                else:
                    report.measures_unrepairable.append(measure.get("number") or "?")

    if report.notes_converted == 0:
        return xml_text, report
    return ET.tostring(root, encoding="unicode"), report
