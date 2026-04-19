"""
Diagnostic script: show all large contours found in a template image,
so we can tune registration mark detection parameters.

Usage:
    python scanner-service\diagnose_marks.py path\to\blank_scan.png
"""
import sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

# Add scanner-service to path so we can import omr
sys.path.insert(0, str(Path(__file__).resolve().parent))
import omr

def main():
    if len(sys.argv) < 2:
        print("Usage: python diagnose_marks.py <image_path>")
        sys.exit(1)

    path = Path(sys.argv[1])
    print(f"\nLoading: {path}")
    print(f"File size: {path.stat().st_size / 1024:.1f} KB")

    img_pil = Image.open(path)
    print(f"PIL image size: {img_pil.size}  mode: {img_pil.mode}")

    binary = omr.preprocess(img_pil)
    print(f"Binary shape: {binary.shape}  (H x W)")
    print(f"White pixels: {np.count_nonzero(binary)}  ({np.count_nonzero(binary)/binary.size*100:.1f}%)")

    # Find ALL contours with minimal size filter
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    print(f"\nTotal contours: {len(contours)}")

    # Filter to anything >= 500 area
    candidates = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 500:
            continue
        x, y, w, h = cv2.boundingRect(cnt)
        aspect = w / h if h > 0 else 0
        fill = area / (w * h) if w * h > 0 else 0
        candidates.append((area, x, y, w, h, aspect, fill))

    candidates.sort(key=lambda c: -c[0])
    print(f"Contours with area >= 500: {len(candidates)}")

    print(f"\n{'Area':>10}  {'x':>5} {'y':>5} {'w':>5} {'h':>5}  {'aspect':>7}  {'fill':>6}  Passes?")
    print("-" * 80)
    for area, x, y, w, h, aspect, fill in candidates[:40]:
        passes_area   = area >= omr.REG_MARK_MIN_AREA
        passes_side   = (w >= omr.REG_MARK_MIN_SIDE and h >= omr.REG_MARK_MIN_SIDE)
        passes_maxside = (w <= omr.REG_MARK_MAX_SIDE and h <= omr.REG_MARK_MAX_SIDE)
        passes_aspect = 0.7 <= aspect <= 1.3
        passes_fill   = fill >= 0.55
        all_pass = passes_area and passes_side and passes_maxside and passes_aspect and passes_fill
        flags = []
        if not passes_area:   flags.append(f"area<{omr.REG_MARK_MIN_AREA}")
        if not passes_side:   flags.append(f"side<{omr.REG_MARK_MIN_SIDE}")
        if not passes_maxside: flags.append(f"side>{omr.REG_MARK_MAX_SIDE}")
        if not passes_aspect: flags.append(f"aspect={aspect:.2f}")
        if not passes_fill:   flags.append(f"fill={fill:.2f}<0.55")
        status = "YES" if all_pass else f"NO ({', '.join(flags)})"
        print(f"{area:>10.0f}  {x:>5} {y:>5} {w:>5} {h:>5}  {aspect:>7.2f}  {fill:>6.2f}  {status}")

    # Save debug image with all large contours drawn
    vis = cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)
    for area, x, y, w, h, aspect, fill in candidates[:40]:
        color = (0, 255, 0) if (area >= omr.REG_MARK_MIN_AREA
                                and w >= omr.REG_MARK_MIN_SIDE
                                and w <= omr.REG_MARK_MAX_SIDE
                                and 0.7 <= aspect <= 1.3
                                and fill >= 0.55) else (0, 100, 255)
        cv2.rectangle(vis, (x, y), (x+w, y+h), color, 3)
        cv2.putText(vis, f"{int(area)}", (x, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

    out_path = path.parent / (path.stem + "_marks_debug.png")
    cv2.imwrite(str(out_path), vis)
    print(f"\nDebug image saved to: {out_path}")
    print("  Green = passes ALL filters (would be used as registration mark)")
    print("  Orange = fails at least one filter")

if __name__ == "__main__":
    main()
