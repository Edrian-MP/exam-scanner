import unittest
from unittest.mock import patch

try:
    import cv2
    import numpy as np
    from PIL import Image
except Exception:  # pragma: no cover - exercised only on missing optional deps.
    cv2 = None
    np = None
    Image = None

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


def _row_drifted_grid(base_grid, dx=0, row_drifts=None):
    base_y = omr._grid_y_centers(base_grid)
    if row_drifts is None:
        row_drifts = [0 for _ in base_y]
    x_centers = [x + dx for x in omr._grid_x_centers(base_grid)]
    y_centers = [y + row_drifts[index] for index, y in enumerate(base_y)]
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


def _anchor(center):
    return {
        "center": [float(center[0]), float(center[1])],
        "bbox": [int(center[0]) - 20, int(center[1]) - 20, 40, 40],
        "area": 1600.0,
        "fill_ratio": 1.0,
    }


def _draw_anchor(image, center, size=44):
    x, y = [int(round(v)) for v in center]
    half = size // 2
    cv2.rectangle(image, (x - half, y - half), (x + half, y + half), 255, -1)


def _sheet_to_pil(binary_image):
    return Image.fromarray(255 - binary_image)


def _build_process_sheet_fixture():
    blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
    answer_grid_left = omr._profile_section_grid(None, "answers_left")
    answer_grid_right = omr._profile_section_grid(None, "answers_right")
    student_grid = omr._profile_section_grid(None, "student_code")
    exam_grid = omr._profile_section_grid(None, "exam_code")

    _draw_grid(blank, student_grid, labels="digits")
    _draw_grid(blank, exam_grid, labels="digits")
    _draw_grid(blank, answer_grid_left, labels="letters")
    _draw_grid(blank, answer_grid_right, labels="letters")

    anchors = [
        (70, 70),
        (1684, 70),
        (1684, 2408),
        (70, 2408),
        (70, 1210),
        (1684, 1210),
        (1584, 70),
        (1684, 170),
    ]
    for point in anchors:
        _draw_anchor(blank, point)

    filled = blank.copy()
    for col, digit in enumerate([9, 8, 7, 6, 5, 4]):
        _fill_cell(filled, student_grid, col, digit)
    for col, digit in enumerate([2, 4, 4, 5, 2, 4]):
        _fill_cell(filled, exam_grid, col, digit)
    for row in range(15):
        _fill_cell(filled, answer_grid_left, 0, row)
    for row in range(10):
        _fill_cell(filled, answer_grid_right, 0, row)

    profile = {
        "template_version": omr.TEMPLATE_VERSION,
        "profile_loaded": True,
        "blank_reference_frame": "canonical_anchors",
        "canonical_size": [omr.CANON_W, omr.CANON_H],
        "raw_size": [omr.CANON_W, omr.CANON_H],
        "raw_anchors": [_anchor(point) for point in anchors],
        "anchors": [_anchor(point) for point in anchors],
        "_blank_reference": blank,
        "blank_reference_loaded": True,
        "sections": {
            "student_code": {
                "x_centers": student_grid["x_centers"],
                "y_centers": student_grid["y_centers"],
                "y_origin": student_grid["y_origin"],
                "y_pitch": student_grid["y_pitch"],
                "bubble_radius": student_grid["bubble_radius"],
            },
            "exam_code": {
                "x_centers": exam_grid["x_centers"],
                "y_centers": exam_grid["y_centers"],
                "y_origin": exam_grid["y_origin"],
                "y_pitch": exam_grid["y_pitch"],
                "bubble_radius": exam_grid["bubble_radius"],
            },
            "answers_left": {
                "x_centers": answer_grid_left["x_centers"],
                "y_centers": answer_grid_left["y_centers"],
                "y_origin": answer_grid_left["y_origin"],
                "x_pitch": answer_grid_left["x_pitch"],
                "y_pitch": answer_grid_left["y_pitch"],
                "bubble_radius": answer_grid_left["bubble_radius"],
            },
            "answers_right": {
                "x_centers": answer_grid_right["x_centers"],
                "y_centers": answer_grid_right["y_centers"],
                "y_origin": answer_grid_right["y_origin"],
                "x_pitch": answer_grid_right["x_pitch"],
                "y_pitch": answer_grid_right["y_pitch"],
                "bubble_radius": answer_grid_right["bubble_radius"],
            },
        },
    }
    return profile, blank, filled


@unittest.skipIf(cv2 is None or np is None, "opencv-python/numpy are required")
class TemplateRegistrationTests(unittest.TestCase):
    def test_process_sheet_uses_canonical_template_production_flow(self):
        profile, _blank, filled = _build_process_sheet_fixture()
        image = _sheet_to_pil(filled)

        with patch.object(omr, "load_template_profile", return_value=profile), patch.object(
            omr,
            "fetch_answer_key",
            return_value={"answer_key": ["A"] * 25, "total_items": 25},
        ), patch.object(omr, "_REQUESTS_AVAILABLE", False), patch.object(
            omr,
            "_save_omr_debug",
        ) as save_debug:
            result = omr.process_sheet(image, 1, "http://example.test/api")

        self.assertEqual(result.status, "ok")
        self.assertEqual(result.student_code, "987654")
        self.assertEqual(result.exam_code, "244524")
        self.assertEqual(result.score, 25)
        self.assertEqual(result.max_score, 25)
        self.assertEqual(result.raw_answers.split("|"), ["A"] * 25)
        self.assertNotIn("DOUBLE_MARK_Q16", result.flag_reasons)

        save_args, save_kwargs = save_debug.call_args
        self.assertEqual(save_args[1].shape[:2], (omr.CANON_H, omr.CANON_W))
        self.assertEqual(save_kwargs["raw_binary"].shape[:2], (omr.CANON_H, omr.CANON_W))
        self.assertEqual(save_kwargs["blank_reference"].shape[:2], (omr.CANON_H, omr.CANON_W))
        payload = save_args[2]
        self.assertEqual(payload["coordinate_frame"], "canonical_template")
        self.assertTrue(payload["blank_reference_used"])
        self.assertEqual(payload["scan_quality"]["sections_failed"], [])
        self.assertEqual(payload["scan_quality"]["sections_registered"], [
            "student_code",
            "exam_code",
            "answers_left",
            "answers_right",
        ])

    def test_process_sheet_fails_closed_on_page_registration_failure(self):
        profile, _blank, _filled = _build_process_sheet_fixture()
        image = Image.fromarray(np.full((omr.CANON_H, omr.CANON_W), 255, dtype=np.uint8))

        with patch.object(omr, "load_template_profile", return_value=profile), patch.object(
            omr,
            "_REQUESTS_AVAILABLE",
            False,
        ), patch.object(omr, "_save_omr_debug") as save_debug:
            result = omr.process_sheet(image, 2, "http://example.test/api")

        self.assertEqual(result.status, "flagged")
        self.assertIn("UNREADABLE", result.flag_reasons)
        self.assertIn("PAGE_REGISTRATION_FAILED", result.flag_reasons)
        self.assertEqual(result.raw_answers, "")
        self.assertEqual(result.score, 0)
        self.assertEqual(result.max_score, 0)

        save_args, save_kwargs = save_debug.call_args
        self.assertIsNone(save_args[1])
        self.assertEqual(save_kwargs["raw_binary"].shape[:2], (omr.CANON_H, omr.CANON_W))
        payload = save_args[2]
        self.assertEqual(payload["coordinate_frame"], "raw_scan")
        self.assertEqual(payload["status"], "flagged")
        self.assertIn("PAGE_REGISTRATION_FAILED", payload["flag_reasons"])

    def test_template_profile_has_raw_and_canonical_anchors(self):
        profile = omr.load_template_profile(include_image=False)

        self.assertGreaterEqual(len(profile.get("raw_anchors", [])), 8)
        self.assertGreaterEqual(len(profile.get("anchors", [])), 8)

    def test_missing_page_anchors_fails_closed(self):
        image = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)

        with self.assertRaises(omr.UnreadableSheetError):
            omr.normalize_scan(image)

    def test_raw_anchor_normalization_maps_to_canonical_anchors(self):
        raw_points = [
            (100, 100), (1600, 100), (1600, 2300),
            (100, 2300), (850, 100), (850, 2300),
        ]
        canonical_points = [
            (80, 70), (1580, 70), (1580, 2270),
            (80, 2270), (830, 70), (830, 2270),
        ]
        profile = {
            "profile_loaded": True,
            "raw_size": [omr.CANON_W, omr.CANON_H],
            "raw_anchors": [_anchor(point) for point in raw_points],
            "anchors": [_anchor(point) for point in canonical_points],
        }
        image = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        marks = [_anchor(point) for point in raw_points]

        _normalized, debug = omr._apply_raw_template_anchor_normalization(image, marks, profile)

        self.assertEqual(debug["page_registration_method"], "raw_to_canonical_template_anchor_homography")
        self.assertEqual(debug["coordinate_frame"], "canonical_anchors")
        self.assertEqual(debug["page_registration"]["inliers"], len(canonical_points))
        for match, expected in zip(debug["anchor_matches"], canonical_points):
            self.assertEqual(match["raw_template_center"], [round(v, 2) for v in raw_points[match["template_index"]]])
            self.assertEqual(match["canonical_template_center"], [round(float(v), 2) for v in expected])
            self.assertLess(match["error"], 0.01)

    def test_mismatched_raw_and_canonical_anchor_counts_fail_profile_validation(self):
        profile = {
            "profile_loaded": True,
            "raw_size": [1000, 900],
            "raw_anchors": [_anchor((100, 100)) for _ in range(6)],
            "anchors": [_anchor((100, 100)) for _ in range(5)],
        }
        image = np.zeros((900, 1000), dtype=np.uint8)
        marks = [_anchor((100, 100)) for _ in range(6)]

        with self.assertRaisesRegex(omr.UnreadableSheetError, "TEMPLATE_PROFILE_INVALID"):
            omr._apply_raw_template_anchor_normalization(image, marks, profile)

    def test_global_anchor_assignment_prefers_complete_match_over_nearest_steal(self):
        templates = [_anchor((0, 0)), _anchor((100, 0))]
        candidates = [_anchor((40, 0)), _anchor((-70, 0))]

        matches = omr.match_template_anchors(candidates, templates, max_distance=80.0)

        self.assertEqual(len(matches), 2)
        self.assertEqual(matches[0]["template_index"], 0)
        self.assertEqual(matches[0]["detected_center"], [-70.0, 0.0])
        self.assertEqual(matches[1]["template_index"], 1)
        self.assertEqual(matches[1]["detected_center"], [40.0, 0.0])

    def test_top_right_anchor_cluster_uses_global_assignment(self):
        raw_points = [
            (1698.5, 2428.0), (72.0, 2413.0),
            (1700.0, 1231.5), (73.5, 1227.5),
            (1702.5, 151.5), (1703.0, 55.0),
            (1602.0, 53.5), (75.0, 42.5),
        ]
        profile = {
            "profile_loaded": True,
            "raw_size": [omr.CANON_W, omr.CANON_H],
            "raw_anchors": [_anchor(point) for point in raw_points],
            "anchors": [_anchor(point) for point in raw_points],
        }
        candidates = [
            _anchor((116.5, 1198.5)),
            _anchor((1717.5, 1277.5)),
            _anchor((49.5, 2359.0)),
            _anchor((1647.5, 37.5)),
            _anchor((140.0, 37.0)),
            _anchor((1730.5, 37.0)),
        ]

        matches, debug = omr.match_anchor_layout(candidates, profile)
        matched_indices = [match["template_index"] for match in matches]

        self.assertEqual(debug["assignment_method"], "global_min_cost")
        self.assertEqual(len(matches), 6)
        self.assertEqual(matched_indices, [1, 2, 3, 5, 6, 7])
        self.assertNotIn(4, matched_indices)
        self.assertIn(4, debug["unmatched_raw_anchor_indices"])
        self.assertEqual(debug["raw_matches"][3]["template_index"], 5)
        self.assertEqual(debug["raw_matches"][4]["template_index"], 6)
        self.assertIn("best_candidates", debug)

    def test_profile_guided_anchor_search_recovers_globally_missed_anchors(self):
        raw_points = [
            (100, 100), (1600, 100), (1600, 2300),
            (100, 2300), (850, 100), (850, 2300),
        ]
        canonical_points = [
            (80, 70), (1580, 70), (1580, 2270),
            (80, 2270), (830, 70), (830, 2270),
        ]
        profile = {
            "profile_loaded": True,
            "raw_size": [omr.CANON_W, omr.CANON_H],
            "raw_anchors": [_anchor(point) for point in raw_points],
            "anchors": [_anchor(point) for point in canonical_points],
        }
        image = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        for point in raw_points:
            _draw_anchor(image, point)
        globally_detected = [_anchor(point) for point in raw_points[:4]]

        _normalized, debug = omr._apply_raw_template_anchor_normalization(
            image,
            globally_detected,
            profile,
        )

        self.assertEqual(debug["page_registration_method"], "raw_to_canonical_template_anchor_homography")
        self.assertEqual(debug["page_registration"]["inliers"], 6)
        self.assertGreaterEqual(len(debug["anchor_detection"]["profile_guided_candidates"]), 6)
        self.assertEqual(debug["anchor_detection"]["unmatched_raw_anchor_indices"], [])

    def test_profile_guided_anchor_search_recovers_clipped_anchor(self):
        image = np.zeros((500, 500), dtype=np.uint8)
        cv2.rectangle(image, (410, 230), (489, 254), 255, -1)
        profile = {
            "profile_loaded": True,
            "raw_size": [500, 500],
            "raw_anchors": [_anchor((450, 242))],
        }

        guided = omr.detect_profile_guided_anchors(image, profile)

        self.assertEqual(len(guided), 1)
        self.assertEqual(guided[0]["source"], "profile_guided")
        self.assertLess(guided[0]["distance_to_expected"], 5)
        self.assertGreater(guided[0]["bbox"][2] / guided[0]["bbox"][3], 2.5)

    def test_noisy_full_span_anchors_pass_strict_validated_homography(self):
        raw_points = [
            (100, 100), (1600, 100), (1600, 2300), (100, 2300),
            (850, 100), (850, 2300), (1600, 1200), (100, 1200),
        ]
        marks = [
            _anchor((100, 100)),
            _anchor((1608, 94)),
            _anchor((1595, 2310)),
            _anchor((97, 2292)),
            _anchor((858, 105)),
            _anchor((845, 2294)),
            _anchor((1612, 1193)),
            _anchor((94, 1208)),
        ]
        profile = {
            "profile_loaded": True,
            "raw_size": [omr.CANON_W, omr.CANON_H],
            "raw_anchors": [_anchor(point) for point in raw_points],
            "anchors": [_anchor(point) for point in raw_points],
        }
        image = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)

        _normalized, debug = omr._apply_raw_template_anchor_normalization(image, marks, profile)

        self.assertEqual(debug["page_registration_method"], "raw_to_canonical_template_anchor_homography")
        self.assertGreaterEqual(debug["page_registration"]["inliers"], 6)
        self.assertLessEqual(debug["page_registration_max_error"], omr.PAGE_MAX_INLIER_ERROR)

    def test_template_profile_disables_bad_aspect_four_corner_fallback(self):
        image = np.zeros((900, 1000), dtype=np.uint8)
        with patch.object(
            omr,
            "_apply_raw_template_anchor_normalization",
            side_effect=omr.UnreadableSheetError(
                "TEMPLATE_RAW_TO_CANONICAL_ANCHORS_MISSING",
                {"anchor_detection": {"merged_candidates": []}},
            ),
        ), patch.object(omr, "_choose_registration_corners") as choose:
            with self.assertRaisesRegex(omr.UnreadableSheetError, "TEMPLATE_RAW_TO_CANONICAL_ANCHORS_MISSING") as ctx:
                omr.normalize_scan(image, use_template_profile=True)

        choose.assert_not_called()
        self.assertIn("four-corner page-edge registration is disabled", ctx.exception.debug["fallback_disabled_reason"])
        self.assertNotIn("REGISTRATION_MARKS_BAD_ASPECT", str(ctx.exception))

    def test_missing_template_anchors_fails_with_anchor_registration_debug(self):
        raw_points = [
            (100, 100), (900, 100), (900, 800),
            (100, 800), (500, 100), (500, 800),
        ]
        profile = {
            "profile_loaded": True,
            "raw_size": [1000, 900],
            "raw_anchors": [_anchor(point) for point in raw_points],
            "anchors": [_anchor(point) for point in raw_points],
        }
        image = np.zeros((900, 1000), dtype=np.uint8)

        with self.assertRaisesRegex(omr.UnreadableSheetError, "TEMPLATE_ANCHOR_REGISTRATION_FAILED") as ctx:
            omr._apply_raw_template_anchor_normalization(
                image,
                [_anchor(point) for point in raw_points[:3]],
                profile,
            )

        self.assertIn("anchor_detection", ctx.exception.debug)
        self.assertIn(3, ctx.exception.debug["anchor_detection"]["unmatched_raw_anchor_indices"])

    def test_anchor_matches_clustered_on_one_side_fail_span_validation(self):
        raw_points = [
            (100, 100), (300, 100), (500, 100),
            (100, 300), (300, 300), (500, 300),
        ]
        profile = {
            "profile_loaded": True,
            "raw_size": [1000, 900],
            "raw_anchors": [_anchor(point) for point in raw_points],
            "anchors": [_anchor(point) for point in raw_points],
        }
        image = np.zeros((900, 1000), dtype=np.uint8)

        with self.assertRaisesRegex(omr.UnreadableSheetError, "ANCHOR_SPAN_INSUFFICIENT") as ctx:
            omr._apply_raw_template_anchor_normalization(
                image,
                [_anchor(point) for point in raw_points],
                profile,
            )

        self.assertFalse(ctx.exception.debug["anchor_span"]["accepted"])

    def test_one_sided_anchor_set_fails_closed_in_production(self):
        raw_points = [
            (100, 100), (1600, 100), (1600, 1200), (100, 1200),
            (1600, 2300), (100, 2300), (850, 100), (850, 2300),
        ]
        canonical_points = [
            (80, 70), (1580, 70), (1580, 1200), (80, 1200),
            (1580, 2270), (80, 2270), (830, 70), (830, 2270),
        ]
        profile = {
            "profile_loaded": True,
            "raw_size": [omr.CANON_W, omr.CANON_H],
            "raw_anchors": [_anchor(point) for point in raw_points],
            "anchors": [_anchor(point) for point in canonical_points],
        }
        image = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        left_edge_marks = [_anchor(raw_points[index]) for index in [0, 3, 5]]

        with self.assertRaisesRegex(omr.UnreadableSheetError, "ANCHOR_SPAN_INSUFFICIENT") as ctx:
            omr._apply_raw_template_anchor_normalization(image, left_edge_marks, profile)

        self.assertFalse(ctx.exception.debug["anchor_span"]["accepted"])
        self.assertEqual(ctx.exception.debug["anchor_detection"]["matched_anchor_count"], 3)
        self.assertEqual(ctx.exception.debug["page_registration_attempts"], [])

    def test_calibration_mode_still_uses_four_corner_registration(self):
        image = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        for point in [(100, 100), (1300, 100), (1300, 1800), (100, 1800)]:
            _draw_anchor(image, point)

        _normalized, debug = omr.normalize_scan(image, use_template_profile=False)

        self.assertEqual(debug["page_registration_method"], "four_corner_marks")
        self.assertEqual(debug["registration_mark_method"], "four_corner_calibration")

    def test_section_registration_succeeds_after_raw_to_canonical_normalization(self):
        canonical = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        _draw_grid(canonical, omr.EXAM_CODE_GRID, labels="digits")

        dx, dy = 20, 15
        matrix = np.float32([[1, 0, dx], [0, 1, dy]])
        raw = cv2.warpAffine(canonical, matrix, (omr.CANON_W, omr.CANON_H))
        canonical_anchors = [
            (140, 140), (1610, 140), (1610, 2320),
            (140, 2320), (875, 140), (875, 2320),
        ]
        raw_anchors = [(x + dx, y + dy) for x, y in canonical_anchors]
        profile = {
            "profile_loaded": True,
            "raw_size": [omr.CANON_W, omr.CANON_H],
            "raw_anchors": [_anchor(point) for point in raw_anchors],
            "anchors": [_anchor(point) for point in canonical_anchors],
        }

        normalized, _debug = omr._apply_raw_template_anchor_normalization(
            raw,
            [_anchor(point) for point in raw_anchors],
            profile,
        )
        _grid, meta = omr.register_section(normalized, "exam_code", profile, canonical)

        self.assertEqual(meta["status"], "ok")
        self.assertLess(abs(meta["translation"][0]), 3)
        self.assertLess(abs(meta["translation"][1]), 3)

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

    def test_template_section_shift_within_bounds_registers(self):
        blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        live = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        _draw_grid(blank, omr.EXAM_CODE_GRID, labels="digits")
        shifted = _shifted_grid(omr.EXAM_CODE_GRID, dx=18, dy=12)
        _draw_grid(live, shifted, labels="digits")

        grid, meta = omr.register_section(live, "exam_code", None, blank)

        self.assertEqual(meta["status"], "ok")
        self.assertLessEqual(abs(meta["translation"][0]), omr.SECTION_MAX_TRANSLATION)
        self.assertAlmostEqual(omr._bubble_center(grid, 0, 0)[0], omr._bubble_center(shifted, 0, 0)[0], delta=2)

    def test_section_registration_reads_from_live_lattice_centers(self):
        blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        live = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        template_grid = omr.ANSWER_GRID_RIGHT
        row_drifts = [3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        live_grid = _row_drifted_grid(template_grid, dx=6, row_drifts=row_drifts)
        _draw_grid(blank, template_grid, labels="letters")
        _draw_grid(live, live_grid, labels="letters")
        _fill_cell(live, live_grid, 0, 0)

        with patch.object(
            omr,
            "_section_match_translation",
            return_value=(6, -6, 1.0, {"method": "test", "score": 1.0}),
        ):
            grid, meta = omr.register_section(live, "answers_right", None, blank)

        self.assertEqual(meta["read_grid_source"], "live_lattice")
        self.assertEqual(grid["read_grid_source"], "live_lattice")
        self.assertAlmostEqual(grid["y_centers"][0], live_grid["y_centers"][0], delta=2)
        self.assertAlmostEqual(grid["template_y_centers"][0], template_grid["y_centers"][0], delta=0.01)

        flags = []
        answers = omr.read_answer_grid(
            live,
            grid,
            16,
            flags,
            max_item=16,
            blank_reference=blank,
        )

        self.assertEqual(answers[0], "A")
        self.assertNotIn("DOUBLE_MARK_Q16", flags)

    def test_excessive_live_lattice_drift_is_rejected(self):
        blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        live = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        template_grid = omr.ANSWER_GRID_RIGHT
        _draw_grid(blank, template_grid, labels="letters")
        _draw_grid(live, template_grid, labels="letters")
        drifted = _row_drifted_grid(
            template_grid,
            row_drifts=[omr.SECTION_MAX_LIVE_DRIFT + 5] + [0] * 14,
        )
        drifted.update({
            "x_pitch": template_grid["x_pitch"],
            "y_pitch": template_grid["y_pitch"],
            "registration_method": "bubble_lattice",
        })
        live_meta = {
            "coverage": 1.0,
            "x_pitch": template_grid["x_pitch"],
            "y_pitch": template_grid["y_pitch"],
            "local_offsets": {},
        }

        with patch.object(
            omr,
            "_section_match_translation",
            return_value=(0, 0, 1.0, {"method": "test", "score": 1.0}),
        ), patch.object(
            omr,
            "refine_section_geometry",
            return_value=(drifted, live_meta),
        ):
            with self.assertRaisesRegex(omr.SectionRegistrationError, "live lattice drift"):
                omr.register_section(live, "answers_right", None, blank)

    def test_template_section_shift_beyond_bounds_is_rejected(self):
        blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        live = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)

        with patch.object(
            omr,
            "_section_match_translation",
            return_value=(
                omr.SECTION_MAX_TRANSLATION + 10,
                0,
                1.0,
                {"method": "test", "score": 1.0},
            ),
        ):
            with self.assertRaises(omr.SectionRegistrationError):
                omr.register_section(live, "exam_code", None, blank)

    def test_paired_blank_subtraction_handles_shifted_live_grid(self):
        blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        live = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        template_grid = omr.ANSWER_GRID_LEFT
        live_grid = _shifted_grid(template_grid, dx=20, dy=10)
        live_grid.update({
            "template_x_centers": omr._grid_x_centers(template_grid),
            "template_y_centers": omr._grid_y_centers(template_grid),
        })
        _draw_grid(blank, template_grid, labels="letters")
        _draw_grid(live, live_grid, labels="letters")
        _fill_cell(live, live_grid, 1, 0)

        empty_x, empty_y = omr._bubble_center(live_grid, 0, 0)
        empty_tx, empty_ty = omr._template_bubble_center(live_grid, 0, 0)
        filled_x, filled_y = omr._bubble_center(live_grid, 1, 0)
        filled_tx, filled_ty = omr._template_bubble_center(live_grid, 1, 0)

        empty_ratio = omr.blank_corrected_fill_ratio(
            live, blank, empty_x, empty_y, int(live_grid["bubble_radius"]), empty_tx, empty_ty,
        )
        filled_ratio = omr.blank_corrected_fill_ratio(
            live, blank, filled_x, filled_y, int(live_grid["bubble_radius"]), filled_tx, filled_ty,
        )

        self.assertLess(empty_ratio, 0.10)
        self.assertGreater(filled_ratio, 0.35)

    def test_answer_double_mark_is_flagged_even_with_darker_winner(self):
        blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        live = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        grid = omr.ANSWER_GRID_LEFT
        _draw_grid(blank, grid, labels="letters")
        _draw_grid(live, grid, labels="letters")
        _fill_cell(live, grid, 0, 0)
        cx, cy = omr._bubble_center(grid, 1, 0)
        cv2.circle(live, (cx, cy), int(grid["bubble_radius"]) - 8, 255, -1)
        flags = []

        answers = omr.read_answer_grid(live, grid, 1, flags, max_item=1, blank_reference=blank)

        self.assertIsNone(answers[0])
        self.assertIn("DOUBLE_MARK_Q1", flags)

    def test_light_but_dominant_answer_is_accepted(self):
        blank = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        live = np.zeros((omr.CANON_H, omr.CANON_W), dtype=np.uint8)
        grid = omr.ANSWER_GRID_LEFT
        _draw_grid(blank, grid, labels="letters")
        _draw_grid(live, grid, labels="letters")
        cx, cy = omr._bubble_center(grid, 2, 0)
        cv2.circle(live, (cx, cy), int(grid["bubble_radius"]) - 7, 255, -1)
        flags = []

        answers = omr.read_answer_grid(live, grid, 1, flags, max_item=1, blank_reference=blank)

        self.assertEqual(answers[0], "C")
        self.assertNotIn("NO_ANSWER_Q1", flags)


if __name__ == "__main__":
    unittest.main()
