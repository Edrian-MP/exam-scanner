import unittest

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover - exercised only on missing optional deps.
    cv2 = None
    np = None

import omr


def _shifted_grid(base_grid, dx=0, dy=0):
    x_centers = [x + dx for x in omr._grid_x_centers(base_grid)]
    y_centers = [y + dy for y in omr._grid_y_centers(base_grid)]
    grid = dict(base_grid)
    grid.update({
        "x_centers": x_centers,
        "y_centers": y_centers,
        "y_origin": y_centers[0],
    })
    return grid


def _draw_grid(image, grid, labels=None):
    radius = int(grid["bubble_radius"])
    rows = int(grid["rows"])
    cols = int(grid["cols"])
    for row in range(rows):
        for col in range(cols):
            cx, cy = omr._bubble_center(grid, col, row)
            cv2.circle(image, (cx, cy), radius, 255, 2)
            if labels == "digits":
                cv2.putText(
                    image,
                    str(row),
                    (cx - 6, cy + 6),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.48,
                    255,
                    1,
                    cv2.LINE_AA,
                )
            elif labels == "letters":
                cv2.putText(
                    image,
                    omr.ANSWER_LETTERS[col],
                    (cx - 6, cy + 6),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.42,
                    255,
                    1,
                    cv2.LINE_AA,
                )


def _fill_cell(image, grid, col, row):
    cx, cy = omr._bubble_center(grid, col, row)
    cv2.circle(image, (cx, cy), int(grid["bubble_radius"]) - 3, 255, -1)


@unittest.skipIf(cv2 is None or np is None, "opencv-python/numpy are required")
class TemplateRegistrationTests(unittest.TestCase):
    def test_shifted_exam_code_grid_is_locally_registered(self):
        image = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        shifted = _shifted_grid(omr.EXAM_CODE_GRID, dx=52, dy=9)
        _draw_grid(image, shifted, labels="digits")
        for col, digit in enumerate([2, 4, 4, 5, 2, 4]):
            _fill_cell(image, shifted, col, digit)

        resolved, meta = omr.refine_section_geometry(image, "exam_code")
        flags = []
        digits = omr.read_digit_grid(image, resolved, flags)

        self.assertGreaterEqual(meta["coverage"], 0.90)
        self.assertEqual(digits, [2, 4, 4, 5, 2, 4])
        self.assertEqual(flags, [])

    def test_shifted_answer_grid_is_locally_registered(self):
        image = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        shifted = _shifted_grid(omr.ANSWER_GRID_LEFT, dx=28, dy=35)
        _draw_grid(image, shifted, labels="letters")
        _fill_cell(image, shifted, 2, 0)
        _fill_cell(image, shifted, 0, 1)

        resolved, meta = omr.refine_section_geometry(image, "answers_left")
        flags = []
        answers = omr.read_answer_grid(image, resolved, 1, flags, max_item=2)

        self.assertGreaterEqual(meta["coverage"], 0.90)
        self.assertEqual(answers[:2], ["C", "A"])
        self.assertEqual(flags, [])

    def test_blank_template_subtraction_ignores_printed_bubble(self):
        blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        live = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        grid = _shifted_grid(omr.ANSWER_GRID_LEFT)
        _draw_grid(blank, grid, labels="letters")
        _draw_grid(live, grid, labels="letters")
        _fill_cell(live, grid, 1, 0)

        empty_x, empty_y = omr._bubble_center(grid, 0, 0)
        filled_x, filled_y = omr._bubble_center(grid, 1, 0)
        empty_ratio = omr.blank_corrected_fill_ratio(
            live,
            blank,
            empty_x,
            empty_y,
            int(grid["bubble_radius"]),
        )
        filled_ratio = omr.blank_corrected_fill_ratio(
            live,
            blank,
            filled_x,
            filled_y,
            int(grid["bubble_radius"]),
        )

        self.assertLess(empty_ratio, 0.10)
        self.assertGreater(filled_ratio, 0.35)


if __name__ == "__main__":
    unittest.main()
