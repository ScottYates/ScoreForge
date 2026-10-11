"""tools/score_omr.py -- OMR accuracy scorer.

Runs homr over the generated fixtures and compares the resulting MusicXML
against the known-good note list that was used to draw the image.

Reports, per fixture and overall:
  * pitch precision / recall / F1  (note identity matched on a time-aligned
    sequence, so a wrong note costs both a false positive and a false negative)
  * duration accuracy              (fraction of aligned notes with the right
    written length in quarter notes)
  * mean absolute pitch error      (semitones, over aligned notes)

Usage:
    python tools/score_omr.py [piece ...] [--degrade photo|scan|none]

The --degrade flag re-renders each fixture through a realistic scan/photo
degradation *before* OCR, to measure how the engine copes with real scans.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"

sys.path.insert(0, str(ROOT / "backend"))

_STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


# --------------------------------------------------------------------------
# MusicXML -> flat note list
# --------------------------------------------------------------------------
def read_musicxml_notes(path: Path) -> list[dict]:
    """Extract [{midi, quarters, part, staff}] from a MusicXML file.

    Rests are kept as midi=None so the scorer can tell "missed a note" apart
    from "inserted a spurious note". The <staff> element is tracked because a
    grand staff interleaves both hands in document order -- comparing a flat
    list against a flat ground truth would call correct music wrong on
    ordering alone.
    """
    root = ET.parse(path).getroot()
    out: list[dict] = []
    divisions = 1.0
    for part in root.iter("part"):
        part_id = part.get("id", "P1")
        staff = 1
        for measure in part.iter("measure"):
            for div in measure.findall("attributes/divisions"):
                divisions = float(div.text or 1)
            for child in measure:
                if child.tag == "backup":
                    continue
                if child.tag != "note":
                    continue
                note = child
                st_el = note.find("staff")
                if st_el is not None and st_el.text:
                    staff = int(st_el.text)
                is_chord = note.find("chord") is not None
                dur_el = note.find("duration")
                quarters = (float(dur_el.text) / divisions) if dur_el is not None else 0.0
                pitch = note.find("pitch")
                midi = None
                if pitch is not None:
                    step = (pitch.findtext("step") or "C").strip()
                    alter = float(pitch.findtext("alter") or 0)
                    octave = int(pitch.findtext("octave") or 4)
                    midi = 12 * (octave + 1) + _STEPS.get(step, 0) + int(round(alter))
                out.append({"midi": midi, "quarters": quarters, "part": part_id,
                            "staff": staff, "chord": is_chord})
    return out


def read_ground_truth(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    # A ground truth that disagrees with the page it describes is a fixture
    # bug, not an OMR result. Scoring it would blame the OCR for notes that
    # were never printed.
    if not data.get("consistent", True):
        raise ValueError(
            f"{path.name}: fixture declares {data.get('sourceNotes')} notes + "
            f"{data.get('restCount')} rests but the page shows "
            f"{data.get('renderedNotes')} -- regenerate the fixture"
        )
    return data


def score_staves(gt: dict, hyp: list[dict]) -> dict:
    """Score each staff independently, then aggregate.

    A grand staff interleaves both hands in document order -- in the engraving
    and equally in the OCR output -- so a single flat alignment across the
    whole system would penalise a transcription for being in the right order
    at the wrong granularity.
    """
    staves = gt.get("staves") or [
        {"index": 1, "name": "staff", "notes": gt["notes"]}
    ]
    merged = {"ref_notes": 0, "hyp_notes": 0, "tp": 0, "fp": 0, "fn": 0,
              "duration_hits": 0, "semitone_err": 0, "per_staff": []}

    for st in staves:
        idx = st["index"]
        ref = st["notes"]
        h = [n for n in hyp if n.get("staff", 1) == idx]
        s = score_pair(ref, h)
        merged["per_staff"].append({
            "name": st.get("name"), "index": idx,
            "ref_notes": s["ref_notes"], "hyp_notes": s["hyp_notes"],
            "tp": s["tp"], "fp": s["fp"], "fn": s["fn"], "pairs": s["pairs"],
        })
        merged["ref_notes"] += s["ref_notes"]
        merged["hyp_notes"] += s["hyp_notes"]
        merged["tp"] += s["tp"]
        merged["fp"] += s["fp"]
        merged["fn"] += s["fn"]
        merged["duration_hits"] += s["_dur_hits"]
        merged["semitone_err"] += s["_semi_err"]

    tp, fp, fn = merged["tp"], merged["fp"], merged["fn"]
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    merged.update({
        "precision": precision,
        "recall": recall,
        "f1": (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0,
        "duration_acc": (merged["duration_hits"] / tp) if tp else 0.0,
        "mean_pitch_err": (merged["semitone_err"] / tp) if tp else None,
    })
    return merged


# --------------------------------------------------------------------------
# Alignment
# --------------------------------------------------------------------------
def align(ref: list[dict], hyp: list[dict]) -> list[tuple[int | None, int | None]]:
    """Levenshtein-style alignment over (midi, quarters) pairs.

    Substitution costs 1, insertion/deletion 1, match 0.  Ties are resolved in
    a fixed order so the alignment is deterministic across runs.
    """
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i
    for j in range(1, m + 1):
        dp[0][j] = j

    for i in range(1, n + 1):
        ri = ref[i - 1]
        for j in range(1, m + 1):
            hj = hyp[j - 1]
            same = ri.get("midi") is not None and ri.get("midi") == hj.get("midi")
            dp[i][j] = min(dp[i - 1][j - 1] + (0 if same else 1), dp[i - 1][j] + 1, dp[i][j - 1] + 1)

    pairs: list[tuple[int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            ri, hj = ref[i - 1], hyp[j - 1]
            same = ri.get("midi") is not None and ri.get("midi") == hj.get("midi")
            if dp[i][j] == dp[i - 1][j - 1] + (0 if same else 1):
                pairs.append((i - 1, j - 1))
                i, j = i - 1, j - 1
                continue
        if i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            pairs.append((i - 1, None))  # missed note
            i -= 1
            continue
        pairs.append((None, j - 1))  # spurious note
        j -= 1
    pairs.reverse()
    return pairs


def score_pair(ref: list[dict], hyp: list[dict]) -> dict:
    pairs = align(ref, hyp)
    tp = fp = fn = 0
    dur_hits = 0
    semitone_err = 0
    pitch_diffs: list[int] = []

    for ri, hi in pairs:
        if ri is not None and hi is not None:
            r, h = ref[ri], hyp[hi]
            if r.get("midi") is not None and r.get("midi") == h.get("midi"):
                tp += 1
                semitone_err += abs(r.get("midi", 0) - h.get("midi", 0))
                pitch_diffs.append(0)
                if abs(r.get("quarters", 0) - h.get("quarters", 0)) <= 0.01:
                    dur_hits += 1
            else:
                fp += 1
                fn += 1
                if r.get("midi") is not None and h.get("midi") is not None:
                    semitone_err += abs(r["midi"] - h["midi"])
                    pitch_diffs.append(abs(r["midi"] - h["midi"]))
        elif ri is not None:
            if ref[ri].get("midi") is not None:
                fn += 1
        elif hi is not None:
            if hyp[hi].get("midi") is not None:
                fp += 1

    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "ref_notes": sum(1 for r in ref if r.get("midi") is not None),
        "hyp_notes": sum(1 for h in hyp if h.get("midi") is not None),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "duration_acc": (dur_hits / tp) if tp else 0.0,
        "mean_pitch_err": (semitone_err / tp) if tp else None,
        "_dur_hits": dur_hits,
        "_semi_err": semitone_err,
        "pairs": pairs,
    }


# --------------------------------------------------------------------------
# Optional photo/scan degradation
# --------------------------------------------------------------------------
def degrade(src: Path, dst: Path, mode: str) -> None:
    """Write a photo-like version of the fixture before OCR."""
    if mode == "none":
        shutil.copy2(src, dst)
        return
    import cv2
    import numpy as np

    img = cv2.imread(str(src))
    if img is None:
        raise RuntimeError(f"cannot read {src}")
    h, w = img.shape[:2]

    if mode == "photo":
        # slight rotation off-axis, uneven lighting, sensor noise, JPEG mush
        angle = 1.4
        matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        img = cv2.warpAffine(img, matrix, (w, h), borderValue=(255, 255, 255))
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        shade = 1.0 - 0.22 * ((xx / w) ** 1.4)          # lighting gradient
        vign = 1.0 - 0.18 * (((xx - w / 2) ** 2 + (yy - h / 2) ** 2) / (w * h)) * 2.0
        img = np.clip(img.astype(np.float32) * (shade * vign)[..., None], 0, 255).astype(np.uint8)
        noise = np.random.default_rng(7).normal(0, 7, img.shape)
        img = np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)
        img = cv2.GaussianBlur(img, (3, 3), 0)
        cv2.imwrite(str(dst), img, [int(cv2.IMWRITE_JPEG_QUALITY), 62])

    elif mode == "scan":
        # grey photocopy look: low contrast, off-white paper, mild blur
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        # push everything toward the paper white so faint greys survive
        lo, hi = np.percentile(gray, [2, 98])
        gray = np.clip((gray.astype(np.float32) - lo) * (255.0 / max(hi - lo, 1)), 0, 255)
        gray = (gray * 0.78 + 255 * 0.22).astype(np.uint8)
        gray = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                     cv2.THRESH_BINARY, 31, 12)
        cv2.imwrite(str(dst), gray)

    elif mode == "book":
        # A phone photo of a spiral songbook: the page curls into the binding,
        # the shot is slightly off-axis, the binding shadows the inner edge,
        # a highlighter has been over some of the music, and the light is
        # warm and uneven. Modelled on a real rehearsal-book photo; each
        # ingredient is mild on its own, which is exactly what makes the
        # combination representative.
        rng = np.random.default_rng(11)

        # Page curl: columns displace vertically on a half-sine that is
        # strongest near the left (binding) edge.
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        curl = (np.sin(np.pi * (xx / w) * 0.5) - 1.0) * -0.018 * h  # 0 at right, ~1.8% at left
        map_y = np.clip(yy + curl, 0, h - 1)
        img = cv2.remap(img, xx, map_y, cv2.INTER_LINEAR, borderValue=(255, 255, 255))

        # Mild perspective: the camera is a little below-right of centre.
        src_pts = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst_pts = np.float32([[w * 0.015, h * 0.010], [w * 0.995, 0],
                              [w, h], [w * 0.005, h * 0.985]])
        img = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src_pts, dst_pts),
                                  (w, h), borderValue=(255, 255, 255))

        # Highlighter: translucent warm-pink bands across a few note regions,
        # the way a singer marks their line.
        overlay = img.copy()
        for i in range(3):
            y0 = int(h * (0.22 + 0.25 * i) + rng.integers(-10, 10))
            x0 = int(w * 0.12 + rng.integers(0, int(w * 0.1)))
            x1 = x0 + int(w * (0.25 + 0.15 * rng.random()))
            cv2.rectangle(overlay, (x0, y0), (min(x1, w - 4), y0 + int(h * 0.035)),
                          (193, 182, 255), -1)
        img = cv2.addWeighted(overlay, 0.38, img, 0.62, 0)

        # Binding shadow on the left, warm uneven light over the rest.
        shade = 1.0 - 0.30 * np.exp(-xx / (w * 0.08)) - 0.10 * ((xx / w) ** 2)
        img = np.clip(img.astype(np.float32) * shade[..., None], 0, 255)
        img[..., 0] *= 0.96   # slightly warm: pull blue down
        noise = rng.normal(0, 5, img.shape)
        img = np.clip(img + noise, 0, 255).astype(np.uint8)
        img = cv2.GaussianBlur(img, (3, 3), 0)
        cv2.imwrite(str(dst), img, [int(cv2.IMWRITE_JPEG_QUALITY), 70])

    else:
        raise ValueError(f"unknown degrade mode {mode!r}")


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------
def run_piece(piece: str, mode: str, tmp: Path) -> dict:
    from homr.main import ProcessingConfig, process_image
    from homr.music_xml_generator import XmlGeneratorArguments

    png = FIXTURES / f"{piece}.png"
    gt_file = FIXTURES / f"{piece}.gt.json"
    if not png.exists() or not gt_file.exists():
        return {"piece": piece, "error": "missing fixture (run tools/make-fixtures.mjs)"}

    work = tmp / f"{piece}_{mode}"
    work.mkdir(parents=True, exist_ok=True)
    work_png = work / f"{piece}.png"
    degrade(png, work_png, mode)

    cfg = ProcessingConfig(
        enable_debug=False,
        enable_cache=False,
        write_staff_positions=False,
        read_staff_positions=False,
        selected_staff=-1,
        transformer_use_gpu=False,   # CPU only -- no video card dependency
        segnet_use_gpu=False,
        coreml_encoder=False,
    )
    t0 = time.perf_counter()
    process_image(str(work_png), cfg, XmlGeneratorArguments())
    elapsed = time.perf_counter() - t0

    xml_path = work / f"{piece}.musicxml"
    if not xml_path.exists():
        return {"piece": piece, "mode": mode, "error": "homr produced no MusicXML", "seconds": elapsed}

    # The service repairs unmarked triplet runs before returning a score, so
    # the accuracy table must measure the repaired output -- the thing a user
    # actually receives -- not the engine's raw reading.
    from triplets import repair_triplets
    repaired, _rep = repair_triplets(xml_path.read_text(encoding="utf-8"))
    xml_path.write_text(repaired, encoding="utf-8")

    try:
        gt = read_ground_truth(gt_file)
    except ValueError as exc:
        return {"piece": piece, "mode": mode, "error": str(exc), "seconds": elapsed}
    hyp = read_musicxml_notes(xml_path)
    result = score_staves(gt, hyp)
    result.update({"piece": piece, "mode": mode, "seconds": elapsed})
    return result


def build_report(rows: list[dict]) -> dict:
    """Shape the results for /api/accuracy, with a headline number per condition."""
    by_mode: dict[str, dict] = {}
    for row in rows:
        if row.get("error") or not row.get("ref_notes"):
            continue
        agg = by_mode.setdefault(row["mode"], {"tp": 0, "fp": 0, "fn": 0, "notes": 0,
                                               "dur_hits": 0.0, "seconds": 0.0, "fixtures": 0})
        agg["tp"] += row["tp"]
        agg["fp"] += row["fp"]
        agg["fn"] += row["fn"]
        agg["notes"] += row["ref_notes"]
        agg["dur_hits"] += row["duration_acc"] * row["tp"]
        agg["seconds"] += row["seconds"]
        agg["fixtures"] += 1

    modes = {}
    for mode, a in by_mode.items():
        p = a["tp"] / (a["tp"] + a["fp"]) if (a["tp"] + a["fp"]) else 0.0
        r = a["tp"] / (a["tp"] + a["fn"]) if (a["tp"] + a["fn"]) else 0.0
        f1 = (2 * p * r / (p + r)) if (p + r) else 0.0
        modes[mode] = {
            "label": {"none": "printed score", "photo": "phone photo",
                      "scan": "photocopy scan",
                      "book": "spiral songbook photo (curl, shadow, highlighter)"}[mode],
            "fixtures": a["fixtures"],
            "notes": a["notes"],
            "tp": a["tp"], "fp": a["fp"], "fn": a["fn"],
            "precision": round(p * 100, 1),
            "recall": round(r * 100, 1),
            "f1": round(f1 * 100, 1),
            "durationAccuracy": round((a["dur_hits"] / a["tp"] * 100) if a["tp"] else 0.0, 1),
            "secondsPerPage": round(a["seconds"] / max(a["fixtures"], 1), 2),
        }

    return {
        "generatedBy": "tools/score_omr.py",
        "engine": "homr 0.7.0",
        "device": "cpu",
        "method": ("Known MusicXML is engraved to PNG, read back through optical music "
                   "recognition, then compared note for note against what was printed."),
        "caveat": ("Measured on printed test scores, including synthetically degraded ones. "
                   "Handwriting, curved book pages and very low contrast photographs are "
                   "harder and are not represented here."),
        "modes": modes,
        "summary": modes.get("none"),
        "rows": [{k: v for k, v in row.items() if k != "pairs"} for row in rows],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pieces", nargs="*", default=[])
    ap.add_argument("--degrade", default="none", choices=["none", "photo", "scan", "book"])
    ap.add_argument("--json", action="store_true", help="print the full report as JSON")
    ap.add_argument("--write", metavar="PATH",
                    help="write the JSON report to a file (used to publish /api/accuracy)")
    args = ap.parse_args()

    pieces = args.pieces or ["simple", "ode", "rhythm", "grand", "sharps"]
    os.environ.setdefault("PYTHONWARNINGS", "ignore")

    modes = ["none", "photo", "scan", "book"] if args.pieces == [] and args.degrade == "none" else [args.degrade]
    rows: list[dict] = []
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for mode in modes:
            for piece in pieces:
                r = run_piece(piece, mode, tmp)
                rows.append(r)
                if r.get("error"):
                    print(f"{piece:<8} [{mode:<5}] ERROR {r['error']}")
                    continue
                err = "n/a" if r["mean_pitch_err"] is None else f"{r['mean_pitch_err']:.2f}"
                print(
                    f"{piece:<8} [{mode:<5}] "
                    f"notes {r['ref_notes']:>3}->{r['hyp_notes']:<3} "
                    f"tp {r['tp']:>3} fp {r['fp']:>3} fn {r['fn']:>3}  "
                    f"P {r['precision']*100:5.1f}%  R {r['recall']*100:5.1f}%  F1 {r['f1']*100:5.1f}%  "
                    f"dur {r['duration_acc']*100:5.1f}%  err {err:>4}  {r['seconds']:.2f}s"
                )

            good = [r for r in rows if not r.get("error") and r["ref_notes"] and r["mode"] == mode]
            if not good:
                continue
            tp = sum(r["tp"] for r in good)
            fp = sum(r["fp"] for r in good)
            fn = sum(r["fn"] for r in good)
            p = tp / (tp + fp) if (tp + fp) else 0.0
            r_ = tp / (tp + fn) if (tp + fn) else 0.0
            f1 = (2 * p * r_ / (p + r_)) if (p + r_) else 0.0
            tot = sum(r["seconds"] for r in good)
            print("-" * 96)
            print(
                f"{'TOTAL':<8} [{mode:<5}] "
                f"notes {sum(r['ref_notes'] for r in good):>3}  tp {tp:>3} fp {fp:>3} fn {fn:>3}  "
                f"P {p*100:5.1f}%  R {r_*100:5.1f}%  F1 {f1*100:5.1f}%  ({tot:.1f}s total, "
                f"{tot/max(len(good),1):.2f}s avg)"
            )

    report = build_report(rows)
    if args.write:
        out = Path(args.write)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=1), encoding="utf-8")
        print(f"\nwrote {out}")
    if args.json:
        print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())