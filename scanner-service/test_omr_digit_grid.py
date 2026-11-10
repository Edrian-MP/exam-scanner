import unittest

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover - exercised only on missing optional deps.
    cv2 = None
    np = None

import omr


TEST_GRID = {
    "x_centers": [60, 140],
    "y_origin": 50,
    "cols": 2,
    "rows": 10,
    "y_pitch": 40,
    "bubble_radius": 14,
}


def _draw_printed_digit_grid(image, grid):
    radius = int(grid["bubble_radius"])
    for col in range(int(grid["cols"])):
        for row in range(int(grid["rows"])):
            cx, cy = omr._bubble_center(grid, col, row)
            cv2.circle(image, (cx, cy), radius, 255, 2)
            cv2.putText(
                image,
                str(row),
                (cx - 5, cy + 5),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                255,
                1,
                cv2.LINE_AA,
            )


def _fill_digit(image, grid, col, digit):
    cx, cy = omr._bubble_center(grid, col, digit)
    cv2.circle(image, (cx, cy), int(grid["bubble_radius"]) - 2, 255, -1)


@unittest.skipIf(cv2 is None or np is None, "opencv-python/numpy are required")
class DigitGridReaderTests(unittest.TestCase):
    def _blank_form(self, grid=TEST_GRID):
        image = np.zeros((480, 220), dtype=np.uint8)
        _draw_printed_digit_grid(image, grid)
        return image

    def test_empty_printed_digits_are_not_accepted(self):
        image = self._blank_form()
        flags = []
        decisions = []

        digits = omr.read_digit_grid(
            image,
            TEST_GRID,
            flags,
            digit_decisions=decisions,
            name="student_code",
            flag_prefix="STUDENT_CODE",
        )

        self.assertEqual(digits, [None, None])
        self.assertEqual(flags, [])
        self.assertTrue(all(not decision["accepted"] for decision in decisions))

    def test_single_filled_digit_per_column_resolves(self):
        image = self._blank_form()
        _fill_digit(image, TEST_GRID, 0, 3)
        _fill_digit(image, TEST_GRID, 1, 8)
        flags = []
        decisions = []

        digits = omr.read_digit_grid(
            image,
            TEST_GRID,
            flags,
            digit_decisions=decisions,
            name="student_code",
            flag_prefix="STUDENT_CODE",
        )

        self.assertEqual(digits, [3, 8])
        self.assertEqual(flags, [])
        self.assertTrue(all(decision["accepted"] for decision in decisions))

    def test_ambiguous_column_is_rejected(self):
        grid = dict(TEST_GRID, x_centers=[60], cols=1)
        image = self._blank_form(grid)
        cx, cy = omr._bubble_center(grid, 0, 2)
        cv2.circle(image, (cx, cy), 5, 255, -1)
        cx, cy = omr._bubble_center(grid, 0, 3)
        cv2.circle(image, (cx, cy), 6, 255, -1)
        flags = []
        decisions = []

        digits = omr.read_digit_grid(
            image,
            grid,
            flags,
            digit_decisions=decisions,
            name="exam_code",
            flag_prefix="EXAM_CODE",
        )

        # two small dots are not shading: the column has no mark, so it's rejected
        self.assertEqual(digits, [None])
        self.assertEqual(decisions[0]["reason"], "below_min_ratio")

    def test_double_marked_digit_column_is_rejected(self):
        grid = dict(TEST_GRID, x_centers=[60], cols=1)
        image = self._blank_form(grid)
        _fill_digit(image, grid, 0, 2)
        _fill_digit(image, grid, 0, 7)
        flags = []
        decisions = []

        digits = omr.read_digit_grid(
            image,
            grid,
            flags,
            digit_decisions=decisions,
            name="exam_code",
            flag_prefix="EXAM_CODE",
        )

        self.assertEqual(digits, [None])
        self.assertEqual(decisions[0]["reason"], "double_mark")
        self.assertIn("DOUBLE_MARK_EXAM_CODE_COL_1", flags)


if __name__ == "__main__":
    unittest.main()
