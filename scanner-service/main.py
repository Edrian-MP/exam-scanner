#!/usr/bin/env python3
"""
Local scanner service (Windows) — batch OMR scanning via WIA + Arduino feeder.

Endpoints
---------
GET  /status         → scanner / Arduino connection status
POST /scan           → legacy single-scan (kept for backwards compatibility)
POST /batch-scan     → start a background batch scan loop for a session
                       (single=true: one hand-fed sheet, no Arduino feeder)
POST /batch-stop     → signal the running batch loop to stop
"""

from __future__ import annotations

import argparse
import getpass
import io
import json
import logging
import os
import socket
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import omr  # local module

# ── Optional dependencies ─────────────────────────────────────────────────────

try:
    import serial  # type: ignore
    _SERIAL_AVAILABLE = True
except Exception:
    serial = None  # type: ignore
    _SERIAL_AVAILABLE = False

try:
    import pythoncom        # type: ignore
    import win32com.client  # type: ignore
    _WIA_AVAILABLE = True
except Exception:
    pythoncom = None        # type: ignore
    win32com = None         # type: ignore
    _WIA_AVAILABLE = False

try:
    from PIL import Image  # type: ignore
    _PIL_AVAILABLE = True
except Exception:
    Image = None  # type: ignore
    _PIL_AVAILABLE = False

try:
    import requests as _requests
    _REQUESTS_AVAILABLE = True
except Exception:
    _requests = None  # type: ignore
    _REQUESTS_AVAILABLE = False

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Also keep a log file so feeder/scanner problems can be diagnosed after the fact
try:
    _LOG_DIR = Path(__file__).resolve().parent / "logs"
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    _file_handler = logging.FileHandler(_LOG_DIR / "scanner-service.log", encoding="utf-8")
    _file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger().addHandler(_file_handler)
except Exception as _exc:  # never let logging setup stop the service
    logger.warning("Could not open log file: %s", _exc)

# ── Configuration ─────────────────────────────────────────────────────────────
PHP_API_BASE      = "http://localhost/exam-scanner/backend/api"
SERIAL_PORT       = "COM4"
SERIAL_BAUD       = 9600
SERIAL_TIMEOUT    = 70      # total seconds to wait for pre-feed clear + Arduino feed retries
SERIAL_READ_TIMEOUT = 0.2   # short serial poll interval so Stop Scan can interrupt FEED waits
INTER_SHEET_DELAY = 0     # seconds between sheets
MAX_UNREADABLE    = 40       # consecutive unreadable sheets before stopping
STOP_WAIT_SECONDS = 8.0     # max time /batch-stop waits for scanner loop shutdown
ADF_WAIT_TIMEOUT  = 30      # seconds to wait for user to insert the next paper
ADF_POLL_INTERVAL = 2       # seconds between ADF-empty retry attempts
# If the scanner reports ADF empty right after the feeder said SHEET_FED, the
# sheet stopped short of the scanner rollers: tap it in with the Arduino's PUSH
# command and retry the scan. One entry per try, with more taps each time.
HANDOFF_NUDGE_TAPS    = (4, 6, 8)
HANDOFF_NUDGE_SETTLE  = 0.3  # seconds after PUSH_DONE before rescanning
PUSH_REPLY_TIMEOUT    = 5.0  # seconds to wait for PUSH_DONE
SINGLE_WAIT_TIMEOUT = 60    # seconds to wait for a hand-fed sheet in single-scan mode
WIA_TRANSFER_TIMEOUT = 90   # seconds before a stuck WIA transfer is reported as a hang
MAX_TRANSIENT_RETRIES = 10  # busy/warming-up/offline retries (ADF_POLL_INTERVAL apart) per sheet
OUT_DIR           = Path(__file__).resolve().parent / "scans"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Set True when paper is fed landscape (long edge first) into the ES-50.
# This swaps the WIA scan extents so the full paper width is captured,
# then rotates the result to portrait before OMR processing.
# False = portrait feed: short edge first, TOP edge (header) entering the scanner
# first, so the scan comes out upright with no rotation. Portrait was tried and
# pinched the sheet's tail in the feeder roller, so landscape is back in use.
LANDSCAPE_FEED_MODE = True
FINAL_FEED_STATUSES = {"SHEET_FED", "NO_PAPER", "PAPER_JAM", "FEED_CANCELLED"}


# ── Global state ──────────────────────────────────────────────────────────────

class ScannerState:
    def __init__(self) -> None:
        self.last_scan_at: str | None = None
        self.last_output: str | None = None
        self.last_batch_session_id: str | None = None
        self.last_batch_reason: str | None = None
        self.last_batch_message: str | None = None
        self.active_session_id: str | None = None
        self.waiting_for_paper: bool = False
        self._batch_thread: threading.Thread | None = None
        self._stop_flag   = threading.Event()
        self._batch_lock  = threading.Lock()
        self._batch_running = False

    def scanner_connected(self) -> bool:
        return _WIA_AVAILABLE

    def arduino_connected(self) -> bool:
        return _SERIAL_AVAILABLE

    def request_stop(self) -> None:
        self._stop_flag.set()

    def clear_stop(self) -> None:
        self._stop_flag.clear()

    def should_stop(self) -> bool:
        return self._stop_flag.is_set()

    def start_batch(self, session_id: str) -> bool:
        """Return True if a batch was successfully started (not already running)."""
        with self._batch_lock:
            if self._batch_running:
                return False
            self._stop_flag.clear()
            self._batch_running = True
            self.active_session_id = session_id
            self._batch_thread = None
            self.last_batch_session_id = None
            self.last_batch_reason = None
            self.last_batch_message = None
            return True

    def attach_thread(self, thread: threading.Thread) -> None:
        with self._batch_lock:
            self._batch_thread = thread

    def end_batch(self, session_id: str, reason: str, message: str) -> None:
        with self._batch_lock:
            self._batch_running = False
            self.active_session_id = None
            self._batch_thread = None
            self._stop_flag.clear()
            self.last_batch_session_id = session_id
            self.last_batch_reason = reason
            self.last_batch_message = message

    def wait_until_idle(self, timeout: float = STOP_WAIT_SECONDS) -> bool:
        with self._batch_lock:
            thread = self._batch_thread
        if thread is not None and thread is not threading.current_thread() and thread.is_alive():
            thread.join(timeout=timeout)
        with self._batch_lock:
            idle = not self._batch_running
            if idle:
                self._stop_flag.clear()
            return idle

    @property
    def is_running(self) -> bool:
        with self._batch_lock:
            return self._batch_running

    def snapshot(self) -> dict[str, Any]:
        with self._batch_lock:
            return {
                "batch_running": self._batch_running,
                "active_session_id": self.active_session_id,
                "stop_requested": self._stop_flag.is_set(),
                "waiting_for_paper": self.waiting_for_paper,
                "last_batch_session_id": self.last_batch_session_id,
                "last_batch_reason": self.last_batch_reason,
                "last_batch_message": self.last_batch_message,
            }


STATE = ScannerState()


# ── WIA helpers ───────────────────────────────────────────────────────────────

def _is_adf_empty_error(exc: Exception) -> bool:
    """Return True for WIA errors that mean the ADF has no paper (not a real scan failure)."""
    s = str(exc).lower()
    return "-2145320957" in str(exc) or "no documents" in s or "paper empty" in s


# WIA errors that mean "not ready yet", not "this sheet failed": the scanner is
# busy finishing the last sheet, warming up / waking from sleep, or briefly
# dropped off USB. Retrying a few seconds later normally succeeds.
_TRANSIENT_WIA_CODES = (
    "-2145320955",  # WIA_ERROR_OFFLINE
    "-2145320954",  # WIA_ERROR_BUSY
    "-2145320953",  # WIA_ERROR_WARMING_UP
    "-2145320950",  # WIA_ERROR_DEVICE_COMMUNICATION
    "-2145320947",  # WIA_ERROR_DEVICE_LOCKED
    "-2145320939",  # WIA_S_NO_DEVICE_AVAILABLE
)


def _is_transient_wia_error(exc: Exception) -> bool:
    text = str(exc)
    return any(code in text for code in _TRANSIENT_WIA_CODES) or "No WIA scanner device found" in text


class ScanTimeoutError(RuntimeError):
    """The WIA transfer did not return within WIA_TRANSFER_TIMEOUT."""


def scan_sheet_wia_with_timeout(timeout: float = WIA_TRANSFER_TIMEOUT) -> "Image.Image":
    """Run scan_sheet_wia in a worker thread so a hung driver can't freeze the batch."""
    result: dict[str, Any] = {}

    def worker() -> None:
        if pythoncom is not None:
            pythoncom.CoInitialize()
        try:
            result["image"] = scan_sheet_wia()
        except Exception as exc:
            result["error"] = exc
        finally:
            if pythoncom is not None:
                pythoncom.CoUninitialize()

    thread = threading.Thread(target=worker, name="wia-transfer", daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise ScanTimeoutError(f"WIA transfer did not finish within {timeout:.0f}s")
    if "error" in result:
        raise result["error"]
    return result["image"]


# ── WIA scanning ──────────────────────────────────────────────────────────────

def scan_sheet_wia() -> "Image.Image":
    """Trigger WIA scan on the ES-50 and return a PIL Image (grayscale, 300 DPI)."""
    if not _WIA_AVAILABLE or not _PIL_AVAILABLE:
        raise RuntimeError("WIA (pywin32) or PIL not available.")

    wia = win32com.client.Dispatch("WIA.CommonDialog")
    device_manager = win32com.client.Dispatch("WIA.DeviceManager")

    # Auto-select first available scanner device
    device = None
    for info in device_manager.DeviceInfos:
        if info.Type == 1:  # ScannerDeviceType
            device = info.Connect()
            break

    if device is None:
        raise RuntimeError("No WIA scanner device found.")

    item = device.Items[1]
    # 300 DPI, grayscale
    item.Properties["Horizontal Resolution"].Value = 300
    item.Properties["Vertical Resolution"].Value   = 300
    item.Properties["Current Intent"].Value        = 4  # grayscale
    h_extent = omr.CANON_H if LANDSCAPE_FEED_MODE else omr.CANON_W
    v_extent = omr.CANON_W if LANDSCAPE_FEED_MODE else omr.CANON_H
    for prop_name, value in (
        ("Horizontal Start Position", 0),
        ("Vertical Start Position", 0),
        ("Horizontal Extent", h_extent),
        ("Vertical Extent", v_extent),
    ):
        try:
            item.Properties[prop_name].Value = value
        except Exception as exc:
            logger.debug("WIA property %s=%s was ignored: %s", prop_name, value, exc)

    logger.info("WIA Transfer starting")
    image_file = item.Transfer("{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}")  # BMP
    logger.info("WIA Transfer completed")
    raw = bytes(image_file.FileData.BinaryData)
    image = Image.open(io.BytesIO(raw))
    logger.info("WIA returned scan size: %sx%s", image.width, image.height)
    if LANDSCAPE_FEED_MODE:
        image = image.transpose(Image.Transpose.ROTATE_270)  # landscape → portrait (CW 90°)
        logger.info("Landscape mode: rotated to %sx%s", image.width, image.height)
    return image


def scan_sheet_mock(sheet_index: int) -> "Image.Image":
    """Return a blank white image for testing without hardware."""
    if not _PIL_AVAILABLE:
        raise RuntimeError("Pillow not available.")
    return Image.new("L", (850, 1100), color=255)


# ── Arduino feeder ────────────────────────────────────────────────────────────

def send_arduino_command(ser: Any, command: str) -> None:
    """Send a one-way command to the Arduino."""
    ser.write(f"{command}\n".encode("utf-8"))
    if hasattr(ser, "flush"):
        ser.flush()


def feed_one_sheet(ser: Any) -> str:
    """Send FEED command and return the Arduino's final feed status."""
    if hasattr(ser, "reset_input_buffer"):
        ser.reset_input_buffer()
    logger.info("FEED sent")
    send_arduino_command(ser, "FEED")

    deadline = time.time() + SERIAL_TIMEOUT
    while time.time() < deadline:
        if STATE.should_stop():
            logger.info("Stop requested during Arduino feed wait; sending STOP.")
            send_arduino_command(ser, "STOP")
            cancel_deadline = time.time() + 3.0
            while time.time() < cancel_deadline:
                line = ser.readline().decode("utf-8", errors="ignore").strip()
                if not line:
                    continue
                logger.info("Arduino feeder: %s", line)
                if line in FINAL_FEED_STATUSES:
                    return "FEED_CANCELLED"
            return "FEED_CANCELLED"

        line = ser.readline().decode("utf-8", errors="ignore").strip()
        if not line:
            continue
        logger.info("Arduino feeder: %s", line)
        if line == "SHEET_FED":
            logger.info("SHEET_FED received")
            return line
        if line in FINAL_FEED_STATUSES:
            return line
    logger.warning("Arduino feed timed out after %ss; sending STOP.", SERIAL_TIMEOUT)
    send_arduino_command(ser, "STOP")
    return "TIMEOUT"


def push_sheet_into_scanner(ser: Any, taps: int) -> bool:
    """Tap a sheet that stopped short into the scanner; True once the Arduino reports PUSH_DONE."""
    send_arduino_command(ser, f"PUSH:{taps}")
    deadline = time.time() + PUSH_REPLY_TIMEOUT
    while time.time() < deadline:
        line = ser.readline().decode("utf-8", errors="ignore").strip()
        if not line:
            continue
        logger.info("Arduino feeder: %s", line)
        if line == "PUSH_DONE":
            return True
    logger.warning("No PUSH_DONE from Arduino within %ss (old sketch uploaded?)", PUSH_REPLY_TIMEOUT)
    return False


# ── Post sheet result to PHP API ──────────────────────────────────────────────

def post_sheet_to_api(session_id: str, result_dict: dict) -> None:
    if not _REQUESTS_AVAILABLE:
        logger.warning("requests not installed — cannot post sheet to API")
        return
    url = f"{PHP_API_BASE}/scan/session/{session_id}/sheet"
    try:
        resp = _requests.post(url, json=result_dict, timeout=10)
        if not resp.ok:
            logger.warning("API rejected sheet: %s", resp.text[:200])
    except Exception as exc:
        logger.warning("post_sheet_to_api failed: %s", exc)


# ── Batch scan loop ───────────────────────────────────────────────────────────

def _batch_loop(session_id: str, use_hardware: bool, single: bool = False, online=None) -> None:
    """
    Background thread: feed + scan + post loop.
    Stops on: stop flag, no-paper timeout, or MAX_UNREADABLE consecutive failures.
    In single mode the Arduino feeder is skipped and the loop ends after one sheet.
    """
    ser = None
    com_initialized = False
    batch_reason = "stopped"
    batch_message = "Batch stopped."
    try:
        if pythoncom is not None and use_hardware:
            pythoncom.CoInitialize()
            com_initialized = True
        sheet_index     = 0
        consecutive_bad = 0
        answer_key_lookup = None if online is None else lambda code: online.fetch_answer_key(session_id, code)

        if use_hardware and _SERIAL_AVAILABLE and not single:
            try:
                ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=SERIAL_READ_TIMEOUT)
                time.sleep(2)  # wait for Arduino to boot
                send_arduino_command(ser, "BEEP_START")
            except Exception as exc:
                logger.warning("Could not open serial port %s: %s", SERIAL_PORT, exc)
                if online is not None:
                    batch_reason = "hardware_error"
                    batch_message = "Could not open the Arduino feeder port."
                    return
                ser = None

        while not STATE.should_stop():
            sheet_index += 1

            # 1. Feed one sheet (Arduino or no-op in mock mode)
            if ser is not None:
                feed_status = feed_one_sheet(ser)
                if feed_status == "FEED_CANCELLED":
                    logger.info("Arduino feed cancelled - stopping batch.")
                    batch_reason = "stopped"
                    batch_message = "Batch stopped."
                    break
                if feed_status == "NO_PAPER":
                    logger.info("No paper in feeder — stopping batch.")
                    batch_reason = "completed"
                    batch_message = "No paper in feeder. Batch scan complete."
                    send_arduino_command(ser, "BEEP_FINISH")
                    break
                if feed_status != "SHEET_FED":
                    logger.error("Feeder failed with status %s - stopping batch.", feed_status)
                    batch_reason = "feeder_error"
                    batch_message = f"Feeder failed with status {feed_status}."
                    break
            else:
                time.sleep(0.2)  # simulate feed delay in mock mode

            if STATE.should_stop():
                batch_reason = "stopped"
                batch_message = "Batch stopped."
                break

            # 2. Scan — poll until paper is inserted, timeout, or stop requested.
            pil_image = None
            if use_hardware and _WIA_AVAILABLE and _PIL_AVAILABLE:
                wait_timeout = SINGLE_WAIT_TIMEOUT if single else ADF_WAIT_TIMEOUT
                wait_deadline = time.time() + wait_timeout
                logged_waiting = False
                nudges = 0
                transient_retries = 0
                if single:
                    STATE.waiting_for_paper = True
                while not STATE.should_stop():
                    try:
                        pil_image = scan_sheet_wia_with_timeout()
                        break  # success
                    except ScanTimeoutError as exc:
                        # The driver is stuck; further scans would block too.
                        logger.error("Scanner hung: %s", exc)
                        batch_reason = "scan_error"
                        batch_message = (
                            f"Scanner stopped responding on sheet {sheet_index}. "
                            "Unplug and reconnect the scanner, then restart the scanner service."
                        )
                        STATE.waiting_for_paper = False
                        break
                    except Exception as exc:
                        if _is_transient_wia_error(exc) and transient_retries < MAX_TRANSIENT_RETRIES:
                            # scanner not ready yet (busy / warming up / waking) — not a bad sheet
                            transient_retries += 1
                            logger.info(
                                "Scanner not ready (%s) — retry %d/%d in %ss",
                                exc, transient_retries, MAX_TRANSIENT_RETRIES, ADF_POLL_INTERVAL,
                            )
                            time.sleep(ADF_POLL_INTERVAL)
                            continue
                        if not _is_adf_empty_error(exc):
                            # Real scan error — post a flagged result and count it
                            logger.warning("Scan error: %s", exc)
                            result_dict = {
                                "sheet_index":  sheet_index,
                                "student_code": None,
                                "exam_code":    None,
                                "raw_answers":  "",
                                "score":        0,
                                "max_score":    0,
                                "status":       "flagged",
                                "flag_reasons": ["SCAN_ERROR"],
                                "scan_image":   "",
                            }
                            post_sheet_to_api(session_id, result_dict)
                            consecutive_bad += 1
                            if consecutive_bad >= MAX_UNREADABLE:
                                logger.error("Too many scan errors — aborting batch.")
                                batch_reason = "cancelled_failures"
                                batch_message = f"Batch cancelled after {MAX_UNREADABLE} consecutive scan failures."
                            else:
                                batch_reason = "scan_error"
                                batch_message = f"Scanner failed while scanning sheet {sheet_index}."
                            if consecutive_bad >= MAX_UNREADABLE and ser is not None:
                                send_arduino_command(ser, "BEEP_CANCEL_FAILURES")
                            STATE.waiting_for_paper = False
                            break
                        # ADF empty right after a feed: the sheet is probably
                        # sitting just short of the scanner rollers — nudge it in
                        if ser is not None and nudges < len(HANDOFF_NUDGE_TAPS):
                            taps = HANDOFF_NUDGE_TAPS[nudges]
                            nudges += 1
                            logger.info(
                                "ADF empty after SHEET_FED — pushing sheet into scanner "
                                "(%d taps, try %d/%d).",
                                taps, nudges, len(HANDOFF_NUDGE_TAPS),
                            )
                            push_sheet_into_scanner(ser, taps)
                            time.sleep(HANDOFF_NUDGE_SETTLE)
                            continue
                        # ADF empty — wait for the user to insert the next paper
                        if time.time() >= wait_deadline:
                            logger.info(
                                "ADF empty — no paper inserted within %ds — batch complete.",
                                wait_timeout,
                            )
                            if single:
                                batch_reason = "no_paper"
                                batch_message = f"No sheet was inserted within {wait_timeout} seconds."
                            else:
                                batch_reason = "completed"
                                batch_message = "Scanner ADF reported no more paper. Batch scan complete."
                            STATE.waiting_for_paper = False
                            break
                        if not logged_waiting:
                            logger.info(
                                "ADF empty after sheet %d — waiting up to %ds for next paper...",
                                sheet_index - 1,
                                ADF_WAIT_TIMEOUT,
                            )
                            logged_waiting = True
                            STATE.waiting_for_paper = True
                        time.sleep(ADF_POLL_INTERVAL)
                STATE.waiting_for_paper = False
            else:
                pil_image = scan_sheet_mock(sheet_index)

            if pil_image is None:
                break  # ADF timed out, stop requested, or hard scan error posted above

            # 3. OMR processing
            try:
                result = omr.process_sheet(pil_image, sheet_index, PHP_API_BASE, answer_key_lookup)
                result_dict = omr.sheet_result_to_dict(result)
                consecutive_bad = 0 if result.status == "ok" else consecutive_bad + 1
            except Exception as exc:
                logger.warning("OMR processing failed: %s", exc)
                result_dict = {
                    "sheet_index":  sheet_index,
                    "student_code": None,
                    "exam_code":    None,
                    "raw_answers":  "",
                    "score":        0,
                    "max_score":    0,
                    "status":       "flagged",
                    "flag_reasons": ["UNREADABLE"],
                    "scan_image":   "",
                }
                consecutive_bad += 1

            # 4. Save debug scan file
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            debug_path = OUT_DIR / f"session_{session_id[:8]}_{sheet_index}_{ts}.json"
            debug_path.write_text(json.dumps(result_dict, indent=2), encoding="utf-8")

            # 5. Post to PHP API
            if online is None:
                post_sheet_to_api(session_id, result_dict)
            else:
                try:
                    online.post_sheet(session_id, result_dict)
                except Exception as exc:
                    logger.warning("Could not upload scan; local copy saved in %s: %s", debug_path, exc)
                    batch_reason = "upload_failed"
                    batch_message = "Could not upload a scan. The scanner PC kept a local copy."
                    break

            STATE.last_scan_at = datetime.now().isoformat()
            STATE.last_output  = str(debug_path)

            if single:
                batch_reason = "completed"
                batch_message = "Single scan complete."
                break

            # 6. Safety cutoff
            if consecutive_bad >= MAX_UNREADABLE:
                logger.error("Too many unreadable sheets — aborting batch.")
                batch_reason = "cancelled_failures"
                batch_message = f"Batch cancelled after {MAX_UNREADABLE} consecutive scan failures."
                if ser is not None:
                    send_arduino_command(ser, "BEEP_CANCEL_FAILURES")
                break

            time.sleep(INTER_SHEET_DELAY)

    except Exception:
        logger.exception("Batch scan failed. session=%s", session_id)
        batch_reason = "failed"
        batch_message = "Scan failed. Check the scanner service log on the scanner PC."
    finally:
        try:
            if ser is not None:
                ser.close()
            if com_initialized:
                pythoncom.CoUninitialize()
        finally:
            STATE.waiting_for_paper = False
            STATE.end_batch(session_id, batch_reason, batch_message)
            logger.info("Batch scan finished. session=%s", session_id)


def start_batch(session_id: str, use_hardware: bool, single: bool, online=None) -> bool:
    if not STATE.start_batch(session_id):
        return False
    worker = threading.Thread(
        target=_batch_loop, args=(session_id, use_hardware, single, online), daemon=online is None,
    )
    STATE.attach_thread(worker)
    try:
        worker.start()
    except Exception:
        STATE.end_batch(session_id, "failed", "Could not start the scanner.")
        raise
    return True


# ── HTTP handler ──────────────────────────────────────────────────────────────

def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json_bytes(payload)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter logs
        logger.debug(fmt, *args)

    # ── GET ────────────────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/status":
            state_snapshot = STATE.snapshot()
            self._send(200, {
                "ok": True,
                "data": {
                    "scanner": {
                        "connected":         STATE.scanner_connected(),
                        "arduino":           STATE.arduino_connected(),
                        "batch_running":     state_snapshot["batch_running"],
                        "active_session_id": state_snapshot["active_session_id"],
                        "stop_requested":    state_snapshot["stop_requested"],
                        "waiting_for_paper": state_snapshot["waiting_for_paper"],
                        "last_batch_session_id": state_snapshot["last_batch_session_id"],
                        "last_batch_reason": state_snapshot["last_batch_reason"],
                        "last_batch_message": state_snapshot["last_batch_message"],
                        "driver":            "wia+arduino",
                        "last_scan_at":      STATE.last_scan_at,
                        "last_output":       STATE.last_output,
                    }
                },
            })
            return
        self._send(404, {"ok": False, "error": "Route not found"})

    # ── POST ───────────────────────────────────────────────────────────────────

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]

        # ── Legacy single scan ─────────────────────────────────────────────────
        if path == "/scan":
            payload = self._read_json()
            exam_id = int(payload.get("exam_id", 0))
            if exam_id < 1:
                self._send(400, {"ok": False, "error": "exam_id is required"})
                return

            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_path = OUT_DIR / f"exam_{exam_id}_{ts}.txt"
            output_path.write_text(
                f"MOCK_SCAN exam_id={exam_id} at {ts}\n", encoding="utf-8"
            )
            STATE.last_scan_at = datetime.now().isoformat()
            STATE.last_output  = str(output_path)

            self._send(200, {
                "ok": True,
                "data": {
                    "exam_id":          exam_id,
                    "file_path":        str(output_path),
                    "detected_sheets":  1,
                },
            })
            return

        # ── Start batch scan ───────────────────────────────────────────────────
        if path == "/batch-scan":
            payload    = self._read_json()
            session_id = str(payload.get("session_id", "")).strip()
            if not session_id:
                self._send(400, {"ok": False, "error": "session_id is required"})
                return

            use_hw = _WIA_AVAILABLE  # serial (Arduino) is optional; WIA drives hardware mode
            single = bool(payload.get("single", False))
            if not start_batch(session_id, use_hw, single):
                self._send(409, {"ok": False, "error": "A batch scan is already running"})
                return

            self._send(200, {"ok": True, "data": {
                "session_id":   session_id,
                "hardware_mode": use_hw,
                "single":       single,
            }})
            return

        # ── Stop batch scan ────────────────────────────────────────────────────
        if path == "/batch-stop":
            payload = self._read_json()
            session_id = str(payload.get("session_id", "")).strip()
            wait = bool(payload.get("wait", True))
            state_snapshot = STATE.snapshot()
            if (
                session_id
                and state_snapshot["active_session_id"]
                and session_id != state_snapshot["active_session_id"]
            ):
                self._send(409, {"ok": False, "error": "Another batch session is active", "data": state_snapshot})
                return

            STATE.request_stop()
            idle = STATE.wait_until_idle() if wait else not STATE.is_running
            state_snapshot = STATE.snapshot()
            self._send(200, {"ok": True, "data": {
                "idle": idle,
                "batch_running": state_snapshot["batch_running"],
                "active_session_id": state_snapshot["active_session_id"],
                "stop_requested": state_snapshot["stop_requested"],
            }})
            return

        self._send(404, {"ok": False, "error": "Route not found"})


# ── Entry point ───────────────────────────────────────────────────────────────

class ScannerServer(ThreadingHTTPServer):
    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.allow_reuse_address = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def run_online(api_url: str, pairing: bool, simulate: bool) -> None:
    from online_scanner import OnlineScanner

    token_file = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "ExamScanner" / "online-scanner-token"
    if pairing:
        token = getpass.getpass("Scanner code from the website: ").strip()
        client = OnlineScanner(api_url, token, simulate)
        token_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with open(token_file, "w", encoding="ascii", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
            output.write(token + "\n")
    else:
        token = os.environ.get("EXAM_SCANNER_DEVICE_TOKEN")
        if not token and token_file.exists():
            token = token_file.read_text(encoding="ascii").strip()
        if not token:
            raise ValueError("Run with --pair-online and paste the scanner code from the website.")
        client = OnlineScanner(api_url, token, simulate)

    def hardware_status():
        if simulate:
            return True, True
        scanner_ready = _WIA_AVAILABLE and _PIL_AVAILABLE and omr._CV2_AVAILABLE
        if not _SERIAL_AVAILABLE:
            return scanner_ready, False
        from serial.tools.list_ports import comports
        return scanner_ready, any(port.device.upper() == SERIAL_PORT.upper() for port in comports())

    # Bind the local scanner port too, so local and online modes cannot drive the same hardware.
    with ScannerServer(("127.0.0.1", 0 if simulate else 5001), Handler, bind_and_activate=False) as port_guard:
        port_guard.server_bind()
        logger.info("Connecting scanner service to the website.")
        client.run(STATE, hardware_status, lambda session_id, single: start_batch(session_id, not simulate, single, client))


def main() -> None:
    parser = argparse.ArgumentParser(description="Exam Scanner hardware service")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--online", action="store_true", help="Connect to the paired website")
    mode.add_argument("--pair-online", action="store_true", help="Enter a website scanner code and connect")
    parser.add_argument("--api-url", default="https://exam-scanner.onrender.com/exam-scanner/backend/api")
    parser.add_argument("--simulate", action="store_true", help="Simulate hardware against a loopback test server")
    args = parser.parse_args()
    if args.simulate and (not args.online or not os.environ.get("EXAM_SCANNER_DEVICE_TOKEN")):
        parser.error("--simulate requires --online and a test token in EXAM_SCANNER_DEVICE_TOKEN")
    if args.online or args.pair_online:
        try:
            run_online(args.api_url, args.pair_online, args.simulate)
        except (ImportError, OSError, RuntimeError, ValueError) as error:
            parser.exit(1, f"Scanner service could not start: {error}\n")
        return

    host = "127.0.0.1"
    port = 5001
    server = ScannerServer((host, port), Handler)
    logger.info("Scanner service running at http://%s:%d", host, port)
    server.serve_forever()


if __name__ == "__main__":
    main()
