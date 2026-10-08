"""backend/preprocess.py -- page rasterisation and image conditioning for OMR.

Everything here is deliberately conservative. The recogniser already does its
own dewarping and its own resize, and the measurement suite shows it reads
engraved music correctly even from a photocopied, noise-degraded scan. So the
default variant list is "leave it alone plus a mild contrast lift", and the
extra transforms are offered as opt-in variants that the caller can rank.

The caller picks a winner by how many notes each variant yields -- we cannot
compute a confidence score, but note count is a usable proxy: a transform that
destroys staff lines reliably loses notes.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import List

import cv2
import numpy as np

# A staff smaller than this in pixels is genuinely hard to resolve; a page
# larger than this is mostly waste, because homr downsamples internally anyway.
MIN_PAGE_HEIGHT = 420
MAX_PAGE_DIMENSION = 3600


@dataclass
class Page:
    """One rasterised page ready for recognition."""

    index: int
    image: np.ndarray  # BGR uint8
    source: str  # "image" | "pdf"


@dataclass
class Variant:
    """A candidate rendering of a page, offered to the recogniser."""

    name: str
    image: np.ndarray
    report: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Decoding / rasterising
# ---------------------------------------------------------------------------
def decode_image(data: bytes) -> np.ndarray:
    """Decode an uploaded image to a BGR array, honouring EXIF orientation.

    Phone photos are routinely stored rotated with an orientation tag; ignoring
    it hands the recogniser a page lying on its side.
    """
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            rgb = np.array(im)
        if rgb.ndim == 2:
            return cv2.cvtColor(rgb, cv2.COLOR_GRAY2BGR)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    except Exception:
        # PIL is the primary path (it handles EXIF); OpenCV is the fallback.
        arr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if arr is None:
            raise ValueError("could not decode image; unsupported or corrupt file")
        return arr


def pdf_pages(data: bytes, dpi: int = 300, max_pages: int = 20) -> List[np.ndarray]:
    """Rasterise a PDF to one BGR array per page."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(io.BytesIO(data))
    try:
        count = len(pdf)
        if count == 0:
            raise ValueError("PDF contains no pages")
        scale = max(1.0, dpi / 72.0)
        out: List[np.ndarray] = []
        for i in range(min(count, max_pages)):
            bitmap = pdf[i].render(scale=scale)
            img = np.array(bitmap.to_pil().convert("RGB"))
            out.append(cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
        return out
    finally:
        pdf.close()


def looks_like_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


# ---------------------------------------------------------------------------
# Conditioning steps
# ---------------------------------------------------------------------------
def fit_page(img: np.ndarray) -> tuple[np.ndarray, dict]:
    """Bring the page into a sane resolution window for the recogniser."""
    info: dict = {}
    h, w = img.shape[:2]
    info["input"] = {"width": int(w), "height": int(h)}

    longest = max(h, w)
    if longest < MIN_PAGE_HEIGHT:
        factor = min(3.0, MIN_PAGE_HEIGHT / max(longest, 1))
        img = cv2.resize(img, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)
        info["upscale"] = round(factor, 2)
    elif longest > MAX_PAGE_DIMENSION:
        factor = MAX_PAGE_DIMENSION / longest
        img = cv2.resize(img, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
        info["downscale"] = round(factor, 2)

    info["output"] = {"width": int(img.shape[1]), "height": int(img.shape[0])}
    return img, info


def trim_border(img: np.ndarray, pad_ratio: float = 0.012, min_pad: int = 16) -> tuple[np.ndarray, dict]:
    """Crop surrounding blank paper, keeping a safety margin.

    Staff lines, braces and ledger lines all reach the edges of a tightly
    cropped system, so the pad is generous by design.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Any pixel darker than this counts as ink on paper.
    thresh = max(18, int(np.percentile(gray, 2)) + 12)
    ink = (gray < thresh).astype(np.uint8)
    if ink.sum() == 0:
        return img, {"trimmed": False}

    coords = cv2.findNonZero(ink)
    if coords is None:
        return img, {"trimmed": False}
    x, y, bw, bh = cv2.boundingRect(coords)
    h, w = gray.shape[:2]
    pad = max(min_pad, int(max(h, w) * pad_ratio))

    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(w, x + bw + pad), min(h, y + bh + pad)
    if (x1 - x0) >= w * 0.98 and (y1 - y0) >= h * 0.98:
        return img, {"trimmed": False, "reason": "page already fills frame"}

    return img[y0:y1, x0:x1].copy(), {
        "trimmed": True,
        "removed": {"left": int(x0), "top": int(y0),
                    "right": int(w - x1), "bottom": int(h - y1)},
    }


def enhance_contrast(img: np.ndarray) -> tuple[np.ndarray, dict]:
    """Local contrast lift for faint or unevenly lit photography."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    l = clahe.apply(l)
    out = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)
    return out, {"clahe": True}


def estimate_skew(img: np.ndarray, max_angle: float = 10.0) -> float:
    """Estimate page rotation in degrees from near-horizontal staff lines."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
    h, w = gray.shape[:2]
    # A system of music is often a small part of a photographed page, so keep
    # the run length well under the page width or the staff lines are missed.
    min_len = max(30, int(w * 0.08))
    # HoughLinesP, not HoughLines: OpenCV 5 dropped the minLineLength/maxLineGap
    # arguments from the standard transform, and these are probabilistic-only.
    segments = cv2.HoughLinesP(binary, 1, np.pi / 1800.0,
                               threshold=min_len, minLineLength=min_len, maxLineGap=6)
    if segments is None:
        return 0.0
    # OpenCV 4 returns (N, 1, 4) and OpenCV 5 returns (N, 4).
    segments = np.asarray(segments).reshape(-1, 4)
    angles = []
    for x1, y1, x2, y2 in segments:
        if abs(x2 - x1) < 1:
            continue
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(angle) <= max_angle:
            angles.append(angle)
    if not angles:
        return 0.0
    return float(np.median(angles))


def deskew(img: np.ndarray, max_angle: float = 10.0) -> tuple[np.ndarray, dict]:
    """Rotate the page upright. A no-op when the estimated skew is negligible."""
    angle = estimate_skew(img, max_angle)
    if abs(angle) < 0.05:
        return img, {"deskewed": False, "angle": round(angle, 3)}
    h, w = img.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(matrix[0, 0]), abs(matrix[0, 1])
    nw, nh = int((h * sin) + (w * cos)), int((h * cos) + (w * sin))
    matrix[0, 2] += (nw / 2) - w / 2
    matrix[1, 2] += (nh / 2) - h / 2
    out = cv2.warpAffine(img, matrix, (nw, nh), flags=cv2.INTER_CUBIC,
                         borderMode=cv2.BORDER_REPLICATE)
    return out, {"deskewed": True, "angle": round(angle, 3)}


def denoise(img: np.ndarray) -> tuple[np.ndarray, dict]:
    """Light sensor-noise removal that preserves thin staff lines."""
    out = cv2.fastNlMeansDenoisingColored(img, None, 4, 4, 7, 21)
    return out, {"denoised": True}


# ---------------------------------------------------------------------------
# Variant construction
# ---------------------------------------------------------------------------
def build_variants(page: Page, mode: str = "auto") -> List[Variant]:
    """Produce the candidate renderings the caller should try.

    mode:
      "original" -- size-normalised and nothing else
      "auto"     -- original, contrast-lifted, deskewed, and enhanced+deskewed
      "clean"    -- deskew + contrast + denoise (use for scans and photocopies)
    """
    base, size_info = fit_page(page.image)
    variants: List[Variant] = [Variant("original", base.copy(), {"steps": dict(size_info)})]

    if mode == "original":
        return variants

    enhanced, contrast_info = enhance_contrast(base)
    variants.append(Variant("contrast", enhanced.copy(),
                            {"steps": {**size_info, **contrast_info}}))

    straight, skew_info = deskew(base)
    variants.append(Variant("deskewed", straight.copy(),
                            {"steps": {**size_info, **skew_info}}))

    if mode == "clean":
        clean, denoise_info = denoise(enhanced)
        clean, skew2 = deskew(clean)
        variants.append(Variant("clean", clean.copy(),
                                {"steps": {**size_info, **contrast_info, **denoise_info, **skew2}}))
        return variants

    if mode == "auto":
        both, contrast2 = enhance_contrast(straight)
        variants.append(Variant("deskew+contrast", both.copy(),
                                {"steps": {**size_info, **skew_info, **contrast2}}))
    return variants


def load_pages(data: bytes, filename: str, pdf_dpi: int = 300,
               max_pages: int = 20) -> List[Page]:
    """Turn an uploaded file into one or more rasterised pages."""
    if looks_like_pdf(data) or filename.lower().endswith(".pdf"):
        pages = pdf_pages(data, dpi=pdf_dpi, max_pages=max_pages)
        return [Page(i, img, "pdf") for i, img in enumerate(pages)]
    return [Page(0, decode_image(data), "image")]


def encode_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise ValueError("could not encode preview")
    return buf.tobytes()