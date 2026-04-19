"""
OMR processing engine for the exam-scanner project.

The ES-50 can return a scan canvas larger than the physical half-A4 answer
sheet, so every sheet is first normalized to a canonical 300 DPI A5-sized
coordinate space before OMR reading.
"""

from __future__ import annotations

import base64
import io
import json
import logging
from itertools import combinations
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import cv2
    import numpy as np
    from PIL import Image
    _CV2_AVAILABLE = True
except ImportError:
    _CV2_AVAILABLE = False

try:
    import requests as _requests
    _REQUESTS_AVAILABLE = True
except ImportError:
    _REQUESTS_AVAILABLE = False

logger = logging.getLogger(__name__)

# Canonical half-A4 sheet geometry: 14.85 cm x 21.0 cm at 300 DPI.
SCAN_DPI = 300
PAPER_W_CM = 14.85
PAPER_H_CM = 21.0
CANON_W = round(PAPER_W_CM / 2.54 * SCAN_DPI)
CANON_H = round(PAPER_H_CM / 2.54 * SCAN_DPI)

# Typical full ES-50 WIA output observed during debugging.
SCAN_W = 2550
SCAN_H = 4200

FILL_THRESHOLD = 0.28
DIGIT_MIN_RATIO = 0.35
DIGIT_MIN_GAP = 0.10
DIGIT_LOW_CONFIDENCE_GAP = 0.06
SAVE_DEBUG_IMAGE = True
TEMPLATE_VERSION = "A5_TEMPLATE_V1"
TEMPLATE_DIR = Path(__file__).resolve().parent / "templates"
TEMPLATE_PROFILE_PATH = TEMPLATE_DIR / "a5_template_v1.json"
TEMPLATE_REFERENCE_PATH = TEMPLATE_DIR / "a5_template_v1.png"

# Solid corner registration marks should be larger than filled answer bubbles.
REG_MARK_MIN_AREA = 3200
REG_MARK_MIN_SIDE = 45
REG_MARK_MAX_SIDE = 170

# Bubble coordinates measured from blank-template calibration (calibrate_template.py).
# x_centers / y_centers take precedence over origin_center + pitch in _bubble_center().
STUDENT_CODE_GRID: dict[str, Any] = {
    "x_centers": [271.82, 360.17, 449.38, 545.57, 634.04, 722.88],
    "y_centers": [336.07, 396.39, 456.14, 515.38, 575.08, 635.2,
                  695.02, 754.78, 813.28, 872.39],
    "y_origin": 336.07,
    "cols": 6,
    "rows": 10,
    "y_pitch": 59.752,
    "bubble_radius": 18,
}

EXAM_CODE_GRID: dict[str, Any] = {
    "x_centers": [1030.62, 1119.55, 1208.06, 1303.96, 1392.16, 1481.01],
    "y_centers": [335.57, 395.18, 454.93, 514.22, 573.53, 632.95,
                  692.42, 752.12, 810.49, 869.28],
    "y_origin": 335.57,
    "cols": 6,
    "rows": 10,
    "y_pitch": 59.42,
    "bubble_radius": 18,
}

ANSWER_GRID_LEFT: dict[str, Any] = {
    "origin_center": (473, 1047),
    "x_centers": [473.35, 551.06, 629.15, 707.21],
    "y_centers": [1046.71, 1137.48, 1226.14, 1316.73, 1407.61, 1497.08,
                  1582.9, 1671.53, 1756.31, 1843.3, 1928.09, 2010.9,
                  2097.3, 2185.77, 2268.1],
    "y_origin": 1046.71,
    "rows": 15,
    "cols": 4,
    "x_pitch": 78.052,
    "y_pitch": 87.727,
    "bubble_radius": 22,
}

# answers_right A-column forced to uniform 78 px pitch from D=1374.81.
ANSWER_GRID_RIGHT: dict[str, Any] = {
    "origin_center": (1141, 1043),
    "x_centers": [1140.81, 1218.81, 1296.81, 1374.81],
    "y_centers": [1043.45, 1131.73, 1222.6, 1313.13, 1403.75, 1492.13,
                  1579.28, 1665.95, 1752.87, 1837.87, 1924.46, 2006.69,
                  2093.73, 2180.46, 2264.8],
    "y_origin": 1043.45,
    "rows": 15,
    "cols": 4,
    "x_pitch": 78.0,
    "y_pitch": 86.976,
    "bubble_radius": 22,
}

ANSWER_LETTERS = ["A", "B", "C", "D"]

SECTION_SPECS: dict[str, dict[str, Any]] = {
    "student_code": {
        "base_grid": STUDENT_CODE_GRID,
        "roi": (170, 300, 830, 940),
        "min_area": 120,
        "max_area": 2800,
        "min_side": 18,
        "max_side": 90,
        "x_gap": 35,
        "y_gap": 28,
        "x_pitch_range": (65, 125),
        "y_pitch_range": (45, 75),
        "min_coverage": 0.70,
        "failure_flag": "STUDENT_CODE_REGISTRATION_FAILED",
    },
    "exam_code": {
        "base_grid": EXAM_CODE_GRID,
        "roi": (900, 300, 1680, 940),
        "min_area": 120,
        "max_area": 2800,
        "min_side": 18,
        "max_side": 90,
        "x_gap": 35,
        "y_gap": 28,
        "x_pitch_range": (65, 125),
        "y_pitch_range": (45, 75),
        "min_coverage": 0.65,
        "failure_flag": "EXAM_CODE_REGISTRATION_FAILED",
    },
    "answers_left": {
        "base_grid": ANSWER_GRID_LEFT,
        "roi": (420, 980, 820, 2350),
        "min_area": 120,
        "max_area": 2800,
        "min_side": 18,
        "max_side": 95,
        "x_gap": 35,
        "y_gap": 42,
        "x_pitch_range": (55, 105),
        "y_pitch_range": (70, 105),
        "min_coverage": 0.65,
        "failure_flag": "ANSWER_GRID_REGISTRATION_FAILED",
    },
    "answers_right": {
        "base_grid": ANSWER_GRID_RIGHT,
        "roi": (1090, 970, 1560, 2380),
        "min_area": 120,
        "max_area": 2800,
        "min_side": 18,
        "max_side": 95,
        "x_gap": 35,
        "y_gap": 42,
        "x_pitch_range": (55, 105),
        "y_pitch_range": (70, 105),
        "min_coverage": 0.65,
        "failure_flag": "ANSWER_GRID_REGISTRATION_FAILED",
    },
}

_TEMPLATE_PROFILE_CACHE: dict[str, Any] | None = None


class UnreadableSheetError(RuntimeError):
    """Raised when registration marks cannot be trusted."""


class SectionRegistrationError(RuntimeError):
    """Raised when an individual OMR section cannot be aligned."""


def preprocess(pil_image: "Image.Image") -> "np.ndarray":
    """Convert a raw scan into an inverted binary image, where dark ink is white."""
    img = np.array(pil_image.convert("L"))
    blurred = cv2.GaussianBlur(img, (3, 3), 0)
    _, binary = cv2.threshold(
        blurred,
        0,
        255,
        cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    return cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)


def _find_registration_marks(
    binary: "np.ndarray",
    min_area: int = REG_MARK_MIN_AREA,
    min_side: int = REG_MARK_MIN_SIDE,
) -> list[dict[str, Any]]:
    """Return solid square registration mark candidates."""
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    marks: list[dict[str, Any]] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue

        x, y, w, h = cv2.boundingRect(cnt)
        if w < min_side or h < min_side:
            continue
        if w > REG_MARK_MAX_SIDE or h > REG_MARK_MAX_SIDE:
            continue

        aspect = w / h if h > 0 else 0
        fill_ratio = area / (w * h) if w > 0 and h > 0 else 0
        if not (0.7 <= aspect <= 1.3 and fill_ratio >= 0.55):
            continue

        cx = x + w / 2
        cy = y + h / 2
        marks.append({
            "center": (float(cx), float(cy)),
            "bbox": (int(x), int(y), int(w), int(h)),
            "area": float(area),
            "fill_ratio": float(fill_ratio),
        })
    return marks


def _choose_registration_corners(
    marks: list[dict[str, Any]],
) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float], tuple[float, float]]:
    if len(marks) < 4:
        raise UnreadableSheetError(
            f"REGISTRATION_MARKS_MISSING: only {len(marks)} mark(s) found; need 4."
        )

    centres = [m["center"] for m in marks]
    tl = min(centres, key=lambda p: p[0] + p[1])
    tr = max(centres, key=lambda p: p[0] - p[1])
    br = max(centres, key=lambda p: p[0] + p[1])
    bl = min(centres, key=lambda p: p[0] - p[1])
    corners = (tl, tr, br, bl)

    if len({(round(x, 1), round(y, 1)) for x, y in corners}) < 4:
        raise UnreadableSheetError("REGISTRATION_MARKS_AMBIGUOUS")

    top_w = float(np.linalg.norm(np.array(tr) - np.array(tl)))
    bot_w = float(np.linalg.norm(np.array(br) - np.array(bl)))
    left_h = float(np.linalg.norm(np.array(bl) - np.array(tl)))
    right_h = float(np.linalg.norm(np.array(br) - np.array(tr)))
    avg_w = (top_w + bot_w) / 2
    avg_h = (left_h + right_h) / 2

    if avg_w < CANON_W * 0.45 or avg_h < CANON_H * 0.45:
        raise UnreadableSheetError("REGISTRATION_MARKS_TOO_CLOSE")

    aspect = avg_w / avg_h if avg_h else 0
    if not (0.45 <= aspect <= 0.95):
        raise UnreadableSheetError(f"REGISTRATION_MARKS_BAD_ASPECT:{aspect:.2f}")

    return corners


def _grid_x_centers(grid: dict[str, Any]) -> list[float]:
    cols = int(grid["cols"])
    if "x_centers" in grid:
        return [float(v) for v in grid["x_centers"][:cols]]
    ox, _ = grid["origin_center"]
    return [float(ox + col * grid["x_pitch"]) for col in range(cols)]


def _grid_y_centers(grid: dict[str, Any]) -> list[float]:
    rows = int(grid["rows"])
    if "y_centers" in grid:
        return [float(v) for v in grid["y_centers"][:rows]]
    if "origin_center" in grid:
        _, oy = grid["origin_center"]
    else:
        oy = grid["y_origin"]
    return [float(oy + row * grid["y_pitch"]) for row in range(rows)]


def _json_safe_grid(grid: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in grid.items():
        if isinstance(value, tuple):
            safe[key] = list(value)
        elif isinstance(value, list):
            safe[key] = [float(v) if isinstance(v, (float, int)) else v for v in value]
        elif isinstance(value, (float, int, str, bool)) or value is None:
            safe[key] = value
    return safe


def load_template_profile(include_image: bool = True) -> dict[str, Any]:
    """Load the optional calibrated blank-template profile."""
    global _TEMPLATE_PROFILE_CACHE
    if _TEMPLATE_PROFILE_CACHE is not None:
        if include_image and "_blank_reference" not in _TEMPLATE_PROFILE_CACHE and TEMPLATE_REFERENCE_PATH.exists():
            try:
                reference = cv2.imread(str(TEMPLATE_REFERENCE_PATH), cv2.IMREAD_GRAYSCALE)
                if reference is not None and reference.shape[:2] == (CANON_H, CANON_W):
                    _TEMPLATE_PROFILE_CACHE["_blank_reference"] = reference
                    _TEMPLATE_PROFILE_CACHE["blank_reference_loaded"] = True
            except Exception as exc:
                logger.warning("Could not load OMR blank reference image: %s", exc)
        return _TEMPLATE_PROFILE_CACHE

    profile: dict[str, Any] = {
        "template_version": TEMPLATE_VERSION,
        "canonical_size": [CANON_W, CANON_H],
        "anchors": [],
        "sections": {},
        "profile_loaded": False,
    }

    if TEMPLATE_PROFILE_PATH.exists():
        try:
            loaded = json.loads(TEMPLATE_PROFILE_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                profile.update(loaded)
                profile["profile_loaded"] = True
        except Exception as exc:
            logger.warning("Could not load OMR template profile: %s", exc)

    if include_image and TEMPLATE_REFERENCE_PATH.exists():
        try:
            reference = cv2.imread(str(TEMPLATE_REFERENCE_PATH), cv2.IMREAD_GRAYSCALE)
            if reference is not None and reference.shape[:2] == (CANON_H, CANON_W):
                profile["_blank_reference"] = reference
                profile["blank_reference_loaded"] = True
            else:
                profile["blank_reference_loaded"] = False
        except Exception as exc:
            logger.warning("Could not load OMR blank reference image: %s", exc)
            profile["blank_reference_loaded"] = False
    else:
        profile["blank_reference_loaded"] = False

    _TEMPLATE_PROFILE_CACHE = profile
    return profile


def detect_page_anchors(binary: "np.ndarray") -> list[dict[str, Any]]:
    """Detect the existing solid square anchors on a raw or normalized sheet."""
    return _find_registration_marks(binary)


def match_template_anchors(
    detected_anchors: list[dict[str, Any]],
    template_anchors: list[dict[str, Any]],
    max_distance: float = 120.0,
) -> list[dict[str, Any]]:
    """Greedily match detected page anchors to calibrated template anchors."""
    matches: list[dict[str, Any]] = []
    used: set[int] = set()
    for index, anchor in enumerate(template_anchors):
        target = anchor.get("center")
        if not isinstance(target, list | tuple) or len(target) != 2:
            continue
        tx, ty = float(target[0]), float(target[1])
        best_idx: int | None = None
        best_dist = float("inf")
        for det_idx, detected in enumerate(detected_anchors):
            if det_idx in used:
                continue
            dx, dy = detected["center"]
            dist = float(np.hypot(float(dx) - tx, float(dy) - ty))
            if dist < best_dist:
                best_dist = dist
                best_idx = det_idx
        if best_idx is None or best_dist > max_distance:
            continue
        used.add(best_idx)
        detected = detected_anchors[best_idx]
        matches.append({
            "template_index": index,
            "template_center": [round(tx, 2), round(ty, 2)],
            "detected_center": [
                round(float(detected["center"][0]), 2),
                round(float(detected["center"][1]), 2),
            ],
            "distance": round(best_dist, 2),
        })
    return matches


def _apply_template_anchor_correction(
    normalized: "np.ndarray",
    profile: dict[str, Any],
) -> tuple["np.ndarray", dict[str, Any]]:
    template_anchors = profile.get("anchors") or []
    if not template_anchors:
        return normalized, {
            "template_version": profile.get("template_version", TEMPLATE_VERSION),
            "template_profile_loaded": bool(profile.get("profile_loaded")),
            "page_registration_method": "four_corner_marks",
            "page_registration_confidence": None,
            "anchor_matches": [],
        }

    detected = detect_page_anchors(normalized)
    matches = match_template_anchors(detected, template_anchors)
    if len(matches) < 4:
        raise UnreadableSheetError(
            f"TEMPLATE_ANCHORS_MISSING: matched {len(matches)} anchor(s); need 4."
        )

    src = np.float32([m["detected_center"] for m in matches])
    dst = np.float32([m["template_center"] for m in matches])
    matrix, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 8.0)
    if matrix is None or inliers is None or int(inliers.sum()) < 4:
        raise UnreadableSheetError("TEMPLATE_ANCHORS_BAD_HOMOGRAPHY")

    inlier_count = int(inliers.sum())
    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst, axis=1)
    inlier_errors = errors[inliers.ravel() == 1]
    mean_error = float(np.mean(inlier_errors)) if len(inlier_errors) else float("inf")
    confidence = inlier_count / max(1, len(template_anchors))
    if confidence < 0.55 or mean_error > 30.0:
        raise UnreadableSheetError(
            f"TEMPLATE_ANCHORS_LOW_CONFIDENCE:{confidence:.2f}:{mean_error:.1f}"
        )

    corrected = cv2.warpPerspective(
        normalized,
        matrix,
        (CANON_W, CANON_H),
        flags=cv2.INTER_NEAREST,
        borderValue=0,
    )
    debug = {
        "template_version": profile.get("template_version", TEMPLATE_VERSION),
        "template_profile_loaded": bool(profile.get("profile_loaded")),
        "page_registration_method": "template_anchor_homography",
        "page_registration_confidence": round(confidence, 4),
        "page_registration_mean_error": round(mean_error, 3),
        "anchor_matches": matches,
    }
    return corrected, debug


def _apply_raw_template_anchor_normalization(
    binary: "np.ndarray",
    marks: list[dict[str, Any]],
    profile: dict[str, Any],
) -> tuple["np.ndarray | None", dict[str, Any]]:
    raw_anchors = profile.get("raw_anchors") or []
    raw_size = profile.get("raw_size") or []
    if not raw_anchors or raw_size != [int(binary.shape[1]), int(binary.shape[0])]:
        return None, {}

    matches = match_template_anchors(marks, raw_anchors, max_distance=140.0)
    if len(matches) < 4:
        raise UnreadableSheetError(
            f"TEMPLATE_RAW_ANCHORS_MISSING: matched {len(matches)} anchor(s); need 4."
        )

    src = np.float32([m["detected_center"] for m in matches])
    dst = np.float32([m["template_center"] for m in matches])
    matrix, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 8.0)
    if matrix is None or inliers is None or int(inliers.sum()) < 4:
        raise UnreadableSheetError("TEMPLATE_RAW_ANCHORS_BAD_HOMOGRAPHY")

    inlier_count = int(inliers.sum())
    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst, axis=1)
    inlier_errors = errors[inliers.ravel() == 1]
    mean_error = float(np.mean(inlier_errors)) if len(inlier_errors) else float("inf")
    confidence = inlier_count / max(1, len(raw_anchors))
    if confidence < 0.55 or mean_error > 30.0:
        raise UnreadableSheetError(
            f"TEMPLATE_RAW_ANCHORS_LOW_CONFIDENCE:{confidence:.2f}:{mean_error:.1f}"
        )

    normalized = cv2.warpPerspective(
        binary,
        matrix,
        (CANON_W, CANON_H),
        flags=cv2.INTER_NEAREST,
        borderValue=0,
    )
    debug = {
        "template_version": profile.get("template_version", TEMPLATE_VERSION),
        "template_profile_loaded": bool(profile.get("profile_loaded")),
        "page_registration_method": "raw_template_anchor_homography",
        "page_registration_confidence": round(confidence, 4),
        "page_registration_mean_error": round(mean_error, 3),
        "anchor_matches": matches,
    }
    return normalized, debug


def normalize_scan(
    binary: "np.ndarray",
    use_template_profile: bool = True,
) -> tuple["np.ndarray", dict[str, Any]]:
    """Warp any ES-50 output into the canonical half-A4 OMR coordinate space."""
    reg_method = "standard"
    marks = _find_registration_marks(binary)

    # Fallback A: relax size/area filter for lower-contrast or small-mark scans.
    if len(marks) < 4:
        marks = _find_registration_marks(binary, min_area=1920, min_side=28)
        if len(marks) >= 4:
            reg_method = "relaxed_size"

    profile = load_template_profile(include_image=False) if use_template_profile else {}

    debug_base = {
        "canonical_size": [CANON_W, CANON_H],
        "raw_size": [int(binary.shape[1]), int(binary.shape[0])],
        "registration_mark_method": reg_method,
        "mark_candidates": [
            {
                "center": [round(m["center"][0], 2), round(m["center"][1], 2)],
                "bbox": list(m["bbox"]),
                "area": round(m["area"], 2),
                "fill_ratio": round(m["fill_ratio"], 3),
            }
            for m in marks
        ],
    }

    # PRIMARY PATH: raw template anchor homography.
    # Works whenever the scan pixel size matches the blank calibration scan
    # (always true for WIA @ 300 DPI -> 1754x2480).  Robust against partial
    # mark detection because any >=4 matched anchors suffice.
    if use_template_profile and len(marks) >= 1:
        try:
            raw_normalized, raw_profile_debug = _apply_raw_template_anchor_normalization(
                binary, marks, profile,
            )
            if raw_normalized is not None:
                debug_base["registration_mark_method"] = "raw_template_anchor_homography"
                debug_base.update(raw_profile_debug)
                return raw_normalized, debug_base
        except UnreadableSheetError:
            pass  # fall through to four-corner path

    # SECONDARY PATH: classic four-corner perspective transform.
    # Fallback B: if < 4 marks, substitute template raw anchor positions.
    if len(marks) < 4 and use_template_profile:
        raw_anchors = profile.get("raw_anchors", [])
        if len(raw_anchors) >= 4:
            marks = [
                {
                    "center": (float(a["center"][0]), float(a["center"][1])),
                    "bbox": tuple(int(v) for v in a["bbox"]),
                    "area": float(a["area"]),
                    "fill_ratio": float(a["fill_ratio"]),
                }
                for a in raw_anchors
            ]
            reg_method = "template_raw_anchors"

    tl, tr, br, bl = _choose_registration_corners(marks)

    debug_base["registration_mark_method"] = reg_method
    debug_base["corner_centers"] = {
        "tl": [round(tl[0], 2), round(tl[1], 2)],
        "tr": [round(tr[0], 2), round(tr[1], 2)],
        "br": [round(br[0], 2), round(br[1], 2)],
        "bl": [round(bl[0], 2), round(bl[1], 2)],
    }

    src = np.float32([tl, tr, br, bl])
    dst = np.float32([
        [0, 0],
        [CANON_W - 1, 0],
        [CANON_W - 1, CANON_H - 1],
        [0, CANON_H - 1],
    ])
    matrix = cv2.getPerspectiveTransform(src, dst)
    normalized = cv2.warpPerspective(
        binary,
        matrix,
        (CANON_W, CANON_H),
        flags=cv2.INTER_NEAREST,
        borderValue=0,
    )

    if use_template_profile:
        normalized, profile_debug = _apply_template_anchor_correction(normalized, profile)
        debug_base.update(profile_debug)
    else:
        debug_base.update({
            "template_version": TEMPLATE_VERSION,
            "template_profile_loaded": False,
            "page_registration_method": "four_corner_marks",
            "page_registration_confidence": None,
            "anchor_matches": [],
        })
    return normalized, debug_base


def warp_to_canvas(pil_image: "Image.Image", binary: "np.ndarray") -> "np.ndarray":
    """Backward-compatible wrapper around canonical normalization."""
    normalized, _ = normalize_scan(binary)
    return normalized


def _bubble_center(grid: dict[str, Any], col: int, row: int) -> tuple[int, int]:
    if "x_centers" in grid:
        cx = int(round(grid["x_centers"][col]))
        oy = grid["y_origin"]
    else:
        ox, oy = grid["origin_center"]
        cx = int(round(ox + col * grid["x_pitch"]))
    if "y_centers" in grid:
        cy = int(round(grid["y_centers"][row]))
    else:
        cy = int(round(oy + row * grid["y_pitch"]))
    return cx, cy


def _bubble_fill_ratio(warped: "np.ndarray", cx: int, cy: int, radius: int) -> float:
    x1 = max(0, cx - radius)
    y1 = max(0, cy - radius)
    x2 = min(warped.shape[1], cx + radius + 1)
    y2 = min(warped.shape[0], cy + radius + 1)
    if x1 >= x2 or y1 >= y2:
        return 0.0

    crop = warped[y1:y2, x1:x2]
    yy, xx = np.ogrid[y1:y2, x1:x2]
    mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius ** 2
    total = int(np.sum(mask))
    if total == 0:
        return 0.0

    filled = int(np.sum(crop[mask] > 127))
    return filled / total


def blank_corrected_fill_ratio(
    warped: "np.ndarray",
    blank_reference: "np.ndarray | None",
    cx: int,
    cy: int,
    radius: int,
) -> float:
    """Return fill ratio after subtracting the aligned blank template, if present."""
    if blank_reference is None:
        return _bubble_fill_ratio(warped, cx, cy, radius)

    x1 = max(0, cx - radius)
    y1 = max(0, cy - radius)
    x2 = min(warped.shape[1], cx + radius + 1)
    y2 = min(warped.shape[0], cy + radius + 1)
    if x1 >= x2 or y1 >= y2:
        return 0.0

    crop = warped[y1:y2, x1:x2] > 127
    blank_crop = blank_reference[y1:y2, x1:x2] > 127
    blank_crop = cv2.dilate(
        blank_crop.astype("uint8"),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    ) > 0

    yy, xx = np.ogrid[y1:y2, x1:x2]
    mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius ** 2
    total = int(np.sum(mask))
    if total == 0:
        return 0.0

    filled = int(np.sum(crop & ~blank_crop & mask))
    return filled / total


def read_digit_grid(
    warped: "np.ndarray",
    grid: dict[str, Any],
    flags: list[str],
    debug_samples: list[dict[str, Any]] | None = None,
    digit_decisions: list[dict[str, Any]] | None = None,
    name: str = "digit_grid",
    flag_prefix: str = "DIGIT_GRID",
    blank_reference: "np.ndarray | None" = None,
) -> list[int | None]:
    """Read a digit grid by accepting the strongest bubble in each column."""
    cols = int(grid["cols"])
    rows = int(grid["rows"])
    radius = int(grid["bubble_radius"])

    result: list[int | None] = []
    for col in range(cols):
        ratios: list[tuple[int, float, tuple[int, int]]] = []
        for row in range(rows):
            cx, cy = _bubble_center(grid, col, row)
            ratio = blank_corrected_fill_ratio(warped, blank_reference, cx, cy, radius)
            ratios.append((row, ratio, (cx, cy)))

        ranked = sorted(ratios, key=lambda item: item[1], reverse=True)
        best_digit, best_ratio, best_center = ranked[0]
        second_digit, second_ratio, _ = ranked[1] if len(ranked) > 1 else (None, 0.0, (0, 0))
        gap = best_ratio - second_ratio
        accepted = best_ratio >= DIGIT_MIN_RATIO and gap >= DIGIT_LOW_CONFIDENCE_GAP
        low_confidence = accepted and gap < DIGIT_MIN_GAP
        reason = "accepted"

        if best_ratio < DIGIT_MIN_RATIO:
            accepted = False
            reason = "below_min_ratio"
        elif gap < DIGIT_LOW_CONFIDENCE_GAP:
            accepted = False
            reason = "ambiguous"
        elif low_confidence:
            flag = f"LOW_CONFIDENCE_{flag_prefix}_COL_{col + 1}"
            flags.append(flag)
            reason = "low_confidence"

        selected_digit = best_digit if accepted else None
        result.append(selected_digit)

        decision = {
            "group": name,
            "col": col,
            "best_digit": best_digit,
            "best_ratio": round(best_ratio, 4),
            "second_digit": second_digit,
            "second_ratio": round(second_ratio, 4),
            "gap": round(gap, 4),
            "accepted": accepted,
            "low_confidence": low_confidence,
            "reason": reason,
            "center": [int(best_center[0]), int(best_center[1])],
        }
        if digit_decisions is not None:
            digit_decisions.append(decision)

        for row, ratio, (cx, cy) in ratios:
            is_best = row == best_digit
            if debug_samples is not None:
                debug_samples.append({
                    "group": name,
                    "col": col,
                    "row": row,
                    "digit": row,
                    "center": [cx, cy],
                    "radius": radius,
                    "ratio": round(ratio, 4),
                    "above_fill_threshold": ratio > FILL_THRESHOLD,
                    "best_candidate": is_best,
                    "filled": accepted and is_best,
                    "ratio_method": "blank_corrected" if blank_reference is not None else "raw",
                })

    return result


def read_answer_grid(
    warped: "np.ndarray",
    grid: dict[str, Any],
    start_item: int,
    flags: list[str],
    debug_samples: list[dict[str, Any]] | None = None,
    name: str = "answer_grid",
    max_item: int | None = None,
    blank_reference: "np.ndarray | None" = None,
) -> list[str | None]:
    """Read an answer grid from circular bubble-centre samples."""
    rows = int(grid["rows"])
    radius = int(grid["bubble_radius"])

    answers: list[str | None] = []
    for row in range(rows):
        item_num = start_item + row
        filled_cols = []
        for col in range(4):
            cx, cy = _bubble_center(grid, col, row)
            ratio = blank_corrected_fill_ratio(warped, blank_reference, cx, cy, radius)
            is_filled = ratio > FILL_THRESHOLD
            if debug_samples is not None:
                debug_samples.append({
                    "group": name,
                    "item": item_num,
                    "col": col,
                    "letter": ANSWER_LETTERS[col],
                    "center": [cx, cy],
                    "radius": radius,
                    "ratio": round(ratio, 4),
                    "filled": is_filled,
                    "ratio_method": "blank_corrected" if blank_reference is not None else "raw",
                })
            if is_filled:
                filled_cols.append(col)

        if len(filled_cols) == 1:
            answers.append(ANSWER_LETTERS[filled_cols[0]])
        elif len(filled_cols) == 0:
            if max_item is None or item_num <= max_item:
                flags.append(f"NO_ANSWER_Q{item_num}")
            answers.append(None)
        else:
            if max_item is None or item_num <= max_item:
                flags.append(f"DOUBLE_MARK_Q{item_num}")
            answers.append(None)

    return answers


def _component_candidates(
    binary: "np.ndarray",
    spec: dict[str, Any],
) -> list[dict[str, Any]]:
    x1, y1, x2, y2 = [int(v) for v in spec["roi"]]
    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(binary.shape[1], x2)
    y2 = min(binary.shape[0], y2)
    if x1 >= x2 or y1 >= y2:
        return []

    crop = (binary[y1:y2, x1:x2] > 127).astype("uint8")
    num, _, stats, centroids = cv2.connectedComponentsWithStats(crop, 8)
    candidates: list[dict[str, Any]] = []
    for idx in range(1, num):
        x, y, w, h, area = [int(v) for v in stats[idx]]
        if not (int(spec["min_area"]) <= area <= int(spec["max_area"])):
            continue
        if not (int(spec["min_side"]) <= w <= int(spec["max_side"])):
            continue
        if not (int(spec["min_side"]) <= h <= int(spec["max_side"])):
            continue
        aspect = w / h if h else 0.0
        if not (0.45 <= aspect <= 1.8):
            continue
        cx = float(centroids[idx][0] + x1)
        cy = float(centroids[idx][1] + y1)
        candidates.append({
            "center": [cx, cy],
            "bbox": [x + x1, y + y1, w, h],
            "area": area,
            "aspect": round(aspect, 3),
        })
    return candidates


def _cluster_values(values: list[float], gap: float) -> list[dict[str, Any]]:
    groups: list[list[float]] = []
    for value in sorted(values):
        if not groups or abs(value - float(np.median(groups[-1]))) > gap:
            groups.append([value])
        else:
            groups[-1].append(value)
    return [
        {
            "center": float(np.median(group)),
            "count": len(group),
            "spread": float(max(group) - min(group)) if len(group) > 1 else 0.0,
        }
        for group in groups
    ]


def _select_axis_clusters(
    clusters: list[dict[str, Any]],
    expected_count: int,
    pitch_range: tuple[float, float],
    base_values: list[float],
) -> list[dict[str, Any]]:
    if len(clusters) < expected_count:
        raise SectionRegistrationError(
            f"only {len(clusters)} axis cluster(s); need {expected_count}"
        )

    best_combo: tuple[dict[str, Any], ...] | None = None
    best_score = float("inf")
    for combo in combinations(clusters, expected_count):
        ordered = tuple(sorted(combo, key=lambda item: float(item["center"])))
        centers = np.array([float(item["center"]) for item in ordered], dtype=np.float32)
        diffs = np.diff(centers)
        if len(diffs) == 0:
            continue
        pitch = float(np.median(diffs))
        if pitch < pitch_range[0] or pitch > pitch_range[1]:
            continue
        uniformity = float(np.std(diffs))
        rmse = 0.0
        if len(base_values) == expected_count:
            base = np.array(base_values, dtype=np.float32)
            design = np.vstack([base, np.ones(len(base))]).T
            scale, offset = np.linalg.lstsq(design, centers, rcond=None)[0]
            predicted = base * scale + offset
            rmse = float(np.sqrt(np.mean((centers - predicted) ** 2)))
        count_bonus = sum(int(item["count"]) for item in ordered) / expected_count
        score = rmse + uniformity * 0.5 - count_bonus * 0.12
        if score < best_score:
            best_score = score
            best_combo = ordered

    if best_combo is None:
        raise SectionRegistrationError("axis clusters do not match expected pitch")
    return list(best_combo)


def _profile_section_grid(
    profile: dict[str, Any] | None,
    section_name: str,
) -> dict[str, Any]:
    spec = SECTION_SPECS[section_name]
    grid = dict(spec["base_grid"])
    section = (profile or {}).get("sections", {}).get(section_name)
    if isinstance(section, dict):
        for key in ("x_centers", "y_centers", "y_origin", "x_pitch", "y_pitch", "bubble_radius"):
            if key in section:
                grid[key] = section[key]
    return grid


def _nearest_index(values: list[float], value: float) -> int:
    return min(range(len(values)), key=lambda index: abs(values[index] - value))


def _section_coverage(
    candidates: list[dict[str, Any]],
    x_centers: list[float],
    y_centers: list[float],
    spec: dict[str, Any],
) -> float:
    cells: set[tuple[int, int]] = set()
    max_dx = max(18.0, float(spec["x_gap"]))
    max_dy = max(18.0, float(spec["y_gap"]))
    for candidate in candidates:
        cx, cy = [float(v) for v in candidate["center"]]
        col = _nearest_index(x_centers, cx)
        row = _nearest_index(y_centers, cy)
        if abs(cx - x_centers[col]) <= max_dx and abs(cy - y_centers[row]) <= max_dy:
            cells.add((col, row))
    expected = max(1, len(x_centers) * len(y_centers))
    return len(cells) / expected


def refine_section_geometry(
    normalized: "np.ndarray",
    section_name: str,
    profile: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Locate the actual bubble lattice for a section on this scanned sheet."""
    spec = SECTION_SPECS[section_name]
    base_grid = _profile_section_grid(profile, section_name)
    candidates = _component_candidates(normalized, spec)
    if len(candidates) < int(base_grid["rows"]) * max(2, int(base_grid["cols"]) // 2):
        raise SectionRegistrationError(
            f"{section_name}: too few bubble candidates ({len(candidates)})"
        )

    x_clusters = _cluster_values(
        [float(candidate["center"][0]) for candidate in candidates],
        float(spec["x_gap"]),
    )
    y_clusters = _cluster_values(
        [float(candidate["center"][1]) for candidate in candidates],
        float(spec["y_gap"]),
    )

    cols = int(base_grid["cols"])
    rows = int(base_grid["rows"])
    selected_x = _select_axis_clusters(
        x_clusters,
        cols,
        tuple(float(v) for v in spec["x_pitch_range"]),
        _grid_x_centers(base_grid),
    )
    selected_y = _select_axis_clusters(
        y_clusters,
        rows,
        tuple(float(v) for v in spec["y_pitch_range"]),
        _grid_y_centers(base_grid),
    )
    x_centers = [float(item["center"]) for item in selected_x]
    y_centers = [float(item["center"]) for item in selected_y]
    coverage = _section_coverage(candidates, x_centers, y_centers, spec)
    if coverage < float(spec["min_coverage"]):
        raise SectionRegistrationError(
            f"{section_name}: low bubble lattice coverage ({coverage:.2f})"
        )

    x_diffs = np.diff(np.array(x_centers, dtype=np.float32))
    y_diffs = np.diff(np.array(y_centers, dtype=np.float32))
    x_pitch = float(np.median(x_diffs)) if len(x_diffs) else 0.0
    y_pitch = float(np.median(y_diffs)) if len(y_diffs) else 0.0
    grid = dict(base_grid)
    grid.update({
        "x_centers": [round(v, 2) for v in x_centers],
        "y_centers": [round(v, 2) for v in y_centers],
        "y_origin": round(y_centers[0], 2),
        "x_pitch": round(x_pitch, 3),
        "y_pitch": round(y_pitch, 3),
        "registration_method": "bubble_lattice",
    })

    base_x = _grid_x_centers(base_grid)
    base_y = _grid_y_centers(base_grid)
    metadata = {
        "section": section_name,
        "method": "bubble_lattice",
        "roi": list(spec["roi"]),
        "candidate_count": len(candidates),
        "coverage": round(coverage, 4),
        "x_centers": grid["x_centers"],
        "y_centers": grid["y_centers"],
        "x_pitch": grid["x_pitch"],
        "y_pitch": grid["y_pitch"],
        "local_offsets": {
            "x_first": round(x_centers[0] - base_x[0], 3),
            "x_last": round(x_centers[-1] - base_x[-1], 3),
            "y_first": round(y_centers[0] - base_y[0], 3),
            "y_last": round(y_centers[-1] - base_y[-1], 3),
        },
        "x_clusters": [
            {"center": round(float(item["center"]), 2), "count": int(item["count"])}
            for item in x_clusters
        ],
        "y_clusters": [
            {"center": round(float(item["center"]), 2), "count": int(item["count"])}
            for item in y_clusters
        ],
    }
    return grid, metadata


def _save_debug_image(
    warped_bin: "np.ndarray",
    out_path: Path,
    digit_decisions: list[dict[str, Any]] | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Save the normalized binary image with bubble sampling circles overlaid."""
    try:
        vis = cv2.cvtColor(warped_bin, cv2.COLOR_GRAY2BGR)

        def _draw_bubbles(grid: dict[str, Any], colour: tuple[int, int, int]) -> None:
            cols = int(grid["cols"])
            rows = int(grid["rows"])
            radius = int(grid["bubble_radius"])
            for r in range(rows):
                for c in range(cols):
                    cx, cy = _bubble_center(grid, c, r)
                    cv2.circle(vis, (cx, cy), radius, colour, 4)
                    cv2.circle(vis, (cx, cy), 2, colour, -1)

        resolved_grids = (payload or {}).get("resolved_grids") or {}
        student_grid = resolved_grids.get("student_code", STUDENT_CODE_GRID)
        exam_grid = resolved_grids.get("exam_code", EXAM_CODE_GRID)
        left_grid = resolved_grids.get("answers_left", ANSWER_GRID_LEFT)
        right_grid = resolved_grids.get("answers_right", ANSWER_GRID_RIGHT)

        _draw_bubbles(student_grid, (0, 170, 255))
        _draw_bubbles(exam_grid, (0, 170, 255))
        _draw_bubbles(left_grid, (0, 255, 80))
        _draw_bubbles(right_grid, (0, 255, 80))

        for match in (payload or {}).get("anchor_matches", []):
            center = match.get("template_center") or match.get("detected_center")
            if not center:
                continue
            cv2.circle(vis, (int(round(center[0])), int(round(center[1]))), 12, (255, 255, 0), 3)

        if digit_decisions:
            grids = {
                "student_code": student_grid,
                "exam_code": exam_grid,
            }
            for decision in digit_decisions:
                grid = grids.get(str(decision.get("group")))
                digit = decision.get("best_digit")
                col = decision.get("col")
                if grid is None or digit is None or col is None:
                    continue
                cx, cy = _bubble_center(grid, int(col), int(digit))
                radius = int(grid["bubble_radius"])
                if decision.get("accepted"):
                    colour = (255, 0, 0)
                    if decision.get("low_confidence"):
                        colour = (255, 0, 255)
                else:
                    colour = (0, 0, 255)
                cv2.circle(vis, (cx, cy), radius + 5, colour, 5)
                cv2.circle(vis, (cx, cy), 3, colour, -1)

        cv2.imwrite(str(out_path), vis)
        logger.info("Debug grid image saved: %s", out_path)
    except Exception as exc:
        logger.warning("Could not save debug image: %s", exc)


def _pil_to_base64_jpeg(pil_image: "Image.Image", max_w: int = 400) -> str:
    ratio = max_w / pil_image.width
    thumb = pil_image.resize(
        (max_w, int(pil_image.height * ratio)),
        Image.LANCZOS,
    )
    buf = io.BytesIO()
    thumb.convert("RGB").save(buf, format="JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode()


def fetch_answer_key(exam_code: str, api_base: str) -> dict[str, Any] | None:
    """GET /lms/exam-code/{code} and return the data dict, or None on failure."""
    if not _REQUESTS_AVAILABLE:
        return None
    try:
        resp = _requests.get(f"{api_base}/lms/exam-code/{exam_code}", timeout=5)
        if resp.status_code == 200:
            return resp.json().get("data")
    except Exception as exc:
        logger.warning("fetch_answer_key failed: %s", exc)
    return None


def grade(answers: list[str | None], answer_key: list[str]) -> tuple[int, int]:
    """Return (score, max_score) comparing answers against the answer key."""
    total = len(answer_key)
    score = sum(
        1
        for i in range(total)
        if i < len(answers) and answers[i] is not None and answers[i] == answer_key[i]
    )
    return score, total


def _adaptive_threshold(warped: "np.ndarray", grids: list[dict[str, Any]]) -> float:
    """
    Sample every bubble in the given grids and find the valley between the
    empty-bubble and filled-bubble peaks via a 1-D Otsu on the ratio histogram.
    Falls back to FILL_THRESHOLD if the distribution is unimodal or degenerate.
    """
    ratios: list[float] = []
    for grid in grids:
        cols = int(grid["cols"])
        rows = int(grid["rows"])
        radius = int(grid["bubble_radius"])
        for r in range(rows):
            for c in range(cols):
                cx, cy = _bubble_center(grid, c, r)
                ratios.append(_bubble_fill_ratio(warped, cx, cy, radius))

    if len(ratios) < 10:
        return FILL_THRESHOLD

    arr = np.array(ratios, dtype=np.float32)
    bins = 40
    hist, edges = np.histogram(arr, bins=bins, range=(0.0, 1.0))
    bin_centers = (edges[:-1] + edges[1:]) / 2  # shape (bins,) — matches hist
    total = float(hist.sum())
    if total == 0:
        return FILL_THRESHOLD

    best_t = FILL_THRESHOLD
    best_score = -1.0
    for i in range(1, bins):
        w0 = float(hist[:i].sum()) / total
        w1 = float(hist[i:].sum()) / total
        if w0 < 0.05 or w1 < 0.05:
            continue
        u0 = float(np.average(bin_centers[:i], weights=hist[:i] + 1e-9))
        u1 = float(np.average(bin_centers[i:], weights=hist[i:] + 1e-9))
        score = w0 * w1 * (u0 - u1) ** 2
        if score > best_score:
            best_score = score
            best_t = float(edges[i])

    # Clamp to a safe range so extreme scans don't break everything.
    return float(np.clip(best_t, 0.15, 0.45))


@dataclass
class SheetResult:
    sheet_index: int
    student_code: str | None
    exam_code: str | None
    raw_answers: str
    score: int
    max_score: int
    status: str
    flag_reasons: list[str] = field(default_factory=list)
    scan_image: str = ""


def _save_omr_debug(
    sheet_index: int,
    normalized: "np.ndarray | None",
    payload: dict[str, Any],
) -> None:
    if not SAVE_DEBUG_IMAGE:
        return
    try:
        out_dir = Path(__file__).resolve().parent / "scans"
        out_dir.mkdir(parents=True, exist_ok=True)
        if normalized is not None:
            cv2.imwrite(str(out_dir / f"scan_normalized_{sheet_index}.png"), normalized)
            _save_debug_image(
                normalized,
                out_dir / f"scan_debug_{sheet_index}.png",
                payload.get("digit_decisions"),
                payload,
            )
        (out_dir / f"omr_debug_{sheet_index}.json").write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.warning("Could not save OMR debug payload: %s", exc)


def process_sheet(
    pil_image: "Image.Image",
    sheet_index: int,
    api_base: str,
) -> SheetResult:
    """
    Process one sheet through normalization, OMR reading, API validation, and grading.
    """
    if not _CV2_AVAILABLE:
        raise RuntimeError("opencv-python is not installed.")

    flags: list[str] = []
    thumbnail = _pil_to_base64_jpeg(pil_image)
    debug_payload: dict[str, Any] = {
        "sheet_index": sheet_index,
        "raw_pil_size": [pil_image.width, pil_image.height],
    }
    debug_samples: list[dict[str, Any]] = []
    digit_decisions: list[dict[str, Any]] = []
    profile = load_template_profile(include_image=True)
    blank_reference = profile.get("_blank_reference")

    binary = preprocess(pil_image)
    try:
        scan, normalization_debug = normalize_scan(binary)
        debug_payload.update(normalization_debug)
    except UnreadableSheetError as exc:
        reason = str(exc).split(":", 1)[0] or "UNREADABLE"
        flags.extend(["UNREADABLE", reason])
        debug_payload["normalization_error"] = str(exc)
        _save_omr_debug(sheet_index, None, debug_payload)
        return SheetResult(
            sheet_index=sheet_index,
            student_code=None,
            exam_code=None,
            raw_answers="",
            score=0,
            max_score=0,
            status="flagged",
            flag_reasons=flags,
            scan_image=thumbnail,
        )

    section_registration: dict[str, Any] = {}
    resolved_grids: dict[str, dict[str, Any]] = {}

    def _resolve_section(section_name: str) -> dict[str, Any] | None:
        failure_flag = str(SECTION_SPECS[section_name]["failure_flag"])
        try:
            grid, metadata = refine_section_geometry(scan, section_name, profile)
            section_registration[section_name] = metadata
            resolved_grids[section_name] = _json_safe_grid(grid)
            return grid
        except SectionRegistrationError as exc:
            # Try template-calibrated coordinates before giving up.
            template_section = profile.get("sections", {}).get(section_name)
            if template_section:
                grid = dict(SECTION_SPECS[section_name]["base_grid"])
                grid.update(template_section)
                section_registration[section_name] = {
                    "section": section_name,
                    "method": "template_fallback",
                    "status": "ok",
                    "live_error": str(exc),
                    "roi": list(SECTION_SPECS[section_name]["roi"]),
                }
                resolved_grids[section_name] = _json_safe_grid(grid)
                return grid
            if failure_flag not in flags:
                flags.append(failure_flag)
            section_registration[section_name] = {
                "section": section_name,
                "method": "bubble_lattice",
                "status": "failed",
                "error": str(exc),
                "roi": list(SECTION_SPECS[section_name]["roi"]),
            }
            return None

    student_grid = _resolve_section("student_code")
    exam_grid = _resolve_section("exam_code")
    answers_left_grid = _resolve_section("answers_left")
    answers_right_grid = _resolve_section("answers_right")

    # Compute per-scan fill threshold from the bimodal ratio distribution.
    _active_grids = [
        g for g in [student_grid, exam_grid, answers_left_grid, answers_right_grid]
        if g is not None
    ]
    adaptive_t = _adaptive_threshold(scan, _active_grids) if _active_grids else FILL_THRESHOLD
    # Temporarily override the module-level threshold for this sheet's reads.
    _orig_threshold = globals().get("FILL_THRESHOLD", 0.28)
    globals()["FILL_THRESHOLD"] = adaptive_t
    logger.info("Adaptive fill threshold for sheet %d: %.3f", sheet_index, adaptive_t)

    if student_grid is None:
        sc_digits = [None] * int(STUDENT_CODE_GRID["cols"])
    else:
        sc_digits = read_digit_grid(
            scan,
            student_grid,
            flags,
            debug_samples,
            digit_decisions,
            "student_code",
            "STUDENT_CODE",
            blank_reference=blank_reference,
        )
    if any(d is None for d in sc_digits):
        flags.append("STUDENT_CODE_INCOMPLETE")
        student_code = None
    else:
        student_code = "".join(str(d) for d in sc_digits)

    if exam_grid is None:
        ec_digits = [None] * int(EXAM_CODE_GRID["cols"])
    else:
        ec_digits = read_digit_grid(
            scan,
            exam_grid,
            flags,
            debug_samples,
            digit_decisions,
            "exam_code",
            "EXAM_CODE",
            blank_reference=blank_reference,
        )
    if any(d is None for d in ec_digits):
        flags.append("EXAM_CODE_INCOMPLETE")
        exam_code = None
    else:
        exam_code = "".join(str(d) for d in ec_digits)

    if student_code and _REQUESTS_AVAILABLE:
        try:
            _requests.get(
                f"{api_base}/lms/subjects/0/students",
                params={"student_code": student_code},
                timeout=3,
            )
        except Exception:
            pass

    exam_data: dict[str, Any] | None = None
    if exam_code:
        exam_data = fetch_answer_key(exam_code, api_base)
        if exam_data is None:
            flags.append("EXAM_CODE_NOT_FOUND")
    else:
        flags.append("EXAM_CODE_NOT_FOUND")

    answer_key: list[str] = []
    if exam_data:
        answer_key = exam_data.get("answer_key") or []
    total_from_exam = 0
    if exam_data:
        try:
            total_from_exam = int(exam_data.get("total_items") or 0)
        except (TypeError, ValueError):
            total_from_exam = 0
    effective_total_items = min(total_from_exam or len(answer_key) or 30, 30)

    all_answers: list[str | None] = []
    if answers_left_grid is None:
        all_answers += [None] * int(ANSWER_GRID_LEFT["rows"])
    else:
        all_answers += read_answer_grid(
            scan,
            answers_left_grid,
            1,
            flags,
            debug_samples,
            "answers_left",
            effective_total_items,
            blank_reference=blank_reference,
        )
    if answers_right_grid is None:
        all_answers += [None] * int(ANSWER_GRID_RIGHT["rows"])
    else:
        all_answers += read_answer_grid(
            scan,
            answers_right_grid,
            16,
            flags,
            debug_samples,
            "answers_right",
            effective_total_items,
            blank_reference=blank_reference,
        )
    ignored_answer_items = list(range(effective_total_items + 1, len(all_answers) + 1))
    scored_answers = all_answers[:effective_total_items]
    scored_answer_key = answer_key[:effective_total_items]

    if scored_answer_key:
        score, max_score = grade(scored_answers, scored_answer_key)
    else:
        score, max_score = 0, 0

    raw_answers = "|".join(a if a is not None else "" for a in scored_answers)
    status = "flagged" if flags else "ok"

    # Summarise per-scan reading quality for quick triage.
    _all_ratios = [s["ratio"] for s in debug_samples if isinstance(s.get("ratio"), float)]
    _arr = np.array(_all_ratios, dtype=np.float32) if _all_ratios else np.array([0.0])
    scan_quality = {
        "registration_mark_method": debug_payload.get("registration_mark_method", "unknown"),
        "mark_count": len(debug_payload.get("mark_candidates", [])),
        "fill_threshold_used": round(float(adaptive_t), 4),
        "fill_threshold_source": "adaptive",
        "bubble_ratio_p25": round(float(np.percentile(_arr, 25)), 4),
        "bubble_ratio_p75": round(float(np.percentile(_arr, 75)), 4),
        "low_confidence_bubbles": sum(
            1 for d in digit_decisions if d.get("low_confidence")
        ),
        "sections_live_calibrated": [
            k for k, v in section_registration.items()
            if v.get("method") == "bubble_lattice"
        ],
        "sections_template_fallback": [
            k for k, v in section_registration.items()
            if v.get("method") == "template_fallback"
        ],
        "sections_failed": [
            k for k, v in section_registration.items()
            if v.get("status") == "failed"
        ],
    }

    debug_payload.update({
        "template_version": profile.get("template_version", TEMPLATE_VERSION),
        "template_profile_loaded": bool(profile.get("profile_loaded")),
        "blank_reference_loaded": bool(profile.get("blank_reference_loaded")),
        "section_registration": section_registration,
        "resolved_grids": resolved_grids,
        "digit_grid_geometry": {
            "student_code": {
                "x_centers": (student_grid or STUDENT_CODE_GRID).get("x_centers"),
                "y_centers": (student_grid or STUDENT_CODE_GRID).get("y_centers"),
                "y_origin": (student_grid or STUDENT_CODE_GRID).get("y_origin"),
                "y_pitch": (student_grid or STUDENT_CODE_GRID).get("y_pitch"),
                "bubble_radius": (student_grid or STUDENT_CODE_GRID).get("bubble_radius"),
            },
            "exam_code": {
                "x_centers": (exam_grid or EXAM_CODE_GRID).get("x_centers"),
                "y_centers": (exam_grid or EXAM_CODE_GRID).get("y_centers"),
                "y_origin": (exam_grid or EXAM_CODE_GRID).get("y_origin"),
                "y_pitch": (exam_grid or EXAM_CODE_GRID).get("y_pitch"),
                "bubble_radius": (exam_grid or EXAM_CODE_GRID).get("bubble_radius"),
            },
        },
        "student_code_digits": sc_digits,
        "exam_code_digits": ec_digits,
        "student_code": student_code,
        "exam_code": exam_code,
        "effective_total_items": effective_total_items,
        "ignored_answer_items": ignored_answer_items,
        "raw_answers": raw_answers,
        "status": status,
        "flag_reasons": flags,
        "digit_decisions": digit_decisions,
        "bubble_readings": debug_samples,
        "scan_quality": scan_quality,
    })

    # Restore original threshold so other sheets aren't affected.
    globals()["FILL_THRESHOLD"] = _orig_threshold

    _save_omr_debug(sheet_index, scan, debug_payload)

    return SheetResult(
        sheet_index=sheet_index,
        student_code=student_code,
        exam_code=exam_code,
        raw_answers=raw_answers,
        score=score,
        max_score=max_score,
        status=status,
        flag_reasons=flags,
        scan_image=thumbnail,
    )


def sheet_result_to_dict(result: SheetResult) -> dict[str, Any]:
    return {
        "sheet_index": result.sheet_index,
        "student_code": result.student_code,
        "exam_code": result.exam_code,
        "raw_answers": result.raw_answers,
        "score": result.score,
        "max_score": result.max_score,
        "status": result.status,
        "flag_reasons": result.flag_reasons,
        "scan_image": result.scan_image,
    }
