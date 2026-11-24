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
from typing import Any, Callable

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
DIGIT_SECOND_MARK_RATIO  = 0.35
ANSWER_MIN_RATIO          = 0.20
ANSWER_MIN_GAP            = 0.06
ANSWER_LOW_CONFIDENCE_GAP = 0.10
ANSWER_SECOND_MARK_RATIO  = 0.25

# Bubble reading (local alignment + inner-disk measurement, see
# align_section_to_template / bubble_mark_ratio). On 14 real scans a pencil fill
# measured 0.82-1.0 and an empty bubble at most 0.22 (answers) / 0.07 (digits),
# so 0.50 sits well clear of both and still accepts lightly shaded bubbles.
ANSWER_MARK_RATIO   = 0.50   # >= counts as shaded; two shaded = double mark
DIGIT_MARK_RATIO    = 0.50
MARK_CLEAR_GAP      = 0.35   # best - second below this is flagged low confidence
MARK_INNER_RADIUS   = 0.70   # measure only the inner 70% of the bubble, away from the printed outline
MARK_BLANK_DILATE_PX = 5     # widen the template's printed glyph before subtracting it (scans print bolder)
MARK_NUDGE_FRACTION = 0.15   # nudge the sample by up to 15% of the radius: a fill stays dark, an outline doesn't
ALIGN_SECTION_SEARCH_PX = 60
ALIGN_UNIT_SEARCH_PX    = 14
ALIGN_MIN_MATCH         = 0.25  # template-match score for a row/column to be trusted
ALIGN_MAX_DEVIATION_PX  = 6
ALIGN_BUBBLE_SEARCH_PX  = 10    # final per-bubble snap onto its printed outline
ALIGN_BUBBLE_MIN_MATCH  = 0.55
PHASE_CORR_MIN_RESPONSE   = 0.15
PHASE_CORR_MAX_SHIFT      = 25.0
PAGE_MIN_ANCHOR_INLIERS   = 6
PAGE_MAX_MEAN_ERROR       = 8.0
PAGE_MAX_INLIER_ERROR     = 18.0
PAGE_RANSAC_THRESHOLD     = 18.0
SECTION_SEARCH_MARGIN     = 45
SECTION_MAX_TRANSLATION   = 50.0
SECTION_MAX_PITCH_DELTA   = 0.08
SECTION_MIN_COVERAGE      = 0.85
SECTION_MAX_RESIDUAL      = 12.0
SECTION_MIN_MATCH_SCORE   = 0.15
SECTION_MAX_LIVE_DRIFT    = 18.0
SECTION_MAX_LIVE_DRIFT_JUMP = 12.0
ANCHOR_GUIDED_SEARCH_RADIUS = 170
ANCHOR_DEDUPE_DISTANCE      = 24.0
ANCHOR_MATCH_MAX_DISTANCE   = 190.0
ANCHOR_MIN_X_SPAN_RATIO     = 0.60
ANCHOR_MIN_Y_SPAN_RATIO     = 0.60
ANCHOR_ONE_SIDED_MAX_RESIDUAL = 25.0  # Debug helper only; production requires full-span anchors.
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

    def __init__(self, message: str, debug: dict[str, Any] | None = None):
        super().__init__(message)
        self.debug = debug or {}


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


def _template_raw_size(profile: dict[str, Any] | None) -> tuple[int, int]:
    raw_size = (profile or {}).get("raw_size") or [CANON_W, CANON_H]
    if len(raw_size) != 2:
        return CANON_W, CANON_H
    width, height = int(raw_size[0]), int(raw_size[1])
    if width <= 0 or height <= 0:
        return CANON_W, CANON_H
    return width, height


def _resize_for_template(pil_image: "Image.Image", target_size: tuple[int, int]) -> "Image.Image":
    if pil_image.size == target_size:
        return pil_image.copy()
    return pil_image.resize(target_size, Image.Resampling.LANCZOS)


def _white_for_mode(mode: str) -> Any:
    if mode == "1":
        return 1
    if mode in {"L", "P", "I", "F"}:
        return 255
    if mode == "RGBA":
        return (255, 255, 255, 255)
    if mode == "LA":
        return (255, 255)
    return (255, 255, 255)


def _fit_pad_for_template(
    pil_image: "Image.Image",
    target_size: tuple[int, int],
) -> tuple["Image.Image", dict[str, Any]]:
    target_w, target_h = target_size
    width, height = pil_image.size
    if width <= 0 or height <= 0:
        return _resize_for_template(pil_image, target_size), {
            "fit_scale": None,
            "fit_size": [target_w, target_h],
            "fit_offset": [0, 0],
        }
    scale = min(target_w / width, target_h / height)
    fit_w = max(1, int(round(width * scale)))
    fit_h = max(1, int(round(height * scale)))
    resized = pil_image.resize((fit_w, fit_h), Image.Resampling.LANCZOS)
    canvas = Image.new(pil_image.mode, target_size, _white_for_mode(pil_image.mode))
    offset_x = (target_w - fit_w) // 2
    offset_y = (target_h - fit_h) // 2
    canvas.paste(resized, (offset_x, offset_y))
    return canvas, {
        "fit_scale": round(float(scale), 6),
        "fit_size": [fit_w, fit_h],
        "fit_offset": [offset_x, offset_y],
    }


def _binary_content_bbox(binary: "np.ndarray", margin: int = 24) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(binary > 0)
    if len(xs) == 0 or len(ys) == 0:
        return None
    height, width = binary.shape[:2]
    x0 = max(0, int(xs.min()) - margin)
    y0 = max(0, int(ys.min()) - margin)
    x1 = min(width, int(xs.max()) + 1 + margin)
    y1 = min(height, int(ys.max()) + 1 + margin)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _bbox_touches_edges(
    bbox: tuple[int, int, int, int],
    size: tuple[int, int],
    edge_tolerance: int,
) -> dict[str, bool]:
    x0, y0, x1, y1 = bbox
    width, height = size
    return {
        "left": x0 <= edge_tolerance,
        "top": y0 <= edge_tolerance,
        "right": x1 >= width - edge_tolerance,
        "bottom": y1 >= height - edge_tolerance,
    }


def _expand_bbox(
    bbox: tuple[int, int, int, int],
    size: tuple[int, int],
    margin: int,
) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = bbox
    width, height = size
    return (
        max(0, int(x0) - margin),
        max(0, int(y0) - margin),
        min(width, int(x1) + margin),
        min(height, int(y1) + margin),
    )


def _portrait_canvas_rotate_full_candidate(
    pil_image: "Image.Image",
    target_size: tuple[int, int],
    order: int,
    *,
    content_bbox: tuple[int, int, int, int],
    content_touches_edges: dict[str, bool],
    content_aspect: float,
) -> dict[str, Any] | None:
    """Rotate the whole portrait canvas first so the ink bbox cannot cut off the top."""
    rotated = pil_image.transpose(Image.Transpose.ROTATE_90)
    rotated_binary = preprocess(rotated)
    detect_margin = max(16, int(round(min(rotated.width, rotated.height) * 0.01)))
    rotated_bbox = _binary_content_bbox(rotated_binary, margin=detect_margin)
    if rotated_bbox is None:
        return None

    generous_margin = max(96, int(round(min(rotated.width, rotated.height) * 0.08)))
    expanded_bbox = _expand_bbox(rotated_bbox, rotated.size, generous_margin)
    crop = rotated.crop(expanded_bbox)
    prepared, fit_meta = _fit_pad_for_template(crop, target_size)
    edge_tolerance = max(24, int(round(min(rotated.width, rotated.height) * 0.02)))
    rotated_touches_edges = _bbox_touches_edges(rotated_bbox, rotated.size, edge_tolerance)
    return {
        "order": order,
        "orientation": "portrait_canvas_rotate_full_90_ccw",
        "orientation_correction": "rotate_90_ccw",
        "source_size": [int(crop.width), int(crop.height)],
        "prepared_size": [int(prepared.width), int(prepared.height)],
        "input_size_normalized": crop.size != target_size,
        "candidate_source": "portrait_canvas_rotate_full",
        "content_bbox": [int(v) for v in content_bbox],
        "content_bbox_touches_edges": content_touches_edges,
        "content_bbox_aspect": round(float(content_aspect), 4),
        "portrait_canvas_detected": True,
        "landscape_content_detected": True,
        "rotated_canvas_size": [int(rotated.width), int(rotated.height)],
        "post_rotation_content_bbox": [int(v) for v in expanded_bbox],
        "post_rotation_detected_content_bbox": [int(v) for v in rotated_bbox],
        "post_rotation_bbox_touches_edges": rotated_touches_edges,
        "prepared_image_source": "rotate_full_then_post_rotation_bbox",
        **fit_meta,
        "image": prepared,
    }


def _content_box_candidates(
    pil_image: "Image.Image",
    target_size: tuple[int, int],
    start_order: int,
) -> list[dict[str, Any]]:
    binary = preprocess(pil_image)
    crop_margin = max(32, int(round(min(pil_image.width, pil_image.height) * 0.03)))
    bbox = _binary_content_bbox(binary, margin=crop_margin)
    if bbox is None:
        return []
    x0, y0, x1, y1 = bbox
    edge_tolerance = max(24, int(round(min(pil_image.width, pil_image.height) * 0.02)))
    touches_edges = _bbox_touches_edges(bbox, pil_image.size, edge_tolerance)
    crop = pil_image.crop((x0, y0, x1, y1))
    bbox_w = x1 - x0
    bbox_h = y1 - y0
    portrait_canvas = pil_image.height > pil_image.width
    landscape_content = bbox_w > bbox_h * 1.05
    transforms = []
    candidates: list[dict[str, Any]] = []
    next_order = start_order
    if portrait_canvas and landscape_content:
        rotate_full = _portrait_canvas_rotate_full_candidate(
            pil_image,
            target_size,
            next_order,
            content_bbox=bbox,
            content_touches_edges=touches_edges,
            content_aspect=float(bbox_w / max(1, bbox_h)),
        )
        if rotate_full is not None:
            candidates.append(rotate_full)
            next_order += 1
        transforms.append((
            "portrait_canvas_content_rotate_90_ccw",
            "rotate_90_ccw",
            crop.transpose(Image.Transpose.ROTATE_90),
            "portrait_canvas_content_box",
        ))
        transforms.append((
            "content_rotate_90_cw",
            "rotate_90_cw",
            crop.transpose(Image.Transpose.ROTATE_270),
            "content_box",
        ))
    elif landscape_content:
        transforms.append((
            "content_rotate_90_ccw",
            "rotate_90_ccw",
            crop.transpose(Image.Transpose.ROTATE_90),
            "content_box",
        ))
        transforms.append((
            "content_rotate_90_cw",
            "rotate_90_cw",
            crop.transpose(Image.Transpose.ROTATE_270),
            "content_box",
        ))
    else:
        transforms.append((
            "content_rotate_90_cw",
            "rotate_90_cw",
            crop.transpose(Image.Transpose.ROTATE_270),
            "content_box",
        ))
        transforms.append((
            "content_rotate_90_ccw",
            "rotate_90_ccw",
            crop.transpose(Image.Transpose.ROTATE_90),
            "content_box",
        ))
    transforms.extend([
        ("content_original", "none", crop, "content_box"),
        ("content_rotate_180", "rotate_180", crop.transpose(Image.Transpose.ROTATE_180), "content_box"),
    ])
    for offset, (name, correction, image, source) in enumerate(transforms):
        prepared, fit_meta = _fit_pad_for_template(image, target_size)
        candidates.append({
            "order": next_order + offset,
            "orientation": name,
            "orientation_correction": correction,
            "source_size": [int(image.width), int(image.height)],
            "prepared_size": [int(prepared.width), int(prepared.height)],
            "input_size_normalized": image.size != target_size,
            "candidate_source": source,
            "content_bbox": [x0, y0, x1, y1],
            "content_bbox_touches_edges": touches_edges,
            "content_bbox_aspect": round(float(bbox_w / max(1, bbox_h)), 4),
            "portrait_canvas_detected": portrait_canvas,
            "landscape_content_detected": landscape_content,
            **fit_meta,
            "image": prepared,
        })
    return candidates


def _orientation_candidate_images(
    pil_image: "Image.Image",
    target_size: tuple[int, int],
) -> list[dict[str, Any]]:
    direct_transforms = [
        ("original", "none", pil_image),
        ("rotate_180", "rotate_180", pil_image.transpose(Image.Transpose.ROTATE_180)),
    ]
    candidates: list[dict[str, Any]] = []
    for order, (name, correction, image) in enumerate(direct_transforms):
        prepared = _resize_for_template(image, target_size)
        candidates.append({
            "order": order,
            "orientation": name,
            "orientation_correction": correction,
            "source_size": [int(image.width), int(image.height)],
            "prepared_size": [int(prepared.width), int(prepared.height)],
            "input_size_normalized": image.size != target_size,
            "candidate_source": "full_canvas_resize",
            "fit_scale": None,
            "fit_size": None,
            "fit_offset": None,
            "image": prepared,
        })
    rotate_transforms = [
        ("rotate_90_cw", "rotate_90_cw", pil_image.transpose(Image.Transpose.ROTATE_270)),
        ("rotate_90_ccw", "rotate_90_ccw", pil_image.transpose(Image.Transpose.ROTATE_90)),
    ]
    for offset, (name, correction, image) in enumerate(rotate_transforms, start=len(candidates)):
        prepared, fit_meta = _fit_pad_for_template(image, target_size)
        candidates.append({
            "order": offset,
            "orientation": name,
            "orientation_correction": correction,
            "source_size": [int(image.width), int(image.height)],
            "prepared_size": [int(prepared.width), int(prepared.height)],
            "input_size_normalized": image.size != target_size,
            "candidate_source": "full_canvas_fit_pad",
            **fit_meta,
            "image": prepared,
        })
    candidates.extend(_content_box_candidates(pil_image, target_size, len(candidates)))
    return candidates


def _failed_registration_debug(exc_debug: dict[str, Any]) -> dict[str, Any]:
    anchor_detection = exc_debug.get("anchor_detection") or {}
    anchor_matches = exc_debug.get("anchor_matches") or []
    payload = {
        "matched_anchor_count": len(anchor_matches) or anchor_detection.get("matched_anchor_count"),
        "merged_candidate_count": anchor_detection.get("merged_candidate_count"),
        "profile_guided_candidate_count": anchor_detection.get("profile_guided_candidate_count"),
        "global_candidate_count": anchor_detection.get("global_candidate_count"),
        "unmatched_anchor_count": anchor_detection.get("unmatched_anchor_count"),
        "matched_anchor_indices": [
            match.get("template_index")
            for match in anchor_matches
            if match.get("template_index") is not None
        ],
    }
    if "anchor_span" in exc_debug:
        payload["anchor_span"] = exc_debug["anchor_span"]
    if "page_registration_attempts" in exc_debug:
        payload["page_registration_attempts"] = exc_debug["page_registration_attempts"]
    return {key: value for key, value in payload.items() if value is not None}


def _orientation_attempt_payload(
    candidate: dict[str, Any],
    binary: "np.ndarray",
    status: str,
    *,
    normalization_debug: dict[str, Any] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "orientation": candidate["orientation"],
        "orientation_correction": candidate["orientation_correction"],
        "source_size": candidate["source_size"],
        "prepared_size": candidate["prepared_size"],
        "input_size_normalized": candidate["input_size_normalized"],
        "candidate_source": candidate.get("candidate_source"),
        "status": status,
    }
    if candidate.get("fit_scale") is not None:
        payload["fit_scale"] = candidate.get("fit_scale")
        payload["fit_size"] = candidate.get("fit_size")
        payload["fit_offset"] = candidate.get("fit_offset")
    if candidate.get("content_bbox") is not None:
        payload["content_bbox"] = candidate.get("content_bbox")
        payload["content_bbox_touches_edges"] = candidate.get("content_bbox_touches_edges")
        payload["content_bbox_aspect"] = candidate.get("content_bbox_aspect")
        payload["portrait_canvas_detected"] = candidate.get("portrait_canvas_detected")
        payload["landscape_content_detected"] = candidate.get("landscape_content_detected")
    for key in (
        "rotated_canvas_size",
        "post_rotation_content_bbox",
        "post_rotation_detected_content_bbox",
        "post_rotation_bbox_touches_edges",
        "prepared_image_source",
    ):
        if candidate.get(key) is not None:
            payload[key] = candidate.get(key)
    if normalization_debug:
        page_registration = normalization_debug.get("page_registration") or {}
        anchor_detection = normalization_debug.get("anchor_detection") or {}
        payload.update({
            "page_registration_method": normalization_debug.get("page_registration_method"),
            "matched_anchor_count": len(normalization_debug.get("anchor_matches") or []),
            "inliers": page_registration.get("inliers"),
            "mean_error": normalization_debug.get("page_registration_mean_error"),
            "max_error": normalization_debug.get("page_registration_max_error"),
            "merged_candidate_count": anchor_detection.get("merged_candidate_count"),
        })
    else:
        payload["detected_anchor_count"] = len(detect_anchor_candidates(binary))
    if error:
        payload["error"] = error
    if normalization_debug is None and isinstance(error, str):
        # Rich failure details are added by the caller when available.
        pass
    return payload


def _sideways_clipped_scan_detected(attempts: list[dict[str, Any]]) -> bool:
    if not attempts:
        return False
    original = next((item for item in attempts if item.get("orientation") == "original"), None)
    if not original:
        return False
    original_many_candidates = int(original.get("detected_anchor_count") or 0) >= 20
    original_span_failed = "ANCHOR_SPAN_INSUFFICIENT" in str(original.get("error") or "")
    content_touches_edge = any(
        any((item.get("content_bbox_touches_edges") or {}).values())
        for item in attempts
        if item.get("candidate_source") in {
            "content_box",
            "portrait_canvas_content_box",
            "portrait_canvas_rotate_full",
        }
    )
    rotated_candidates_failed = [
        item for item in attempts
        if item.get("orientation_correction") in {"rotate_90_cw", "rotate_90_ccw"}
    ]
    no_rotated_success = bool(rotated_candidates_failed) and all(
        item.get("status") != "ok" for item in rotated_candidates_failed
    )
    content_box_attempted = any(
        item.get("candidate_source") in {
            "content_box",
            "portrait_canvas_content_box",
            "portrait_canvas_rotate_full",
        }
        for item in attempts
    )
    return bool(
        original_span_failed
        and content_touches_edge
        and no_rotated_success
        and (original_many_candidates or content_box_attempted)
    )


def _prepare_and_normalize_scan(
    pil_image: "Image.Image",
    profile: dict[str, Any],
) -> tuple["np.ndarray", "np.ndarray", dict[str, Any], dict[str, Any], "Image.Image"]:
    target_size = _template_raw_size(profile)
    attempts: list[dict[str, Any]] = []
    successes: list[dict[str, Any]] = []
    failure_preview_image: Image.Image | None = None
    failure_preview_binary: np.ndarray | None = None
    failure_preview_orientation: str | None = None
    failure_preview_priority = 0
    preview_priorities = {
        "content_rotate_90_ccw": 1,
        "portrait_canvas_content_rotate_90_ccw": 2,
        "portrait_canvas_rotate_full_90_ccw": 3,
    }

    for candidate in _orientation_candidate_images(pil_image, target_size):
        binary = preprocess(candidate["image"])
        preview_priority = preview_priorities.get(candidate["orientation"], 0)
        if preview_priority > failure_preview_priority:
            failure_preview_image = candidate["image"]
            failure_preview_binary = binary
            failure_preview_orientation = candidate["orientation"]
            failure_preview_priority = preview_priority
        try:
            normalized, normalization_debug = normalize_scan(binary, use_template_profile=True)
        except UnreadableSheetError as exc:
            attempt = _orientation_attempt_payload(
                candidate,
                binary,
                "failed",
                error=str(exc),
            )
            attempt.update(_failed_registration_debug(exc.debug))
            attempts.append(attempt)
            continue

        attempt = _orientation_attempt_payload(
            candidate,
            binary,
            "ok",
            normalization_debug=normalization_debug,
        )
        attempts.append(attempt)
        successes.append({
            "candidate": candidate,
            "binary": binary,
            "normalized": normalized,
            "normalization_debug": normalization_debug,
            "attempt": attempt,
        })

    if not successes:
        failure_reason = (
            "SIDEWAYS_CONTENT_CLIPPED"
            if _sideways_clipped_scan_detected(attempts)
            else "NO_ORIENTATION_CANDIDATE_REGISTERED"
        )
        failure_debug = {
            "prepared_pil_size": [int(target_size[0]), int(target_size[1])],
            "input_size_normalized": pil_image.size != target_size,
            "orientation_correction": None,
            "selected_orientation": None,
            "orientation_candidates": attempts,
            "page_registration_method": None,
            "page_registration_error": failure_reason,
            "scan_rejection_reason": failure_reason,
            "failure_preview_orientation": failure_preview_orientation,
        }
        if failure_preview_image is not None:
            failure_debug["_failure_preview_image"] = failure_preview_image
        if failure_preview_binary is not None:
            failure_debug["_failure_preview_binary"] = failure_preview_binary
        raise UnreadableSheetError(
            f"PAGE_REGISTRATION_FAILED:{failure_reason}",
            failure_debug,
        )

    def _success_key(item: dict[str, Any]) -> tuple[int, float, float, float, int]:
        attempt = item["attempt"]
        inliers = int(attempt.get("inliers") or 0)
        max_error = float(attempt.get("max_error") if attempt.get("max_error") is not None else 999999.0)
        mean_error = float(attempt.get("mean_error") if attempt.get("mean_error") is not None else 999999.0)
        candidate_source = item["candidate"].get("candidate_source")
        if candidate_source == "portrait_canvas_rotate_full":
            source_priority = 1
        elif candidate_source in {"content_box", "portrait_canvas_content_box"}:
            source_priority = 2
        else:
            source_priority = 0
        return (-inliers, float(source_priority), max_error, mean_error, int(item["candidate"]["order"]))

    selected = sorted(successes, key=_success_key)[0]
    candidate = selected["candidate"]
    prep_debug = {
        "prepared_pil_size": candidate["prepared_size"],
        "input_size_normalized": pil_image.size != target_size,
        "orientation_correction": candidate["orientation_correction"],
        "selected_orientation": candidate["orientation"],
        "orientation_candidates": attempts,
    }
    for key in (
        "candidate_source",
        "rotated_canvas_size",
        "post_rotation_content_bbox",
        "post_rotation_detected_content_bbox",
        "post_rotation_bbox_touches_edges",
        "prepared_image_source",
    ):
        if candidate.get(key) is not None:
            prep_debug[key] = candidate.get(key)
    return (
        selected["binary"],
        selected["normalized"],
        selected["normalization_debug"],
        prep_debug,
        candidate["image"],
    )


def _find_registration_marks(
    binary: "np.ndarray",
    min_area: int = REG_MARK_MIN_AREA,
    min_side: int = REG_MARK_MIN_SIDE,
    allow_clipped: bool = False,
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
        if allow_clipped:
            if not (0.25 <= aspect <= 4.0 and fill_ratio >= 0.65):
                continue
        elif not (0.7 <= aspect <= 1.3 and fill_ratio >= 0.55):
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


def _anchor_debug_payload(anchor: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "center": [
            round(float(anchor["center"][0]), 2),
            round(float(anchor["center"][1]), 2),
        ],
        "bbox": [int(v) for v in anchor.get("bbox", (0, 0, 0, 0))],
        "area": round(float(anchor.get("area", 0.0)), 2),
        "fill_ratio": round(float(anchor.get("fill_ratio", 0.0)), 3),
    }
    if "source" in anchor:
        payload["source"] = anchor["source"]
    if "template_index" in anchor:
        payload["template_index"] = int(anchor["template_index"])
    if "distance_to_expected" in anchor:
        payload["distance_to_expected"] = round(float(anchor["distance_to_expected"]), 2)
    return payload


def detect_anchor_candidates(binary: "np.ndarray") -> list[dict[str, Any]]:
    """Detect solid printed anchors without using paper-edge assumptions."""
    strict = _find_registration_marks(binary)
    relaxed = _find_registration_marks(binary, min_area=1600, min_side=26)
    candidates: list[dict[str, Any]] = []
    for anchor in strict:
        item = dict(anchor)
        item["source"] = "global"
        candidates.append(item)
    for anchor in relaxed:
        item = dict(anchor)
        item["source"] = "global_relaxed"
        candidates.append(item)
    return merge_anchor_candidates(candidates)


def detect_profile_guided_anchors(
    binary: "np.ndarray",
    profile: dict[str, Any],
) -> list[dict[str, Any]]:
    """Search locally around expected raw template anchors to recover missed marks."""
    raw_anchors = profile.get("raw_anchors") or []
    height, width = binary.shape[:2]
    guided: list[dict[str, Any]] = []
    radius = int(ANCHOR_GUIDED_SEARCH_RADIUS)
    for index, anchor in enumerate(raw_anchors):
        cx, cy = _anchor_center(anchor, "raw_anchors", index)
        x1 = max(0, int(round(cx)) - radius)
        y1 = max(0, int(round(cy)) - radius)
        x2 = min(width, int(round(cx)) + radius)
        y2 = min(height, int(round(cy)) + radius)
        if x2 <= x1 or y2 <= y1:
            continue
        crop = binary[y1:y2, x1:x2]
        local_marks = _find_registration_marks(crop, min_area=900, min_side=20)
        clipped_marks = _find_registration_marks(
            crop,
            min_area=800,
            min_side=18,
            allow_clipped=True,
        )
        local_marks = merge_anchor_candidates(local_marks, clipped_marks)
        for mark in local_marks:
            mx, my = mark["center"]
            abs_center = (float(mx) + x1, float(my) + y1)
            item = dict(mark)
            item["center"] = abs_center
            bx, by, bw, bh = mark["bbox"]
            item["bbox"] = (int(bx + x1), int(by + y1), int(bw), int(bh))
            item["source"] = "profile_guided"
            item["template_index"] = index
            item["distance_to_expected"] = float(np.hypot(abs_center[0] - cx, abs_center[1] - cy))
            guided.append(item)
    return merge_anchor_candidates(guided)


def merge_anchor_candidates(
    *candidate_lists: list[dict[str, Any]],
    dedupe_distance: float = ANCHOR_DEDUPE_DISTANCE,
) -> list[dict[str, Any]]:
    """Merge anchor candidates and remove nearby duplicates."""
    candidates = [candidate for group in candidate_lists for candidate in group]
    candidates.sort(
        key=lambda item: (
            -float(item.get("area", 0.0)),
            0 if item.get("source") == "profile_guided" else 1,
        )
    )
    merged: list[dict[str, Any]] = []
    for candidate in candidates:
        cx, cy = [float(v) for v in candidate["center"]]
        duplicate = False
        for existing in merged:
            ex, ey = [float(v) for v in existing["center"]]
            if float(np.hypot(cx - ex, cy - ey)) <= dedupe_distance:
                duplicate = True
                if existing.get("source") != "profile_guided" and candidate.get("source") == "profile_guided":
                    existing.update(candidate)
                break
        if not duplicate:
            merged.append(candidate)
    return merged


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
        "blank_reference_frame": "canonical_anchors",
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
    """Match detected anchors to template anchors with a global min-cost assignment."""
    matches, _debug = _match_template_anchors_with_debug(
        detected_anchors,
        template_anchors,
        max_distance=max_distance,
    )
    return matches


def _match_template_anchors_with_debug(
    detected_anchors: list[dict[str, Any]],
    template_anchors: list[dict[str, Any]],
    max_distance: float = 120.0,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    best_candidates: list[dict[str, Any]] = []
    options: dict[int, list[tuple[int, float]]] = {}
    for index, anchor in enumerate(template_anchors):
        target = anchor.get("center")
        if not isinstance(target, list | tuple) or len(target) != 2:
            options[index] = []
            best_candidates.append({
                "template_index": index,
                "template_center": None,
                "candidate_count": 0,
                "candidates": [],
            })
            continue
        tx, ty = float(target[0]), float(target[1])
        ranked: list[tuple[int, float]] = []
        for det_idx, detected in enumerate(detected_anchors):
            dx, dy = detected["center"]
            dist = float(np.hypot(float(dx) - tx, float(dy) - ty))
            if dist <= max_distance:
                ranked.append((det_idx, dist))
        ranked.sort(key=lambda item: item[1])
        options[index] = ranked[:8]
        best_candidates.append({
            "template_index": index,
            "template_center": [round(tx, 2), round(ty, 2)],
            "candidate_count": len(ranked),
            "candidates": [
                {
                    "candidate_index": det_idx,
                    "center": [
                        round(float(detected_anchors[det_idx]["center"][0]), 2),
                        round(float(detected_anchors[det_idx]["center"][1]), 2),
                    ],
                    "distance": round(float(dist), 2),
                    "source": detected_anchors[det_idx].get("source"),
                    "candidate_template_index": detected_anchors[det_idx].get("template_index"),
                }
                for det_idx, dist in ranked[:5]
            ],
        })

    template_order = sorted(
        range(len(template_anchors)),
        key=lambda index: (
            len(options.get(index, [])) == 0,
            len(options.get(index, [])),
            index,
        ),
    )
    best_pairs: list[tuple[int, int, float]] = []
    best_count = -1
    best_cost = float("inf")
    best_max_distance = float("inf")

    def _is_better(pairs: list[tuple[int, int, float]], cost: float, max_dist: float) -> bool:
        count = len(pairs)
        if count != best_count:
            return count > best_count
        if abs(cost - best_cost) > 1e-9:
            return cost < best_cost
        if abs(max_dist - best_max_distance) > 1e-9:
            return max_dist < best_max_distance
        return sorted((t, d) for t, d, _ in pairs) < sorted((t, d) for t, d, _ in best_pairs)

    def _search(
        order_index: int,
        used_candidates: set[int],
        pairs: list[tuple[int, int, float]],
        cost: float,
        max_dist: float,
    ) -> None:
        nonlocal best_pairs, best_count, best_cost, best_max_distance
        remaining = len(template_order) - order_index
        if len(pairs) + remaining < best_count:
            return
        if order_index >= len(template_order):
            if _is_better(pairs, cost, max_dist):
                best_pairs = list(pairs)
                best_count = len(pairs)
                best_cost = float(cost)
                best_max_distance = float(max_dist)
            return

        template_index = template_order[order_index]
        for det_idx, dist in options.get(template_index, []):
            if det_idx in used_candidates:
                continue
            used_candidates.add(det_idx)
            pairs.append((template_index, det_idx, dist))
            _search(
                order_index + 1,
                used_candidates,
                pairs,
                cost + dist,
                max(max_dist, dist),
            )
            pairs.pop()
            used_candidates.remove(det_idx)

        _search(order_index + 1, used_candidates, pairs, cost, max_dist)

    _search(0, set(), [], 0.0, 0.0)

    matches: list[dict[str, Any]] = []
    used_candidate_indices = {det_idx for _template_index, det_idx, _dist in best_pairs}
    for index, det_idx, dist in sorted(best_pairs, key=lambda item: item[0]):
        target = template_anchors[index].get("center")
        if not isinstance(target, list | tuple) or len(target) != 2:
            continue
        tx, ty = float(target[0]), float(target[1])
        detected = detected_anchors[det_idx]
        match = {
            "template_index": index,
            "template_center": [round(tx, 2), round(ty, 2)],
            "detected_center": [
                round(float(detected["center"][0]), 2),
                round(float(detected["center"][1]), 2),
            ],
            "distance": round(float(dist), 2),
            "candidate_index": det_idx,
        }
        if "source" in detected:
            match["candidate_source"] = detected["source"]
        if "template_index" in detected:
            match["candidate_template_index"] = int(detected["template_index"])
        matches.append({
            **match,
        })

    debug = {
        "assignment_method": "global_min_cost",
        "assignment_cost": round(float(best_cost), 2) if best_count > 0 else None,
        "assignment_max_distance": round(float(best_max_distance), 2) if best_count > 0 else None,
        "matched_anchor_count": len(matches),
        "rejected_candidate_count": max(0, len(detected_anchors) - len(used_candidate_indices)),
        "best_candidates": best_candidates,
    }
    return matches, debug


def _anchor_center(anchor: dict[str, Any], label: str, index: int) -> list[float]:
    center = anchor.get("center")
    if not isinstance(center, list | tuple) or len(center) != 2:
        raise UnreadableSheetError(
            f"TEMPLATE_PROFILE_INVALID: {label}[{index}] has no valid center."
        )
    return [float(center[0]), float(center[1])]


def _raw_to_canonical_anchor_matches(
    raw_matches: list[dict[str, Any]],
    canonical_anchors: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    canonical_matches: list[dict[str, Any]] = []
    for match in raw_matches:
        template_index = int(match["template_index"])
        if template_index < 0 or template_index >= len(canonical_anchors):
            raise UnreadableSheetError(
                f"TEMPLATE_PROFILE_INVALID: raw anchor index {template_index} has no canonical pair."
            )
        raw_center = match.get("template_center")
        canonical_center = _anchor_center(canonical_anchors[template_index], "anchors", template_index)
        canonical_matches.append({
            **match,
            "raw_template_center": raw_center,
            "canonical_template_center": [round(canonical_center[0], 2), round(canonical_center[1], 2)],
            "template_center": [round(canonical_center[0], 2), round(canonical_center[1], 2)],
        })
    return canonical_matches


def match_anchor_layout(
    candidates: list[dict[str, Any]],
    profile: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    raw_anchors = profile.get("raw_anchors") or []
    canonical_anchors = profile.get("anchors") or []
    raw_matches, assignment_debug = _match_template_anchors_with_debug(
        candidates,
        raw_anchors,
        max_distance=ANCHOR_MATCH_MAX_DISTANCE,
    )
    matches = _raw_to_canonical_anchor_matches(raw_matches, canonical_anchors)
    matched_indices = {int(match["template_index"]) for match in matches}
    unmatched = [
        index for index in range(len(raw_anchors))
        if index not in matched_indices
    ]
    debug = {
        "raw_anchor_count": len(raw_anchors),
        "canonical_anchor_count": len(canonical_anchors),
        "match_max_distance": ANCHOR_MATCH_MAX_DISTANCE,
        "unmatched_raw_anchor_indices": unmatched,
        "raw_matches": raw_matches,
        **assignment_debug,
    }
    return matches, debug


def validate_anchor_span(matches: list[dict[str, Any]]) -> dict[str, Any]:
    if not matches:
        raise UnreadableSheetError("TEMPLATE_ANCHOR_REGISTRATION_FAILED:NO_ANCHOR_MATCHES")
    xs = [float(match["template_center"][0]) for match in matches]
    ys = [float(match["template_center"][1]) for match in matches]
    x_span = max(xs) - min(xs)
    y_span = max(ys) - min(ys)
    x_ratio = x_span / max(1, CANON_W)
    y_ratio = y_span / max(1, CANON_H)
    debug = {
        "x_span": round(float(x_span), 3),
        "y_span": round(float(y_span), 3),
        "x_span_ratio": round(float(x_ratio), 4),
        "y_span_ratio": round(float(y_ratio), 4),
        "min_x_span_ratio": ANCHOR_MIN_X_SPAN_RATIO,
        "min_y_span_ratio": ANCHOR_MIN_Y_SPAN_RATIO,
        "accepted": bool(x_ratio >= ANCHOR_MIN_X_SPAN_RATIO and y_ratio >= ANCHOR_MIN_Y_SPAN_RATIO),
    }
    if not debug["accepted"]:
        raise UnreadableSheetError(
            "TEMPLATE_ANCHOR_REGISTRATION_FAILED:ANCHOR_SPAN_INSUFFICIENT",
            {"anchor_span": debug},
        )
    return debug


def _strict_anchor_homography(
    matches: list[dict[str, Any]],
    total_template_anchors: int,
    label: str,
) -> tuple["np.ndarray", dict[str, Any]]:
    required_inliers = min(PAGE_MIN_ANCHOR_INLIERS, max(4, total_template_anchors))
    if len(matches) < required_inliers:
        raise UnreadableSheetError(
            f"{label}_ANCHORS_MISSING: matched {len(matches)} anchor(s); need {required_inliers}."
        )

    src = np.float32([m["detected_center"] for m in matches])
    dst = np.float32([m["template_center"] for m in matches])
    matrix, inliers = cv2.findHomography(src, dst, cv2.RANSAC, PAGE_RANSAC_THRESHOLD)
    if matrix is None or inliers is None:
        raise UnreadableSheetError(f"{label}_ANCHORS_BAD_HOMOGRAPHY")

    inlier_mask = inliers.ravel().astype(bool)
    inlier_count = int(np.sum(inlier_mask))
    if inlier_count < required_inliers:
        raise UnreadableSheetError(
            f"{label}_ANCHORS_LOW_INLIERS:{inlier_count}/{total_template_anchors}"
        )

    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst, axis=1)
    inlier_errors = errors[inlier_mask]
    mean_error = float(np.mean(inlier_errors)) if len(inlier_errors) else float("inf")
    max_error = float(np.max(inlier_errors)) if len(inlier_errors) else float("inf")
    if mean_error > PAGE_MAX_MEAN_ERROR or max_error > PAGE_MAX_INLIER_ERROR:
        raise UnreadableSheetError(
            f"{label}_ANCHORS_LOW_CONFIDENCE:{inlier_count}/{total_template_anchors}:"
            f"{mean_error:.1f}:{max_error:.1f}"
        )

    enriched_matches: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        enriched = dict(match)
        if "canonical_template_center" not in enriched:
            enriched["canonical_template_center"] = enriched.get("template_center")
        enriched.update({
            "projected_center": [
                round(float(projected[index][0]), 2),
                round(float(projected[index][1]), 2),
            ],
            "error": round(float(errors[index]), 3),
            "inlier": bool(inlier_mask[index]),
        })
        enriched_matches.append(enriched)

    page_registration = {
        "method": label.lower(),
        "accepted": True,
        "inliers": inlier_count,
        "required_inliers": required_inliers,
        "total_template_anchors": int(total_template_anchors),
        "mean_error": round(mean_error, 3),
        "max_error": round(max_error, 3),
        "errors": [round(float(v), 3) for v in errors],
        "matches": enriched_matches,
    }
    return matrix, page_registration


def _project_registration_marks(
    marks: list[dict[str, Any]],
    matrix: "np.ndarray",
) -> list[dict[str, Any]]:
    pts = np.float32([[[float(m["center"][0]), float(m["center"][1])]] for m in marks])
    projected = cv2.perspectiveTransform(pts, matrix).reshape(-1, 2)
    projected_marks: list[dict[str, Any]] = []
    for mark, (cx, cy) in zip(marks, projected):
        projected_marks.append({
            "center": (float(cx), float(cy)),
            "bbox": mark.get("bbox", (0, 0, 0, 0)),
            "area": mark.get("area", 0.0),
            "fill_ratio": mark.get("fill_ratio", 0.0),
        })
    return projected_marks


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
    matrix, page_registration = _strict_anchor_homography(
        matches,
        len(template_anchors),
        "TEMPLATE",
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
        "coordinate_frame": "canonical_anchors",
        "blank_reference_frame": profile.get("blank_reference_frame", "canonical_anchors"),
        "page_registration_method": "template_anchor_homography",
        "page_registration_confidence": round(
            page_registration["inliers"] / max(1, page_registration["total_template_anchors"]),
            4,
        ),
        "page_registration_mean_error": page_registration["mean_error"],
        "page_registration_max_error": page_registration["max_error"],
        "page_registration": page_registration,
        "anchor_matches": page_registration["matches"],
    }
    return corrected, debug


# Debug/replay helper only. Production registration requires full-span anchors.
def _constrained_one_sided_anchor_warp(
    matches: list[dict[str, Any]],
    primary_axis: str,
) -> tuple["np.ndarray", dict[str, Any]]:
    """
    Compute a uniform-scale + translate affine (raw scan → canonical) when only
    one-sided anchors are available (left/right edge or top/bottom edge).

    `primary_axis` = "y" for left/right-edge anchors (y-span is well-measured).
    `primary_axis` = "x" for top/bottom-edge anchors (x-span is well-measured).

    Fits canonical = s * detected + t, with s from the primary axis span ratio,
    applied uniformly to both axes.  Rejects if max projected anchor residual
    exceeds ANCHOR_ONE_SIDED_MAX_RESIDUAL.
    """
    src_xs = np.array([m["detected_center"][0] for m in matches], dtype=np.float64)
    src_ys = np.array([m["detected_center"][1] for m in matches], dtype=np.float64)
    dst_xs = np.array([m["template_center"][0] for m in matches], dtype=np.float64)
    dst_ys = np.array([m["template_center"][1] for m in matches], dtype=np.float64)

    if primary_axis == "y":
        src_span = float(src_ys.max() - src_ys.min())
        dst_span = float(dst_ys.max() - dst_ys.min())
        edge_label = "left" if float(dst_xs.mean()) < CANON_W * 0.25 else "right"
    else:
        src_span = float(src_xs.max() - src_xs.min())
        dst_span = float(dst_xs.max() - dst_xs.min())
        edge_label = "top" if float(dst_ys.mean()) < CANON_H * 0.25 else "bottom"

    s = dst_span / src_span if src_span > 1.0 else 1.0
    tx = float(np.mean(dst_xs - s * src_xs))
    ty = float(np.mean(dst_ys - s * src_ys))

    proj_xs = s * src_xs + tx
    proj_ys = s * src_ys + ty
    errors = np.sqrt((proj_xs - dst_xs) ** 2 + (proj_ys - dst_ys) ** 2)
    mean_error = float(np.mean(errors))
    max_error = float(np.max(errors))

    if max_error > ANCHOR_ONE_SIDED_MAX_RESIDUAL:
        raise UnreadableSheetError(
            f"TEMPLATE_ANCHOR_REGISTRATION_FAILED:ONE_SIDED_RESIDUAL_TOO_LARGE:"
            f"{max_error:.1f}>{ANCHOR_ONE_SIDED_MAX_RESIDUAL}"
        )

    M = np.array([[s, 0.0, tx], [0.0, s, ty], [0.0, 0.0, 1.0]], dtype=np.float64)
    page_registration = {
        "method": "constrained_one_sided_anchor_affine",
        "accepted": True,
        "one_sided_axis": primary_axis,
        "one_sided_edge": edge_label,
        "scale": round(s, 6),
        "tx": round(tx, 3),
        "ty": round(ty, 3),
        "inliers": len(matches),
        "required_inliers": 3,
        "total_template_anchors": len(matches),
        "mean_error": round(mean_error, 3),
        "max_error": round(max_error, 3),
        "errors": [round(float(e), 3) for e in errors],
        "matches": matches,
    }
    return M, page_registration


def _apply_raw_template_anchor_normalization(
    binary: "np.ndarray",
    marks: list[dict[str, Any]],
    profile: dict[str, Any],
) -> tuple["np.ndarray | None", dict[str, Any]]:
    raw_anchors = profile.get("raw_anchors") or []
    canonical_anchors = profile.get("anchors") or []
    raw_size = profile.get("raw_size") or []
    if not raw_anchors or not canonical_anchors:
        raise UnreadableSheetError(
            "TEMPLATE_PROFILE_INVALID: raw_anchors and anchors are required."
        )
    if len(raw_anchors) != len(canonical_anchors):
        raise UnreadableSheetError(
            "TEMPLATE_PROFILE_INVALID: raw_anchors and anchors must have matching counts."
        )
    if raw_size != [int(binary.shape[1]), int(binary.shape[0])]:
        raise UnreadableSheetError(
            "TEMPLATE_PROFILE_INVALID: raw_size does not match current scan size."
        )

    global_candidates = [dict(mark, source=mark.get("source", "global")) for mark in marks]
    guided_candidates = detect_profile_guided_anchors(binary, profile)
    merged_candidates = merge_anchor_candidates(global_candidates, guided_candidates)
    matches, layout_debug = match_anchor_layout(merged_candidates, profile)
    anchor_detection_debug = {
        "global_candidate_count": len(global_candidates),
        "profile_guided_candidate_count": len(guided_candidates),
        "merged_candidate_count": len(merged_candidates),
        "matched_anchor_count": len(matches),
        "assignment_method": layout_debug["assignment_method"],
        "assignment_cost": layout_debug["assignment_cost"],
        "assignment_max_distance": layout_debug["assignment_max_distance"],
        "rejected_candidate_count": layout_debug["rejected_candidate_count"],
        "raw_anchor_count": layout_debug["raw_anchor_count"],
        "canonical_anchor_count": layout_debug["canonical_anchor_count"],
        "unmatched_anchor_count": len(layout_debug["unmatched_raw_anchor_indices"]),
        "global_anchor_candidates": [_anchor_debug_payload(mark) for mark in global_candidates],
        "profile_guided_candidates": [_anchor_debug_payload(mark) for mark in guided_candidates],
        "merged_candidates": [_anchor_debug_payload(mark) for mark in merged_candidates],
        "best_candidates": layout_debug["best_candidates"],
        "unmatched_raw_anchor_indices": layout_debug["unmatched_raw_anchor_indices"],
        "raw_matches": layout_debug["raw_matches"],
    }

    registration_attempts: list[dict[str, Any]] = []
    try:
        span_debug = validate_anchor_span(matches)
    except UnreadableSheetError as exc:
        message = str(exc)
        if not message.startswith("TEMPLATE_ANCHOR_REGISTRATION_FAILED"):
            message = f"TEMPLATE_ANCHOR_REGISTRATION_FAILED:{message}"
        failure_debug = {
            "fallback_policy": "template_profile_required",
            "fallback_disabled_reason": "template profile exists; partial-span registration is disabled",
            "anchor_detection": anchor_detection_debug,
            "anchor_matches": matches,
            "page_registration_error": str(exc),
            "page_registration_attempts": registration_attempts,
        }
        failure_debug.update(exc.debug)
        raise UnreadableSheetError(message, failure_debug) from exc

    try:
        matrix, page_registration = _strict_anchor_homography(
            matches,
            len(canonical_anchors),
            "TEMPLATE_RAW_TO_CANONICAL",
        )
        registration_attempts.append({
            "method": "raw_to_canonical_template_anchor_homography",
            "status": "ok",
            "inliers": page_registration["inliers"],
            "mean_error": page_registration["mean_error"],
            "max_error": page_registration["max_error"],
        })
    except UnreadableSheetError as exc:
        registration_attempts.append({
            "method": "raw_to_canonical_template_anchor_homography",
            "status": "failed",
            "error": str(exc),
        })
        message = str(exc)
        if not message.startswith("TEMPLATE_ANCHOR_REGISTRATION_FAILED"):
            message = f"TEMPLATE_ANCHOR_REGISTRATION_FAILED:{message}"
        failure_debug = {
            "fallback_policy": "template_profile_required",
            "fallback_disabled_reason": "template profile exists; four-corner page-edge and partial-span registration are disabled",
            "anchor_detection": anchor_detection_debug,
            "anchor_matches": matches,
            "anchor_span": span_debug,
            "page_registration_error": str(exc),
            "page_registration_attempts": registration_attempts,
        }
        failure_debug.update(exc.debug)
        raise UnreadableSheetError(message, failure_debug) from exc

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
        "coordinate_frame": "canonical_anchors",
        "blank_reference_frame": profile.get("blank_reference_frame", "canonical_anchors"),
        "page_registration_method": "raw_to_canonical_template_anchor_homography",
        "page_registration_confidence": round(
            page_registration["inliers"] / max(1, page_registration["total_template_anchors"]),
            4,
        ),
        "page_registration_mean_error": page_registration["mean_error"],
        "page_registration_max_error": page_registration["max_error"],
        "page_registration": page_registration,
        "page_registration_attempts": registration_attempts,
        "anchor_matches": page_registration["matches"],
        "anchor_detection": anchor_detection_debug,
        "anchor_span": span_debug,
        "fallback_policy": "template_profile_required",
    }
    return normalized, debug


def _apply_projected_template_anchor_correction(
    normalized: "np.ndarray",
    raw_marks: list[dict[str, Any]],
    raw_to_canonical: "np.ndarray",
    profile: dict[str, Any],
) -> tuple["np.ndarray", dict[str, Any]]:
    template_anchors = profile.get("anchors") or []
    if not template_anchors:
        raise UnreadableSheetError("TEMPLATE_ANCHORS_MISSING: no canonical anchors in profile.")

    projected_marks = _project_registration_marks(raw_marks, raw_to_canonical)
    matches = match_template_anchors(projected_marks, template_anchors, max_distance=90.0)
    correction, page_registration = _strict_anchor_homography(
        matches,
        len(template_anchors),
        "TEMPLATE_PROJECTED",
    )
    corrected = cv2.warpPerspective(
        normalized,
        correction,
        (CANON_W, CANON_H),
        flags=cv2.INTER_NEAREST,
        borderValue=0,
    )
    debug = {
        "template_version": profile.get("template_version", TEMPLATE_VERSION),
        "template_profile_loaded": bool(profile.get("profile_loaded")),
        "coordinate_frame": "canonical_anchors",
        "blank_reference_frame": profile.get("blank_reference_frame", "canonical_anchors"),
        "page_registration_method": "four_corner_projected_anchor_homography",
        "page_registration_confidence": round(
            page_registration["inliers"] / max(1, page_registration["total_template_anchors"]),
            4,
        ),
        "page_registration_mean_error": page_registration["mean_error"],
        "page_registration_max_error": page_registration["max_error"],
        "page_registration": page_registration,
        "anchor_matches": page_registration["matches"],
    }
    return corrected, debug


def normalize_scan(
    binary: "np.ndarray",
    use_template_profile: bool = True,
) -> tuple["np.ndarray", dict[str, Any]]:
    """Warp any ES-50 output into the canonical half-A4 OMR coordinate space."""
    marks = detect_anchor_candidates(binary)
    profile = load_template_profile(include_image=False) if use_template_profile else {}

    debug_base = {
        "canonical_size": [CANON_W, CANON_H],
        "raw_size": [int(binary.shape[1]), int(binary.shape[0])],
        "registration_mark_method": "anchor_candidates",
        "fallback_policy": "template_profile_required" if use_template_profile else "calibration_four_corner",
        "mark_candidates": [_anchor_debug_payload(m) for m in marks],
    }

    if use_template_profile:
        try:
            raw_normalized, raw_profile_debug = _apply_raw_template_anchor_normalization(
                binary, marks, profile,
            )
            if raw_normalized is not None:
                debug_base["registration_mark_method"] = "raw_to_canonical_template_anchor_homography"
                debug_base.update(raw_profile_debug)
                return raw_normalized, debug_base
        except UnreadableSheetError as exc:
            debug_base["page_registration_primary_error"] = str(exc)
            debug_base["fallback_disabled_reason"] = (
                "template profile exists; four-corner page-edge registration is disabled"
            )
            debug_base.update(exc.debug)
            raise UnreadableSheetError(str(exc), debug_base) from exc

        debug_base["page_registration_primary_error"] = "TEMPLATE_ANCHOR_REGISTRATION_FAILED:NO_NORMALIZED_OUTPUT"
        debug_base["fallback_disabled_reason"] = (
            "template profile exists; four-corner page-edge registration is disabled"
        )
        raise UnreadableSheetError(
            "TEMPLATE_ANCHOR_REGISTRATION_FAILED:NO_NORMALIZED_OUTPUT",
            debug_base,
        )

    # Calibration-only path: classic four-corner perspective transform.
    # If the primary homography path failed and we still have fewer than 4 marks,
    # fail hard — substituting template positions as scan positions is semantically
    # wrong and produces silently mis-warped output.
    if len(marks) < 4:
        raise UnreadableSheetError(
            f"REGISTRATION_MARKS_MISSING: only {len(marks)} mark(s) found; need 4."
        )

    tl, tr, br, bl = _choose_registration_corners(marks)

    debug_base["registration_mark_method"] = "four_corner_calibration"
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
    cells = grid.get("cell_centers")
    if cells is not None:
        # per-bubble live centres from align_section_to_template
        cx, cy = cells[col][row]
        return int(round(cx)), int(round(cy))
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


def _template_bubble_center(grid: dict[str, Any], col: int, row: int) -> tuple[int, int]:
    if "template_x_centers" not in grid and "template_y_centers" not in grid:
        return _bubble_center(grid, col, row)
    x_values = grid.get("template_x_centers", grid.get("x_centers"))
    y_values = grid.get("template_y_centers", grid.get("y_centers"))
    if x_values is not None:
        cx = int(round(float(x_values[col])))
    else:
        ox, _ = grid["origin_center"]
        cx = int(round(float(ox) + col * float(grid["x_pitch"])))
    if y_values is not None:
        cy = int(round(float(y_values[row])))
    else:
        oy = grid.get("template_y_origin", grid.get("y_origin"))
        cy = int(round(float(oy) + row * float(grid["y_pitch"])))
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


def _padded_bool_patch(image: "np.ndarray", cx: int, cy: int, radius: int) -> "np.ndarray":
    size = radius * 2 + 1
    patch = np.zeros((size, size), dtype=bool)
    x1 = max(0, cx - radius)
    y1 = max(0, cy - radius)
    x2 = min(image.shape[1], cx + radius + 1)
    y2 = min(image.shape[0], cy + radius + 1)
    if x1 >= x2 or y1 >= y2:
        return patch

    dx1 = x1 - (cx - radius)
    dy1 = y1 - (cy - radius)
    dx2 = dx1 + (x2 - x1)
    dy2 = dy1 + (y2 - y1)
    patch[dy1:dy2, dx1:dx2] = image[y1:y2, x1:x2] > 127
    return patch


def blank_corrected_fill_ratio(
    warped: "np.ndarray",
    blank_reference: "np.ndarray | None",
    cx: int,
    cy: int,
    radius: int,
    template_cx: int | None = None,
    template_cy: int | None = None,
) -> float:
    """Return fill ratio after subtracting the corresponding blank-template bubble."""
    if blank_reference is None:
        return _bubble_fill_ratio(warped, cx, cy, radius)

    tcx = cx if template_cx is None else template_cx
    tcy = cy if template_cy is None else template_cy
    crop = _padded_bool_patch(warped, cx, cy, radius)
    blank_crop = _padded_bool_patch(blank_reference, tcx, tcy, radius)
    blank_crop = cv2.dilate(
        blank_crop.astype("uint8"),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    ) > 0

    yy, xx = np.ogrid[:radius * 2 + 1, :radius * 2 + 1]
    mask = (xx - radius) ** 2 + (yy - radius) ** 2 <= radius ** 2
    total = int(np.sum(mask))
    if total == 0:
        return 0.0

    filled = int(np.sum(crop & ~blank_crop & mask))
    return filled / total


def bubble_mark_ratio(
    warped: "np.ndarray",
    blank_reference: "np.ndarray | None",
    cx: int,
    cy: int,
    radius: int,
    template_cx: int | None = None,
    template_cy: int | None = None,
) -> float:
    """
    How much of the bubble's interior is pencil, robust to small misalignment.

    Only the inner MARK_INNER_RADIUS of the bubble is measured (the printed
    outline sits outside it), the blank template's ink (letter / digit glyph) is
    subtracted, and the sample is nudged by up to MARK_NUDGE_FRACTION of the radius,
    keeping the lowest reading: a real fill stays dark wherever it is sampled,
    while a slightly misaligned outline or glyph only reads dark at some offsets.
    """
    if blank_reference is None:
        return _bubble_fill_ratio(warped, cx, cy, radius)

    tcx = cx if template_cx is None else template_cx
    tcy = cy if template_cy is None else template_cy
    ri = max(3, int(round(radius * MARK_INNER_RADIUS)))
    blank_crop = cv2.dilate(
        _padded_bool_patch(blank_reference, tcx, tcy, ri).astype("uint8"),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MARK_BLANK_DILATE_PX, MARK_BLANK_DILATE_PX)),
        iterations=1,
    ) > 0
    yy, xx = np.ogrid[:ri * 2 + 1, :ri * 2 + 1]
    mask = ((xx - ri) ** 2 + (yy - ri) ** 2 <= ri ** 2) & ~blank_crop
    total = int(np.sum(mask))
    if total == 0:
        return 0.0

    nudge = max(1, int(round(radius * MARK_NUDGE_FRACTION)))
    big = _padded_bool_patch(warped, cx, cy, ri + nudge)
    size = ri * 2 + 1
    lowest = 1.0
    for oy in range(0, 2 * nudge + 1):
        for ox in range(0, 2 * nudge + 1):
            filled = int(np.sum(big[oy:oy + size, ox:ox + size] & mask))
            lowest = min(lowest, filled / total)
            if lowest == 0.0:
                return 0.0
    return lowest


def _match_shift(
    live: "np.ndarray",
    blank: "np.ndarray",
    box: tuple[int, int, int, int],
    search: int,
    base: tuple[int, int] = (0, 0),
) -> tuple[int, int, float]:
    """Shift (dx, dy) that best lines up blank[box] with the live scan, searched around base."""
    x1, y1, x2, y2 = box
    h, w = live.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(blank.shape[1], x2), min(blank.shape[0], y2)
    if x2 - x1 < 8 or y2 - y1 < 8:
        return base[0], base[1], 0.0
    tmpl = blank[y1:y2, x1:x2].astype(np.float32)
    bx, by = base
    sx1, sy1 = x1 + bx - search, y1 + by - search
    sx2, sy2 = x2 + bx + search, y2 + by + search
    pad = max(0, -sx1, -sy1, sx2 - w, sy2 - h)
    src = cv2.copyMakeBorder(live, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0) if pad else live
    region = src[sy1 + pad:sy2 + pad, sx1 + pad:sx2 + pad].astype(np.float32)
    if float(tmpl.std()) == 0.0 or float(region.std()) == 0.0:
        return bx, by, 0.0
    res = cv2.matchTemplate(region, tmpl, cv2.TM_CCOEFF_NORMED)
    _, score, _, loc = cv2.minMaxLoc(res)
    return bx + loc[0] - search, by + loc[1] - search, float(score)


def _align_units(
    live: "np.ndarray",
    blank: "np.ndarray",
    boxes: list[tuple[int, int, int, int]],
    section_shift: tuple[int, int],
) -> tuple["np.ndarray", list[float]]:
    """
    Line up each unit (a row or column of bubbles) with the blank template.

    The sheet's distortion changes smoothly across a section, so each unit is
    searched around the previous unit's shift plus the running trend, from both
    ends; weak or outlying matches are replaced by a straight-line fit.
    Returns the per-unit (dx, dy) and the per-unit match scores.
    """
    n = len(boxes)

    def track(order: range) -> dict[int, tuple[int, int, float]]:
        found: dict[int, tuple[int, int, float]] = {}
        prev: "np.ndarray | None" = None
        trend = np.zeros(2)
        for k in order:
            if prev is None:
                base, search = section_shift, ALIGN_UNIT_SEARCH_PX + 10
            else:
                base = (int(round(prev[0] + trend[0])), int(round(prev[1] + trend[1])))
                search = ALIGN_UNIT_SEARCH_PX
            dx, dy, score = _match_shift(live, blank, boxes[k], search, base)
            here = np.array([dx, dy], dtype=float)
            if prev is not None and score >= ALIGN_MIN_MATCH:
                trend = 0.5 * trend + 0.5 * (here - prev)
            if score >= ALIGN_MIN_MATCH or prev is None:
                prev = here
            else:
                prev = prev + trend
            found[k] = (dx, dy, score)
        return found

    forward = track(range(n))
    backward = track(range(n - 1, -1, -1))
    picks = [forward[k] if forward[k][2] >= backward[k][2] else backward[k] for k in range(n)]
    shifts = np.array([[p[0], p[1]] for p in picks], dtype=float)
    scores = [float(p[2]) for p in picks]

    good = np.array([s >= ALIGN_MIN_MATCH for s in scores])
    if good.sum() >= 3:
        idx = np.arange(n, dtype=float)
        fit = np.zeros_like(shifts)
        for d in range(2):
            coeffs = np.polyfit(idx[good], shifts[good, d], 1)
            fit[:, d] = np.polyval(coeffs, idx)
        for k in range(n):
            if not good[k] or np.max(np.abs(shifts[k] - fit[k])) > ALIGN_MAX_DEVIATION_PX:
                shifts[k] = fit[k]
    return shifts, scores


def align_section_to_template(
    scan: "np.ndarray",
    blank_reference: "np.ndarray",
    template_grid: dict[str, Any],
    section_name: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Find where every bubble of a section actually is on the scan.

    The whole section is matched against the blank template first, then each
    row (and, for the digit grids, each column) is matched on its own, so
    uneven feeding / stretching of the paper is followed bubble row by row.
    Returns a grid whose "cell_centers" give each bubble's live centre (template
    centres stay in template_x/y_centers for blank subtraction) and alignment
    diagnostics. meta["ok"] is False when too few rows matched to trust it.
    """
    xs = [float(v) for v in template_grid["x_centers"]]
    ys = [float(v) for v in template_grid["y_centers"]]
    r = int(template_grid["bubble_radius"])
    m = r + 10
    section_box = (int(xs[0]) - r - 12, int(ys[0]) - r - 12, int(xs[-1]) + r + 12, int(ys[-1]) + r + 12)
    sdx, sdy, section_score = _match_shift(scan, blank_reference, section_box, ALIGN_SECTION_SEARCH_PX)

    row_boxes = [(int(xs[0]) - m, int(y) - m, int(xs[-1]) + m, int(y) + m) for y in ys]
    row_shifts, row_scores = _align_units(scan, blank_reference, row_boxes, (sdx, sdy))
    scores = list(row_scores)
    if section_name.startswith("answers"):
        cells = [[[x + row_shifts[i][0], y + row_shifts[i][1]] for i, y in enumerate(ys)] for x in xs]
    else:
        # digit grids are tall: x offset per column, y offset per row
        col_boxes = [(int(x) - m, int(ys[0]) - m, int(x) + m, int(ys[-1]) + m) for x in xs]
        col_shifts, col_scores = _align_units(scan, blank_reference, col_boxes, (sdx, sdy))
        scores += col_scores
        # Each bubble: its column's shift plus how its row differs from the
        # average row (and vice versa), so a slightly sheared / rotated sheet
        # is followed in both directions.
        row_mean = row_shifts.mean(axis=0)
        col_mean = col_shifts.mean(axis=0)
        cells = [
            [
                [
                    x + col_shifts[c][0] + (row_shifts[i][0] - row_mean[0]),
                    y + row_shifts[i][1] + (col_shifts[c][1] - col_mean[1]),
                ]
                for i, y in enumerate(ys)
            ]
            for c, x in enumerate(xs)
        ]

    # Final per-bubble snap: line each bubble up with its own printed outline.
    # An empty bubble matches the template closely; a filled one doesn't, and
    # keeps the row/column estimate (a fill reads dark anywhere near it anyway).
    pad = r + 6
    snapped = 0
    for c, x in enumerate(xs):
        for i, y in enumerate(ys):
            ex, ey = cells[c][i]
            base = (int(round(ex - x)), int(round(ey - y)))
            box = (int(x) - pad, int(y) - pad, int(x) + pad + 1, int(y) + pad + 1)
            dx, dy, score = _match_shift(scan, blank_reference, box, ALIGN_BUBBLE_SEARCH_PX, base)
            if score >= ALIGN_BUBBLE_MIN_MATCH:
                cells[c][i] = [x + dx, y + dy]
                snapped += 1

    grid = dict(template_grid)
    grid["cell_centers"] = cells
    grid["template_x_centers"] = xs
    grid["template_y_centers"] = ys
    matched = sum(1 for s in scores if s >= ALIGN_MIN_MATCH)
    meta = {
        "section": section_name,
        "method": "local_template_alignment",
        "section_shift": [int(sdx), int(sdy)],
        "section_match": round(float(section_score), 3),
        "unit_matches": [round(s, 3) for s in scores],
        "units_matched": matched,
        "units_total": len(scores),
        "bubbles_snapped": snapped,
        "ok": matched >= max(3, int(0.6 * len(scores))),
    }
    return grid, meta


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
        ratios: list[tuple[int, float, tuple[int, int], tuple[int, int]]] = []
        for row in range(rows):
            cx, cy = _bubble_center(grid, col, row)
            tx, ty = _template_bubble_center(grid, col, row)
            ratio = bubble_mark_ratio(
                warped,
                blank_reference,
                cx,
                cy,
                radius,
                tx,
                ty,
            )
            ratios.append((row, ratio, (cx, cy), (tx, ty)))

        ranked = sorted(ratios, key=lambda item: item[1], reverse=True)
        best_digit, best_ratio, best_center, best_template_center = ranked[0]
        second_digit, second_ratio, _, _ = ranked[1] if len(ranked) > 1 else (None, 0.0, (0, 0), (0, 0))
        gap = best_ratio - second_ratio
        accepted = False
        low_confidence = False
        reason = "accepted"

        if best_ratio < DIGIT_MARK_RATIO:
            reason = "below_min_ratio"
        elif second_ratio >= DIGIT_MARK_RATIO:
            # two digits shaded in one column: the code can't be trusted
            reason = "double_mark"
            flags.append(f"DOUBLE_MARK_{flag_prefix}_COL_{col + 1}")
        else:
            accepted = True
            if gap < MARK_CLEAR_GAP:
                low_confidence = True
                flags.append(f"LOW_CONFIDENCE_{flag_prefix}_COL_{col + 1}")
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
            "template_center": [
                int(best_template_center[0]),
                int(best_template_center[1]),
            ],
        }
        if digit_decisions is not None:
            digit_decisions.append(decision)

        for row, ratio, (cx, cy), (tx, ty) in ratios:
            is_best = row == best_digit
            if debug_samples is not None:
                debug_samples.append({
                    "group": name,
                    "col": col,
                    "row": row,
                    "digit": row,
                    "center": [cx, cy],
                    "live_center": [cx, cy],
                    "template_center": [tx, ty],
                    "radius": radius,
                    "ratio": round(ratio, 4),
                    "above_fill_threshold": ratio > FILL_THRESHOLD,
                    "best_candidate": is_best,
                    "filled": accepted and is_best,
                    "ratio_method": "inner_nudged_blank_corrected" if blank_reference is not None else "raw",
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
        row_ratios: list[tuple[int, float, int, int, int, int]] = []
        for col in range(4):
            cx, cy = _bubble_center(grid, col, row)
            tx, ty = _template_bubble_center(grid, col, row)
            ratio = bubble_mark_ratio(
                warped,
                blank_reference,
                cx,
                cy,
                radius,
                tx,
                ty,
            )
            row_ratios.append((col, ratio, cx, cy, tx, ty))

        ranked = sorted(row_ratios, key=lambda t: t[1], reverse=True)
        best_col, best_ratio, best_cx, best_cy, best_tx, best_ty = ranked[0]
        second_ratio = ranked[1][1] if len(ranked) > 1 else 0.0
        gap = best_ratio - second_ratio

        accepted = False
        low_conf = False
        reason = "accepted"

        if best_ratio < ANSWER_MARK_RATIO:
            answer = None
            reason = "below_min_ratio"
            if max_item is None or item_num <= max_item:
                flags.append(f"NO_ANSWER_Q{item_num}")
        elif second_ratio >= ANSWER_MARK_RATIO:
            # Two bubbles shaded: the item is simply wrong (no answer letter, so
            # grade() gives it no point). It is not flagged for review.
            answer = None
            reason = "double_mark"
        else:
            accepted = True
            answer = ANSWER_LETTERS[best_col]
            low_conf = gap < MARK_CLEAR_GAP
            if low_conf and (max_item is None or item_num <= max_item):
                flags.append(f"LOW_CONFIDENCE_ANSWER_Q{item_num}")
                reason = "low_confidence"

        answers.append(answer)

        if debug_samples is not None:
            for col, ratio, cx, cy, tx, ty in row_ratios:
                is_winner = col == best_col
                debug_samples.append({
                    "group": name,
                    "item": item_num,
                    "col": col,
                    "letter": ANSWER_LETTERS[col],
                    "center": [cx, cy],
                    "live_center": [cx, cy],
                    "template_center": [tx, ty],
                    "radius": radius,
                    "ratio": round(ratio, 4),
                    "filled": accepted and is_winner,
                    "gap": round(gap, 4) if is_winner else None,
                    "best_ratio": round(best_ratio, 4) if is_winner else None,
                    "second_ratio": round(second_ratio, 4) if is_winner else None,
                    "low_confidence": low_conf if is_winner else None,
                    "decision_reason": reason if is_winner else None,
                    "ratio_method": "inner_nudged_blank_corrected" if blank_reference is not None else "raw",
                })

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


def _expanded_roi(
    roi: tuple[int, int, int, int] | list[int],
    margin: int,
    shape: tuple[int, int],
) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = [int(v) for v in roi]
    height, width = shape[:2]
    return (
        max(0, x1 - margin),
        max(0, y1 - margin),
        min(width, x2 + margin),
        min(height, y2 + margin),
    )


def _section_match_translation(
    scan: "np.ndarray",
    blank_reference: "np.ndarray",
    section_name: str,
    template_grid: dict[str, Any],
) -> tuple[float, float, float, dict[str, Any]]:
    spec = SECTION_SPECS[section_name]
    x1, y1, x2, y2 = [int(v) for v in spec["roi"]]
    sx1, sy1, sx2, sy2 = _expanded_roi(spec["roi"], SECTION_SEARCH_MARGIN, scan.shape)
    template = blank_reference[y1:y2, x1:x2].astype("uint8")
    search = scan[sy1:sy2, sx1:sx2].astype("uint8")
    if template.size == 0 or search.size == 0:
        raise SectionRegistrationError(f"{section_name}: empty template-match ROI")
    if search.shape[0] < template.shape[0] or search.shape[1] < template.shape[1]:
        raise SectionRegistrationError(f"{section_name}: search ROI smaller than template ROI")

    mask = np.full(template.shape, 255, dtype=np.uint8)
    radius = int(template_grid["bubble_radius"])
    for row in range(int(template_grid["rows"])):
        for col in range(int(template_grid["cols"])):
            tx, ty = _template_bubble_center(template_grid, col, row)
            cv2.circle(mask, (tx - x1, ty - y1), radius + 5, 0, -1)

    method = "masked_ccorr"
    try:
        result = cv2.matchTemplate(search, template, cv2.TM_CCORR_NORMED, mask=mask)
        result = np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)
    except Exception:
        method = "ccoeff"
        result = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
        result = np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)

    _min_val, max_val, _min_loc, max_loc = cv2.minMaxLoc(result)
    if max_val <= 0.0:
        method = "ccoeff"
        result = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
        result = np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)
        _min_val, max_val, _min_loc, max_loc = cv2.minMaxLoc(result)
    dx = float(sx1 + max_loc[0] - x1)
    dy = float(sy1 + max_loc[1] - y1)
    diagnostics = {
        "method": method,
        "score": round(float(max_val), 4),
        "translation": [round(dx, 3), round(dy, 3)],
        "roi": [x1, y1, x2, y2],
        "search_roi": [sx1, sy1, sx2, sy2],
    }
    return dx, dy, float(max_val), diagnostics


def _translated_template_grid(
    template_grid: dict[str, Any],
    dx: float,
    dy: float,
) -> dict[str, Any]:
    template_x = _grid_x_centers(template_grid)
    template_y = _grid_y_centers(template_grid)
    grid = dict(template_grid)
    grid.update({
        "template_x_centers": [round(v, 2) for v in template_x],
        "template_y_centers": [round(v, 2) for v in template_y],
        "template_y_origin": round(template_y[0], 2),
        "x_centers": [round(v + dx, 2) for v in template_x],
        "y_centers": [round(v + dy, 2) for v in template_y],
        "y_origin": round(template_y[0] + dy, 2),
        "registration_method": "template_match",
    })
    return grid


def _axis_drifts(
    live_values: list[float],
    coarse_values: list[float],
) -> list[float]:
    return [
        float(live) - float(coarse)
        for live, coarse in zip(live_values, coarse_values)
    ]


def _max_abs(values: list[float]) -> float:
    return max((abs(float(v)) for v in values), default=0.0)


def _max_adjacent_jump(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    return max(
        abs(float(values[index + 1]) - float(values[index]))
        for index in range(len(values) - 1)
    )


def _live_lattice_drift_debug(
    section_name: str,
    live_grid: dict[str, Any],
    coarse_grid: dict[str, Any],
) -> dict[str, Any]:
    live_x = _grid_x_centers(live_grid)
    live_y = _grid_y_centers(live_grid)
    coarse_x = _grid_x_centers(coarse_grid)
    coarse_y = _grid_y_centers(coarse_grid)

    if len(live_x) != len(coarse_x) or len(live_y) != len(coarse_y):
        raise SectionRegistrationError(
            f"{section_name}: live lattice dimensions do not match template grid"
        )

    col_drifts = _axis_drifts(live_x, coarse_x)
    row_drifts = _axis_drifts(live_y, coarse_y)
    max_col_drift = _max_abs(col_drifts)
    max_row_drift = _max_abs(row_drifts)
    max_col_jump = _max_adjacent_jump(col_drifts)
    max_row_jump = _max_adjacent_jump(row_drifts)

    x_axis_accepted = bool(
        max_col_drift <= SECTION_MAX_LIVE_DRIFT
        and max_col_jump <= SECTION_MAX_LIVE_DRIFT_JUMP
    )
    y_axis_accepted = bool(
        max_row_drift <= SECTION_MAX_LIVE_DRIFT
        and max_row_jump <= SECTION_MAX_LIVE_DRIFT_JUMP
    )

    return {
        "col_drifts_px": [round(float(v), 3) for v in col_drifts],
        "row_drifts_px": [round(float(v), 3) for v in row_drifts],
        "max_col_drift_px": round(float(max_col_drift), 3),
        "max_row_drift_px": round(float(max_row_drift), 3),
        "max_col_drift_jump_px": round(float(max_col_jump), 3),
        "max_row_drift_jump_px": round(float(max_row_jump), 3),
        "max_allowed_drift_px": SECTION_MAX_LIVE_DRIFT,
        "max_allowed_drift_jump_px": SECTION_MAX_LIVE_DRIFT_JUMP,
        "x_axis_accepted": x_axis_accepted,
        "y_axis_accepted": y_axis_accepted,
        "accepted": bool(x_axis_accepted and y_axis_accepted),
    }


def _section_lattice_metrics(
    candidates: list[dict[str, Any]],
    x_centers: list[float],
    y_centers: list[float],
    spec: dict[str, Any],
) -> dict[str, Any]:
    cells: dict[tuple[int, int], float] = {}
    max_dx = max(20.0, float(spec["x_gap"]) * 0.75)
    max_dy = max(20.0, float(spec["y_gap"]) * 0.75)
    for candidate in candidates:
        cx, cy = [float(v) for v in candidate["center"]]
        col = _nearest_index(x_centers, cx)
        row = _nearest_index(y_centers, cy)
        dx = abs(cx - x_centers[col])
        dy = abs(cy - y_centers[row])
        if dx <= max_dx and dy <= max_dy:
            distance = float(np.hypot(dx, dy))
            key = (col, row)
            if key not in cells or distance < cells[key]:
                cells[key] = distance

    expected = max(1, len(x_centers) * len(y_centers))
    distances = list(cells.values())
    return {
        "coverage": len(cells) / expected,
        "residual_px": float(np.mean(distances)) if distances else float("inf"),
        "max_residual_px": float(np.max(distances)) if distances else float("inf"),
        "matched_cells": len(cells),
        "expected_cells": expected,
    }


def _phase_shift_section_diagnostics(
    scan: "np.ndarray",
    blank_ref: "np.ndarray",
    roi: tuple[int, int, int, int] | list[int],
    bubble_centers: "list[tuple[float, float]]",
    bubble_radius: int,
) -> dict[str, Any]:
    x1, y1, x2, y2 = [int(v) for v in roi]
    crop = scan[y1:y2, x1:x2].astype(np.float32)
    blank = blank_ref[y1:y2, x1:x2].astype(np.float32)
    mask = np.zeros(crop.shape, dtype=np.uint8)
    for cx, cy in bubble_centers:
        cv2.circle(
            mask,
            (int(round(cx)) - x1, int(round(cy)) - y1),
            bubble_radius + 4,
            255,
            -1,
        )
    crop[mask > 0] = 0.0
    blank[mask > 0] = 0.0
    (dx, dy), response = cv2.phaseCorrelate(blank, crop)
    reason = "accepted"
    accepted = True
    if response < PHASE_CORR_MIN_RESPONSE:
        accepted = False
        reason = "low_response"
    elif abs(dx) > PHASE_CORR_MAX_SHIFT or abs(dy) > PHASE_CORR_MAX_SHIFT:
        accepted = False
        reason = "shift_exceeds_cap"
    return {
        "dx": round(float(dx), 3),
        "dy": round(float(dy), 3),
        "response": round(float(response), 4),
        "accepted": accepted,
        "reason": reason,
    }


def register_section(
    normalized: "np.ndarray",
    section_name: str,
    profile: dict[str, Any] | None,
    blank_reference: "np.ndarray | None",
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Register a section by aligning the calibrated blank-template section to live scan."""
    if blank_reference is None:
        raise SectionRegistrationError(f"{section_name}: blank template reference missing")

    spec = SECTION_SPECS[section_name]
    template_grid = _profile_section_grid(profile, section_name)
    dx, dy, match_score, match_diag = _section_match_translation(
        normalized,
        blank_reference,
        section_name,
        template_grid,
    )
    if match_score < SECTION_MIN_MATCH_SCORE:
        raise SectionRegistrationError(
            f"{section_name}: low section template score ({match_score:.3f})"
        )
    if max(abs(dx), abs(dy)) > SECTION_MAX_TRANSLATION:
        raise SectionRegistrationError(
            f"{section_name}: section translation exceeds cap ({dx:.1f},{dy:.1f})"
        )

    coarse_grid = _translated_template_grid(template_grid, dx, dy)
    expanded_spec = dict(spec)
    expanded_spec["roi"] = _expanded_roi(spec["roi"], SECTION_SEARCH_MARGIN, normalized.shape)
    candidates = _component_candidates(normalized, expanded_spec)
    coarse_metrics = _section_lattice_metrics(
        candidates,
        _grid_x_centers(coarse_grid),
        _grid_y_centers(coarse_grid),
        expanded_spec,
    )
    section_min_cov = float(spec.get("min_coverage", SECTION_MIN_COVERAGE))
    if coarse_metrics["coverage"] < section_min_cov:
        raise SectionRegistrationError(
            f"{section_name}: low template-grid coverage ({coarse_metrics['coverage']:.2f})"
        )
    if coarse_metrics["residual_px"] > SECTION_MAX_RESIDUAL:
        raise SectionRegistrationError(
            f"{section_name}: high template-grid residual ({coarse_metrics['residual_px']:.1f}px)"
        )

    live_lattice_meta: dict[str, Any] = {}
    live_lattice_fallback_reason: str | None = None
    try:
        live_grid, live_lattice_meta = refine_section_geometry(normalized, section_name, profile)
        base_x_pitch = float(template_grid.get("x_pitch") or 0.0)
        base_y_pitch = float(template_grid.get("y_pitch") or 0.0)
        x_delta = abs(float(live_lattice_meta["x_pitch"]) - base_x_pitch) / base_x_pitch if base_x_pitch else 0.0
        y_delta = abs(float(live_lattice_meta["y_pitch"]) - base_y_pitch) / base_y_pitch if base_y_pitch else 0.0
        pitch_delta = max(x_delta, y_delta)
    except SectionRegistrationError as exc:
        # Live lattice detection failed (e.g. one bubble column outside the base ROI due to
        # lateral paper shift). Fall back to the coarse template-match grid, which already
        # passed coverage and residual validation above. This avoids losing an entire section
        # just because the fine lattice step couldn't cluster all columns.
        logger.warning("%s: live lattice failed (%s) — using coarse grid", section_name, exc)
        live_grid = coarse_grid
        pitch_delta = 0.0
        live_lattice_fallback_reason = str(exc)

    if pitch_delta > SECTION_MAX_PITCH_DELTA:
        raise SectionRegistrationError(
            f"{section_name}: pitch delta exceeds cap ({pitch_delta:.3f})"
        )

    template_x = _grid_x_centers(template_grid)
    template_y = _grid_y_centers(template_grid)
    live_x = _grid_x_centers(live_grid)
    live_y = _grid_y_centers(live_grid)
    coarse_x = _grid_x_centers(coarse_grid)
    coarse_y = _grid_y_centers(coarse_grid)
    drift_debug = _live_lattice_drift_debug(section_name, live_grid, coarse_grid)
    if not drift_debug["y_axis_accepted"]:
        raise SectionRegistrationError(
            f"{section_name}: live lattice drift exceeds cap "
            f"({drift_debug['max_col_drift_px']:.1f},{drift_debug['max_row_drift_px']:.1f})"
        )

    final_x = live_x if drift_debug["x_axis_accepted"] else coarse_x
    final_y = live_y
    final_metrics = _section_lattice_metrics(
        candidates,
        final_x,
        final_y,
        expanded_spec,
    )
    if final_metrics["coverage"] < section_min_cov:
        raise SectionRegistrationError(
            f"{section_name}: low live-grid coverage ({final_metrics['coverage']:.2f})"
        )
    if final_metrics["residual_px"] > SECTION_MAX_RESIDUAL:
        raise SectionRegistrationError(
            f"{section_name}: high live-grid residual ({final_metrics['residual_px']:.1f}px)"
        )

    if live_lattice_fallback_reason:
        read_grid_source = "coarse_template_fallback"
    elif drift_debug["x_axis_accepted"]:
        read_grid_source = "live_lattice"
    else:
        read_grid_source = "live_lattice_y_coarse_x"
    grid = dict(live_grid)
    grid.update({
        "x_centers": [round(v, 2) for v in final_x],
        "y_centers": [round(v, 2) for v in final_y],
        "y_origin": round(final_y[0], 2),
        "template_x_centers": [round(v, 2) for v in template_x],
        "template_y_centers": [round(v, 2) for v in template_y],
        "template_y_origin": round(template_y[0], 2),
        "coarse_x_centers": [round(v, 2) for v in coarse_x],
        "coarse_y_centers": [round(v, 2) for v in coarse_y],
        "read_grid_source": read_grid_source,
        "registration_method": "template_match_live_lattice",
    })

    centers = [
        _bubble_center(grid, c, r)
        for r in range(int(grid["rows"]))
        for c in range(int(grid["cols"]))
    ]
    phase_diag = _phase_shift_section_diagnostics(
        normalized,
        blank_reference,
        spec["roi"],
        centers,
        int(grid["bubble_radius"]),
    )
    metadata = {
        "section": section_name,
        "method": "template_match_live_lattice",
        "read_grid_source": read_grid_source,
        "live_lattice_fallback": live_lattice_fallback_reason,
        "status": "ok",
        "accepted": True,
        "roi": list(spec["roi"]),
        "candidate_count": len(candidates),
        "match_score": round(match_score, 4),
        "translation": [round(dx, 3), round(dy, 3)],
        "coarse_template_translation": [round(dx, 3), round(dy, 3)],
        "live_lattice_translation": [
            round(float(np.mean([x - tx for x, tx in zip(live_x, template_x)])), 3),
            round(float(np.mean([y - ty for y, ty in zip(live_y, template_y)])), 3),
        ],
        "pitch_delta": round(float(pitch_delta), 4),
        "coverage": round(float(final_metrics["coverage"]), 4),
        "residual_px": round(float(final_metrics["residual_px"]), 3),
        "max_residual_px": round(float(final_metrics["max_residual_px"]), 3),
        "matched_cells": int(final_metrics["matched_cells"]),
        "expected_cells": int(final_metrics["expected_cells"]),
        "coarse_coverage": round(float(coarse_metrics["coverage"]), 4),
        "coarse_residual_px": round(float(coarse_metrics["residual_px"]), 3),
        "coarse_max_residual_px": round(float(coarse_metrics["max_residual_px"]), 3),
        "coarse_matched_cells": int(coarse_metrics["matched_cells"]),
        "x_centers": grid["x_centers"],
        "y_centers": grid["y_centers"],
        "template_x_centers": [round(v, 2) for v in template_x],
        "template_y_centers": [round(v, 2) for v in template_y],
        "coarse_x_centers": [round(v, 2) for v in coarse_x],
        "coarse_y_centers": [round(v, 2) for v in coarse_y],
        "x_pitch": grid.get("x_pitch"),
        "y_pitch": grid.get("y_pitch"),
        "local_offsets": {
            "x_first": round(float(grid["x_centers"][0]) - template_x[0], 3),
            "x_last": round(float(grid["x_centers"][-1]) - template_x[-1], 3),
            "y_first": round(float(grid["y_centers"][0]) - template_y[0], 3),
            "y_last": round(float(grid["y_centers"][-1]) - template_y[-1], 3),
        },
        "col_drifts_px": drift_debug["col_drifts_px"],
        "row_drifts_px": drift_debug["row_drifts_px"],
        "max_col_drift_px": drift_debug["max_col_drift_px"],
        "max_row_drift_px": drift_debug["max_row_drift_px"],
        "max_col_drift_jump_px": drift_debug["max_col_drift_jump_px"],
        "max_row_drift_jump_px": drift_debug["max_row_drift_jump_px"],
        "x_axis_source": "live_lattice" if drift_debug["x_axis_accepted"] else "coarse_template_match",
        "y_axis_source": "live_lattice",
        "x_axis_accepted": drift_debug["x_axis_accepted"],
        "y_axis_accepted": drift_debug["y_axis_accepted"],
        "template_match": match_diag,
        "phase_diagnostic": phase_diag,
        "live_lattice": {
            "coverage": live_lattice_meta.get("coverage"),
            "x_pitch": live_lattice_meta.get("x_pitch"),
            "y_pitch": live_lattice_meta.get("y_pitch"),
            "local_offsets": live_lattice_meta.get("local_offsets"),
        },
    }
    return grid, metadata


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

        def _draw_template_bubbles(grid: dict[str, Any], colour: tuple[int, int, int]) -> None:
            cols = int(grid["cols"])
            rows = int(grid["rows"])
            radius = int(grid["bubble_radius"])
            for r in range(rows):
                for c in range(cols):
                    cx, cy = _template_bubble_center(grid, c, r)
                    cv2.circle(vis, (cx, cy), radius, colour, 1)

        resolved_grids = (payload or {}).get("resolved_grids") or {}
        student_grid = resolved_grids.get("student_code", STUDENT_CODE_GRID)
        exam_grid = resolved_grids.get("exam_code", EXAM_CODE_GRID)
        left_grid = resolved_grids.get("answers_left", ANSWER_GRID_LEFT)
        right_grid = resolved_grids.get("answers_right", ANSWER_GRID_RIGHT)

        for grid in (student_grid, exam_grid, left_grid, right_grid):
            if "template_x_centers" in grid or "template_y_centers" in grid:
                _draw_template_bubbles(grid, (180, 180, 180))

        _draw_bubbles(student_grid, (0, 170, 255))
        _draw_bubbles(exam_grid, (0, 170, 255))
        _draw_bubbles(left_grid, (0, 255, 80))
        _draw_bubbles(right_grid, (0, 255, 80))

        for section_name, meta in ((payload or {}).get("section_registration") or {}).items():
            if meta.get("status") != "failed":
                continue
            base_grid = SECTION_SPECS.get(section_name, {}).get("base_grid")
            if base_grid:
                _draw_bubbles(base_grid, (0, 0, 255))

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


def _fixed_crop(
    image: "np.ndarray",
    x: int,
    y: int,
    width: int,
    height: int,
) -> "np.ndarray":
    crop = np.zeros((height, width), dtype=image.dtype)
    sx1 = max(0, x)
    sy1 = max(0, y)
    sx2 = min(image.shape[1], x + width)
    sy2 = min(image.shape[0], y + height)
    if sx1 >= sx2 or sy1 >= sy2:
        return crop
    dx1 = sx1 - x
    dy1 = sy1 - y
    crop[dy1:dy1 + (sy2 - sy1), dx1:dx1 + (sx2 - sx1)] = image[sy1:sy2, sx1:sx2]
    return crop


def _save_section_debug_images(
    sheet_index: int,
    normalized: "np.ndarray",
    blank_reference: "np.ndarray | None",
    payload: dict[str, Any],
    out_dir: Path,
) -> None:
    if blank_reference is None:
        return

    resolved_grids = payload.get("resolved_grids") or {}
    section_registration = payload.get("section_registration") or {}
    for section_name, spec in SECTION_SPECS.items():
        x1, y1, x2, y2 = [int(v) for v in spec["roi"]]
        width = x2 - x1
        height = y2 - y1
        meta = section_registration.get(section_name, {})
        translation = meta.get("translation") if isinstance(meta, dict) else None
        dx = int(round(float(translation[0]))) if isinstance(translation, list) and len(translation) == 2 else 0
        dy = int(round(float(translation[1]))) if isinstance(translation, list) and len(translation) == 2 else 0

        live_crop = _fixed_crop(normalized, x1 + dx, y1 + dy, width, height)
        blank_crop = _fixed_crop(blank_reference, x1, y1, width, height)
        diff_crop = (live_crop.astype("uint8") & ~blank_crop.astype("uint8"))

        panels = [
            cv2.cvtColor(live_crop, cv2.COLOR_GRAY2BGR),
            cv2.cvtColor(blank_crop, cv2.COLOR_GRAY2BGR),
            cv2.cvtColor(diff_crop, cv2.COLOR_GRAY2BGR),
        ]
        grid = resolved_grids.get(section_name)
        if isinstance(grid, dict):
            for row in range(int(grid["rows"])):
                for col in range(int(grid["cols"])):
                    cx, cy = _bubble_center(grid, col, row)
                    tx, ty = _template_bubble_center(grid, col, row)
                    radius = int(grid["bubble_radius"])
                    cv2.circle(panels[0], (cx - (x1 + dx), cy - (y1 + dy)), radius, (0, 255, 80), 2)
                    cv2.circle(panels[1], (tx - x1, ty - y1), radius, (0, 170, 255), 2)

        combined = np.hstack(panels)
        cv2.imwrite(str(out_dir / f"scan_section_{sheet_index}_{section_name}.png"), combined)


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
    raw_binary: "np.ndarray | None" = None,
    blank_reference: "np.ndarray | None" = None,
) -> None:
    if not SAVE_DEBUG_IMAGE:
        return
    try:
        out_dir = Path(__file__).resolve().parent / "scans"
        out_dir.mkdir(parents=True, exist_ok=True)
        if raw_binary is not None:
            cv2.imwrite(str(out_dir / f"scan_raw_binary_{sheet_index}.png"), raw_binary)
        if normalized is not None:
            cv2.imwrite(str(out_dir / f"scan_normalized_{sheet_index}.png"), normalized)
            _save_debug_image(
                normalized,
                out_dir / f"scan_debug_{sheet_index}.png",
                payload.get("digit_decisions"),
                payload,
            )
            _save_section_debug_images(
                sheet_index,
                normalized,
                blank_reference,
                payload,
                out_dir,
            )
        (out_dir / f"omr_debug_{sheet_index}.json").write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.warning("Could not save OMR debug payload: %s", exc)


def _build_section_transform(
    detected_marks: list[dict[str, Any]],
    profile: dict[str, Any],
) -> tuple["np.ndarray", str, dict[str, Any]]:
    """
    Compute a 3×3 matrix M that maps canonical template coordinates to live
    scan coordinates.  Always succeeds — falls back through affine,
    partial-affine, translation, and identity when anchors are scarce.
    """
    template_raw_anchors: list[dict[str, Any]] = profile.get("raw_anchors") or []
    debug: dict[str, Any] = {"total_template_anchors": len(template_raw_anchors)}

    if not template_raw_anchors:
        debug["method"] = "identity_no_template"
        return np.eye(3, dtype=np.float32), "identity_no_template", debug

    matches = match_template_anchors(
        detected_marks,
        template_raw_anchors,
        max_distance=float(ANCHOR_MATCH_MAX_DISTANCE),
    )
    n = len(matches)
    debug["matched_anchors"] = n
    debug["matches"] = [
        {
            "template_index": m["template_index"],
            "template_center": m["template_center"],
            "detected_center": m["detected_center"],
            "distance": m["distance"],
        }
        for m in matches
    ]

    M_raw_to_scan: "np.ndarray | None" = None
    method = "identity"

    # Detect if matched anchors are collinear along one axis.
    if n >= 2:
        _src_xs = [m["template_center"][0] for m in matches]
        _src_ys = [m["template_center"][1] for m in matches]
        _x_span = float(max(_src_xs) - min(_src_xs))
        _y_span = float(max(_src_ys) - min(_src_ys))
    else:
        _x_span = _y_span = 0.0
    _COLLINEAR_PX = 150.0
    _x_collinear = _x_span < _COLLINEAR_PX  # all anchors on one vertical edge
    _y_collinear = _y_span < _COLLINEAR_PX  # all anchors on one horizontal edge
    debug["anchor_x_span"] = round(_x_span, 1)
    debug["anchor_y_span"] = round(_y_span, 1)

    if n >= 4:
        src = np.float32([[m["template_center"][0], m["template_center"][1]] for m in matches])
        dst = np.float32([[m["detected_center"][0], m["detected_center"][1]] for m in matches])
        M_h, inlier_mask = cv2.findHomography(src, dst, cv2.RANSAC, 12.0)
        if M_h is not None and inlier_mask is not None:
            inlier_count = int(np.sum(inlier_mask))
            if inlier_count >= 4:
                M_raw_to_scan = M_h.astype(np.float64)
                method = f"homography_{inlier_count}inliers"
                debug["homography_inliers"] = inlier_count

    if M_raw_to_scan is None and n >= 3:
        src = np.float32([[m["template_center"][0], m["template_center"][1]] for m in matches])
        dst = np.float32([[m["detected_center"][0], m["detected_center"][1]] for m in matches])
        M_aff, _ = cv2.estimateAffine2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=12.0)
        # Reject degenerate affine (e.g. from collinear anchors on one edge).
        if M_aff is not None and float(np.max(np.abs(M_aff))) < 1e4:
            M_raw_to_scan = np.vstack([M_aff, [0.0, 0.0, 1.0]])
            method = "affine"

    if M_raw_to_scan is None and n >= 2:
        _src_xs_arr = np.array([m["template_center"][0] for m in matches], dtype=np.float64)
        _dst_xs_arr = np.array([m["detected_center"][0] for m in matches], dtype=np.float64)
        _src_ys_arr = np.array([m["template_center"][1] for m in matches], dtype=np.float64)
        _dst_ys_arr = np.array([m["detected_center"][1] for m in matches], dtype=np.float64)
        if _x_collinear and not _y_collinear:
            # Left/right-edge anchors only: rotation is unknowable; use y-scale + uniform x-translate.
            src_y_span = float(_src_ys_arr.max() - _src_ys_arr.min())
            s_y = float((_dst_ys_arr.max() - _dst_ys_arr.min()) / src_y_span) if src_y_span > 1.0 else 1.0
            ty = float(np.mean(_dst_ys_arr - s_y * _src_ys_arr))
            tx = float(np.mean(_dst_xs_arr - _src_xs_arr))
            M_raw_to_scan = np.array([[1.0, 0.0, tx], [0.0, s_y, ty], [0.0, 0.0, 1.0]])
            method = "y_scale_x_translate"
        elif _y_collinear and not _x_collinear:
            # Top/bottom-edge anchors only: use x-scale + uniform y-translate.
            src_x_span = float(_src_xs_arr.max() - _src_xs_arr.min())
            s_x = float((_dst_xs_arr.max() - _dst_xs_arr.min()) / src_x_span) if src_x_span > 1.0 else 1.0
            tx = float(np.mean(_dst_xs_arr - s_x * _src_xs_arr))
            ty = float(np.mean(_dst_ys_arr - _src_ys_arr))
            M_raw_to_scan = np.array([[s_x, 0.0, tx], [0.0, 1.0, ty], [0.0, 0.0, 1.0]])
            method = "x_scale_y_translate"
        else:
            src = np.float32([[m["template_center"][0], m["template_center"][1]] for m in matches])
            dst = np.float32([[m["detected_center"][0], m["detected_center"][1]] for m in matches])
            M_part, _ = cv2.estimateAffinePartial2D(src, dst)
            if M_part is not None and float(np.max(np.abs(M_part))) < 1e4:
                M_raw_to_scan = np.vstack([M_part, [0.0, 0.0, 1.0]])
                method = "partial_affine"

    if M_raw_to_scan is None and n >= 1:
        dx = float(np.mean([m["detected_center"][0] - m["template_center"][0] for m in matches]))
        dy = float(np.mean([m["detected_center"][1] - m["template_center"][1] for m in matches]))
        M_raw_to_scan = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy], [0.0, 0.0, 1.0]])
        method = "translation"
        debug["translation"] = [round(dx, 2), round(dy, 2)]

    if M_raw_to_scan is None:
        M_raw_to_scan = np.eye(3, dtype=np.float64)
        method = "identity"

    debug["method"] = method

    # Compute M_canonical_to_raw: inverse of the calibration perspective warp.
    # The calibration warp maps the 4 corner raw_anchors → canonical corners.
    # We need the reverse so that canonical grid positions → raw template space.
    try:
        corner_marks = [{"center": a["center"]} for a in template_raw_anchors]
        tl, tr, br, bl = _choose_registration_corners(corner_marks)
        canon_corners = np.float32([
            [0.0, 0.0],
            [float(CANON_W - 1), 0.0],
            [float(CANON_W - 1), float(CANON_H - 1)],
            [0.0, float(CANON_H - 1)],
        ])
        raw_corners = np.float32([
            [tl[0], tl[1]], [tr[0], tr[1]],
            [br[0], br[1]], [bl[0], bl[1]],
        ])
        M_canonical_to_raw = cv2.getPerspectiveTransform(canon_corners, raw_corners)
        debug["canonical_to_raw"] = "ok"
    except Exception as exc:
        M_canonical_to_raw = np.eye(3, dtype=np.float64)
        debug["canonical_to_raw"] = f"identity_fallback:{exc}"

    M_final = (M_raw_to_scan @ M_canonical_to_raw).astype(np.float32)
    return M_final, method, debug


def _transform_grid(base_grid: dict[str, Any], M: "np.ndarray") -> dict[str, Any]:
    """
    Apply 3×3 perspective transform M to all bubble centers in base_grid.
    Returns a new grid with scan-space x_centers and y_centers.
    Transforming axes independently is exact for affine and ~2 px error for
    mild perspective — well within bubble radius.
    """
    xs = _grid_x_centers(base_grid)
    ys = _grid_y_centers(base_grid)
    y_mid = float(np.median(ys))
    x_mid = float(np.median(xs))

    col_pts = np.float32([[[x, y_mid]] for x in xs])
    new_xs = [round(float(p[0]), 2) for p in cv2.perspectiveTransform(col_pts, M).reshape(-1, 2)]

    row_pts = np.float32([[[x_mid, y]] for y in ys])
    new_ys = [round(float(p[1]), 2) for p in cv2.perspectiveTransform(row_pts, M).reshape(-1, 2)]

    grid = {**base_grid}
    grid["x_centers"] = new_xs
    grid["y_centers"] = new_ys
    grid["y_origin"] = new_ys[0]
    return grid


def process_sheet(
    pil_image: "Image.Image",
    sheet_index: int,
    api_base: str,
    answer_key_lookup: Callable[[str], dict[str, Any] | None] | None = None,
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
    target_raw_size = _template_raw_size(profile)
    prepared_for_debug = _resize_for_template(pil_image, target_raw_size)
    binary = preprocess(prepared_for_debug)
    debug_payload.update({
        "template_version": profile.get("template_version", TEMPLATE_VERSION),
        "template_profile_loaded": bool(profile.get("profile_loaded")),
        "blank_reference_used": blank_reference is not None,
        "prepared_pil_size": [int(prepared_for_debug.width), int(prepared_for_debug.height)],
        "input_size_normalized": pil_image.size != target_raw_size,
        "orientation_correction": None,
        "selected_orientation": None,
        "template_profile": {
            "source_blank_scan": profile.get("source_blank_scan"),
            "blank_reference_frame": profile.get("blank_reference_frame", "canonical_anchors"),
            "canonical_size": profile.get("canonical_size"),
            "raw_size": profile.get("raw_size"),
            "raw_anchor_count": len(profile.get("raw_anchors", [])),
            "anchor_count": len(profile.get("anchors", [])),
        },
    })

    if blank_reference is None:
        flags.extend(["UNREADABLE", "TEMPLATE_PROFILE_INVALID"])
        debug_payload.update({
            "coordinate_frame": "raw_scan",
            "normalization_error": "TEMPLATE_PROFILE_INVALID: canonical blank reference missing",
            "student_code": None,
            "exam_code": None,
            "raw_answers": "",
            "status": "flagged",
            "flag_reasons": flags,
            "digit_decisions": [],
            "bubble_readings": [],
            "section_registration": {},
            "resolved_grids": {},
            "scan_quality": {
                "page_registration_method": None,
                "mark_count": 0,
                "fill_threshold_used": None,
                "fill_threshold_source": None,
                "bubble_ratio_p25": None,
                "bubble_ratio_p75": None,
                "low_confidence_bubbles": 0,
                "sections_registered": [],
                "sections_failed": [],
            },
        })
        _save_omr_debug(
            sheet_index,
            None,
            debug_payload,
            raw_binary=binary,
            blank_reference=blank_reference,
        )
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

    try:
        binary, scan, normalization_debug, preparation_debug, prepared_image = _prepare_and_normalize_scan(
            pil_image,
            profile,
        )
    except UnreadableSheetError as exc:
        flags.extend(["UNREADABLE", "PAGE_REGISTRATION_FAILED"])
        failure_preview_image = exc.debug.pop("_failure_preview_image", None)
        failure_preview_binary = exc.debug.pop("_failure_preview_binary", None)
        if failure_preview_image is not None:
            thumbnail = _pil_to_base64_jpeg(failure_preview_image)
            debug_payload["preview_image_source"] = "failed_orientation_candidate"
        if failure_preview_binary is not None:
            binary = failure_preview_binary
        if exc.debug.get("scan_rejection_reason") == "SIDEWAYS_CONTENT_CLIPPED":
            flags.append("SCAN_CONTENT_CLIPPED_OR_SIDEWAYS")
        debug_payload.update(exc.debug)
        debug_payload.update({
            "coordinate_frame": "raw_scan",
            "normalization_error": str(exc),
            "student_code": None,
            "exam_code": None,
            "raw_answers": "",
            "status": "flagged",
            "flag_reasons": flags,
            "digit_decisions": [],
            "bubble_readings": [],
            "section_registration": {},
            "resolved_grids": {},
            "scan_quality": {
                "page_registration_method": exc.debug.get("page_registration_method"),
                "mark_count": len(exc.debug.get("mark_candidates", [])),
                "fill_threshold_used": None,
                "fill_threshold_source": None,
                "bubble_ratio_p25": None,
                "bubble_ratio_p75": None,
                "low_confidence_bubbles": 0,
                "sections_registered": [],
                "sections_failed": [],
            },
        })
        _save_omr_debug(
            sheet_index,
            None,
            debug_payload,
            raw_binary=binary,
            blank_reference=blank_reference,
        )
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

    thumbnail = _pil_to_base64_jpeg(prepared_image)
    preparation_debug["preview_image_source"] = "prepared_orientation_candidate"
    debug_payload.update(preparation_debug)
    debug_payload.update(normalization_debug)
    debug_payload["coordinate_frame"] = "canonical_template"

    section_registration: dict[str, Any] = {}
    resolved_grids: dict[str, dict[str, Any]] = {}

    def _resolve_section(section_name: str) -> dict[str, Any] | None:
        # Primary: line every bubble row/column up with the blank template
        # (follows uneven feeding and stretching of the paper).
        aligned, align_meta = align_section_to_template(
            scan,
            blank_reference,
            _profile_section_grid(profile, section_name),
            section_name,
        )
        # The older contour-lattice registration is kept as a diagnostic and as
        # the fallback when the template alignment can't be trusted.
        try:
            lattice_grid, meta = register_section(scan, section_name, profile, blank_reference)
        except SectionRegistrationError as exc:
            lattice_grid = None
            meta = {
                "section": section_name,
                "method": "template_match_live_lattice",
                "status": "failed",
                "accepted": False,
                "error": str(exc),
            }
        meta = dict(meta)
        meta["lattice_status"] = meta.get("status")
        meta["local_alignment"] = align_meta

        if align_meta["ok"]:
            grid = aligned
            meta["status"] = "ok"
            meta["method"] = "local_template_alignment"
        elif lattice_grid is not None:
            grid = lattice_grid
            meta["method"] = "template_match_live_lattice"
        else:
            failure_flag = str(SECTION_SPECS[section_name]["failure_flag"])
            if failure_flag not in flags:
                flags.append(failure_flag)
            meta["status"] = "failed"
            section_registration[section_name] = meta
            return None

        section_registration[section_name] = meta
        resolved_grids[section_name] = _json_safe_grid(grid)
        return grid

    student_grid = _resolve_section("student_code")
    exam_grid = _resolve_section("exam_code")
    answers_left_grid = _resolve_section("answers_left")
    answers_right_grid = _resolve_section("answers_right")

    active_grids = [
        grid
        for grid in (student_grid, exam_grid, answers_left_grid, answers_right_grid)
        if grid is not None
    ]
    adaptive_t = _adaptive_threshold(scan, active_grids) if active_grids else FILL_THRESHOLD
    logger.info("Adaptive fill threshold for sheet %d: %.3f", sheet_index, adaptive_t)

    if student_grid is not None:
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
    else:
        sc_digits = [None] * int(_profile_section_grid(profile, "student_code")["cols"])
        student_code = None

    if exam_grid is not None:
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
    else:
        ec_digits = [None] * int(_profile_section_grid(profile, "exam_code")["cols"])
        exam_code = None

    if answer_key_lookup is None and student_code and _REQUESTS_AVAILABLE:
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
        exam_data = answer_key_lookup(exam_code) if answer_key_lookup else fetch_answer_key(exam_code, api_base)
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
    left_rows = int(_profile_section_grid(profile, "answers_left")["rows"])
    right_rows = int(_profile_section_grid(profile, "answers_right")["rows"])
    if answers_left_grid is not None:
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
    else:
        all_answers += [None] * left_rows
    if answers_right_grid is not None:
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
    else:
        all_answers += [None] * right_rows
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
        "page_registration_method": debug_payload.get("page_registration_method"),
        "mark_count": len(debug_payload.get("mark_candidates", [])),
        "fill_threshold_used": round(float(adaptive_t), 4),
        "fill_threshold_source": "adaptive",
        "bubble_ratio_p25": round(float(np.percentile(_arr, 25)), 4),
        "bubble_ratio_p75": round(float(np.percentile(_arr, 75)), 4),
        "low_confidence_bubbles": sum(
            1 for d in digit_decisions if d.get("low_confidence")
        ),
        "sections_registered": [
            name for name, meta in section_registration.items()
            if meta.get("status") == "ok"
        ],
        "sections_failed": [
            name for name, meta in section_registration.items()
            if meta.get("status") != "ok"
        ],
    }

    debug_payload.update({
        "blank_reference_used": True,
        "section_registration_method": "template_match_live_lattice",
        "section_registration": section_registration,
        "resolved_grids": resolved_grids,
        "digit_grid_geometry": {
            "student_code": {
                "x_centers": student_grid.get("x_centers") if student_grid else None,
                "y_centers": student_grid.get("y_centers") if student_grid else None,
                "y_origin": student_grid.get("y_origin") if student_grid else None,
                "y_pitch": student_grid.get("y_pitch") if student_grid else None,
                "bubble_radius": student_grid.get("bubble_radius") if student_grid else None,
            },
            "exam_code": {
                "x_centers": exam_grid.get("x_centers") if exam_grid else None,
                "y_centers": exam_grid.get("y_centers") if exam_grid else None,
                "y_origin": exam_grid.get("y_origin") if exam_grid else None,
                "y_pitch": exam_grid.get("y_pitch") if exam_grid else None,
                "bubble_radius": exam_grid.get("bubble_radius") if exam_grid else None,
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

    _save_omr_debug(
        sheet_index,
        scan,
        debug_payload,
        raw_binary=binary,
        blank_reference=blank_reference,
    )

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
