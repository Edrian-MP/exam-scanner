"""
Replay saved scans through the OMR engine and compare them with expected values.

Expected file format:
{
  "scan_1.png": {
    "student_code": "654321",
    "exam_code": "244524",
    "answers": ["A", "B", "C"]
  }
}
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image

import omr


IMAGE_EXTS = {".bmp", ".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def _parse_expected(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _answers_from_raw(raw_answers: str) -> list[str | None]:
    if not raw_answers:
        return []
    return [item or None for item in raw_answers.split("|")]


def _compare(result: omr.SheetResult, expected: dict[str, Any]) -> dict[str, Any]:
    checks: dict[str, Any] = {}
    if "student_code" in expected:
        checks["student_code"] = result.student_code == str(expected["student_code"])
    if "exam_code" in expected:
        checks["exam_code"] = result.exam_code == str(expected["exam_code"])
    if "answers" in expected and isinstance(expected["answers"], list):
        actual_answers = _answers_from_raw(result.raw_answers)
        expected_answers = [a if a else None for a in expected["answers"]]
        checks["answers"] = actual_answers[:len(expected_answers)] == expected_answers
        checks["answer_mismatches"] = [
            {
                "item": index + 1,
                "expected": exp,
                "actual": actual_answers[index] if index < len(actual_answers) else None,
            }
            for index, exp in enumerate(expected_answers)
            if index >= len(actual_answers) or actual_answers[index] != exp
        ]
    passed = all(value for key, value in checks.items() if key != "answer_mismatches")
    return {"passed": passed, "checks": checks}


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay saved scans through scanner-service OMR.")
    parser.add_argument("scan_dir", type=Path, help="Folder containing saved scan images.")
    parser.add_argument("--expected", type=Path, default=None, help="JSON file of expected outputs.")
    parser.add_argument("--api-base", default="http://localhost/exam-scanner/backend/api")
    args = parser.parse_args()

    if not args.scan_dir.exists():
        parser.error(f"scan_dir not found: {args.scan_dir}")

    expected = _parse_expected(args.expected)
    files = [
        p for p in sorted(args.scan_dir.iterdir())
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    ]
    if not files:
        parser.error(f"no scan images found in: {args.scan_dir}")

    rows = []
    accepted = 0
    passed = 0
    for index, path in enumerate(files, start=1):
        image = Image.open(path)
        result = omr.process_sheet(image, index, args.api_base)
        comparison = _compare(result, expected.get(path.name, {}))
        accepted += int(result.status == "ok")
        passed += int(bool(comparison["passed"]))
        rows.append({
            "file": path.name,
            "status": result.status,
            "student_code": result.student_code,
            "exam_code": result.exam_code,
            "score": result.score,
            "max_score": result.max_score,
            "flags": result.flag_reasons,
            **comparison,
        })

    summary = {
        "total": len(files),
        "accepted": accepted,
        "passed": passed,
        "acceptance_rate": round(accepted / len(files), 4),
        "pass_rate": round(passed / len(files), 4),
        "results": rows,
    }
    print(json.dumps(summary, indent=2))
    return 0 if passed == len(files) else 1


if __name__ == "__main__":
    raise SystemExit(main())
