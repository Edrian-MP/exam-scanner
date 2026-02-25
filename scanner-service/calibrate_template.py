"""
Create the A5_TEMPLATE_V1 calibration profile from a blank scanned answer sheet.

Usage:
    python scanner-service\\calibrate_template.py path\\to\\blank_scan.png

The script writes:
    scanner-service\\templates\\a5_template_v1.json
    scanner-service\\templates\\a5_template_v1.png
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

import omr


def _anchor_payload(mark: dict) -> dict:
    return {
        "center": [
            round(float(mark["center"][0]), 2),
            round(float(mark["center"][1]), 2),
        ],
        "bbox": list(mark["bbox"]),
        "area": round(float(mark["area"]), 2),
        "fill_ratio": round(float(mark["fill_ratio"]), 4),
    }


def calibrate(blank_scan: Path) -> dict:
    image = Image.open(blank_scan)

    # Normalise resolution: if the image isn't already at canonical DPI size,
    # scale it up so the corner registration marks meet the minimum area filter.
    if image.size != (omr.CANON_W, omr.CANON_H):
        print(f"Resizing from {image.size} -> ({omr.CANON_W}, {omr.CANON_H})")
        image = image.resize((omr.CANON_W, omr.CANON_H), Image.LANCZOS)

    binary = omr.preprocess(image)
    raw_anchors = omr.detect_page_anchors(binary)
    normalized, normalization_debug = omr.normalize_scan(binary, use_template_profile=False)

    # raw_anchors remain in the incoming scan frame and are used only for
    # matching future scans. anchors are the canonical frame used by
    # a5_template_v1.png and by live scan normalization.
    # Re-detecting in the normalized image returns 0 because corner marks end up
    # clipped at the image boundary, so project raw marks through the same
    # perspective homography that created the blank reference image.
    tl, tr, br, bl = omr._choose_registration_corners(raw_anchors)
    _src = cv2.getPerspectiveTransform(
        np.float32([[tl[0], tl[1]], [tr[0], tr[1]],
                    [br[0], br[1]], [bl[0], bl[1]]]),
        np.float32([[0, 0], [omr.CANON_W - 1, 0],
                    [omr.CANON_W - 1, omr.CANON_H - 1], [0, omr.CANON_H - 1]]),
    )
    _raw_pts = np.float32([[[float(a["center"][0]), float(a["center"][1])]]
                            for a in raw_anchors])
    _canon_pts = cv2.perspectiveTransform(_raw_pts, _src).reshape(-1, 2)
    anchors = [
        {**_anchor_payload(mark), "center": [round(float(cx), 2), round(float(cy), 2)]}
        for mark, (cx, cy) in zip(raw_anchors, _canon_pts)
    ]

    sections: dict[str, dict] = {}
    section_registration: dict[str, dict] = {}
    for section_name in omr.SECTION_SPECS:
        grid, metadata = omr.refine_section_geometry(normalized, section_name)
        sections[section_name] = omr._json_safe_grid(grid)
        section_registration[section_name] = metadata

    profile = {
        "template_version": omr.TEMPLATE_VERSION,
        "blank_reference_frame": "canonical_anchors",
        "canonical_size": [omr.CANON_W, omr.CANON_H],
        "source_blank_scan": str(blank_scan),
        "raw_size": [int(binary.shape[1]), int(binary.shape[0])],
        "raw_anchors": [_anchor_payload(mark) for mark in raw_anchors],
        "anchors": [_anchor_payload(mark) for mark in anchors],
        "sections": sections,
        "section_registration": section_registration,
        "normalization_debug": normalization_debug,
    }

    omr.TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(omr.TEMPLATE_REFERENCE_PATH), normalized)
    omr.TEMPLATE_PROFILE_PATH.write_text(
        json.dumps(profile, indent=2),
        encoding="utf-8",
    )
    return profile


def main() -> int:
    parser = argparse.ArgumentParser(description="Calibrate OMR template from a blank scan.")
    parser.add_argument("blank_scan", type=Path, help="Path to a blank scanned answer sheet image.")
    args = parser.parse_args()

    if not args.blank_scan.exists():
        parser.error(f"blank scan not found: {args.blank_scan}")

    profile = calibrate(args.blank_scan)
    print(f"Wrote {omr.TEMPLATE_PROFILE_PATH}")
    print(f"Wrote {omr.TEMPLATE_REFERENCE_PATH}")
    print(f"Anchors: {len(profile['anchors'])}")
    for name, meta in profile["section_registration"].items():
        print(f"{name}: coverage={meta['coverage']} x_pitch={meta['x_pitch']} y_pitch={meta['y_pitch']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
