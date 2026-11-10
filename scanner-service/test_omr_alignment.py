"""Tests for local section alignment and the inner-disk bubble measurement."""

import unittest

import cv2
import numpy as np

import omr


def _warp_drift(image: np.ndarray, shift_x: float, shift_y: float, drift_x: float, drift_y: float) -> np.ndarray:
    """Shift the image and add a drift that grows down the page (like uneven feeding)."""
    h, w = image.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    frac = ys / float(h)
    map_x = xs - (shift_x + drift_x * frac)
    map_y = ys - (shift_y + drift_y * frac)
    return cv2.remap(image, map_x, map_y, cv2.INTER_NEAREST, borderValue=0)


class AlignmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = omr.load_template_profile(include_image=True)
        cls.blank = cls.profile.get("_blank_reference")
        if cls.blank is None:
            raise unittest.SkipTest("template profile with blank reference not available")

    def _grid(self, section):
        return omr._profile_section_grid(self.profile, section)

    def _fill(self, image, grid, col, row, shift=(0, 0)):
        x = int(round(grid["x_centers"][col])) + shift[0]
        y = int(round(grid["y_centers"][row])) + shift[1]
        cv2.circle(image, (x, y), int(grid["bubble_radius"]) - 2, 255, -1)

    def test_offset_empty_outline_is_not_a_mark_but_fill_is(self):
        grid = self._grid("answers_left")
        r = int(grid["bubble_radius"])
        live = np.roll(self.blank, (4, 4), axis=(0, 1))  # printed outlines 4 px off
        self._fill(live, grid, 1, 0, shift=(4, 4))
        # sampled 2 px away from where the outlines really are (residual misalignment)
        tx, ty = int(round(grid["x_centers"][0])), int(round(grid["y_centers"][0]))
        empty = omr.bubble_mark_ratio(live, self.blank, tx + 2, ty + 2, r, tx, ty)
        bx = int(round(grid["x_centers"][1]))
        filled = omr.bubble_mark_ratio(live, self.blank, bx + 2, ty + 2, r, bx, ty)
        self.assertLess(empty, 0.25)
        self.assertGreater(filled, 0.9)

    def test_drifting_answer_section_is_followed_row_by_row(self):
        grid = self._grid("answers_left")
        live = self.blank.copy()
        expected = []
        for row in range(int(grid["rows"])):
            col = row % 4
            self._fill(live, grid, col, row)
            expected.append(omr.ANSWER_LETTERS[col])
        # 25 px shift plus another 30 px of drift by the bottom of the page
        live = _warp_drift(live, -25, 10, -30, 15)

        aligned, meta = omr.align_section_to_template(live, self.blank, grid, "answers_left")
        self.assertTrue(meta["ok"], meta)
        flags = []
        answers = omr.read_answer_grid(live, aligned, 1, flags, blank_reference=self.blank)
        self.assertEqual(answers, expected)
        self.assertEqual([f for f in flags if "LOW_CONFIDENCE" in f or "NO_ANSWER" in f], [])

    def test_drifting_digit_grid_reads_every_column(self):
        grid = self._grid("student_code")
        live = self.blank.copy()
        code = [6, 7, 2, 4, 9, 1]
        for col, digit in enumerate(code):
            self._fill(live, grid, col, digit)
        live = _warp_drift(live, -12, 8, -10, 12)

        aligned, meta = omr.align_section_to_template(live, self.blank, grid, "student_code")
        self.assertTrue(meta["ok"], meta)
        flags = []
        digits = omr.read_digit_grid(live, aligned, flags, blank_reference=self.blank)
        self.assertEqual(digits, code)
        self.assertEqual(flags, [])

    def test_double_mark_still_detected_after_alignment(self):
        grid = self._grid("answers_right")
        live = self.blank.copy()
        self._fill(live, grid, 0, 3)
        self._fill(live, grid, 2, 3)
        live = _warp_drift(live, 15, -6, 0, 0)

        aligned, meta = omr.align_section_to_template(live, self.blank, grid, "answers_right")
        answers = omr.read_answer_grid(live, aligned, 16, [], blank_reference=self.blank)
        self.assertIsNone(answers[3])


if __name__ == "__main__":
    unittest.main()
