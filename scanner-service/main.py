#!/usr/bin/env python3
"""Local scanner service (Windows) for pyserial + WIA integration."""

from __future__ import annotations

import json
import random
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import serial  # type: ignore
except Exception:  # pragma: no cover
    serial = None


class ScannerState:
    def __init__(self) -> None:
        self.last_scan_at: str | None = None
        self.last_output: str | None = None

    def scanner_connected(self) -> bool:
        return serial is not None


STATE = ScannerState()
OUT_DIR = Path(__file__).resolve().parent / 'scans'
OUT_DIR.mkdir(parents=True, exist_ok=True)


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload).encode('utf-8')


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json_bytes(payload)
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == '/status':
            self._send(
                200,
                {
                    'ok': True,
                    'data': {
                        'scanner': {
                            'connected': STATE.scanner_connected(),
                            'driver': 'pyserial+wia-stub',
                            'last_scan_at': STATE.last_scan_at,
                            'last_output': STATE.last_output,
                        }
                    },
                },
            )
            return

        self._send(404, {'ok': False, 'error': 'Route not found'})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != '/scan':
            self._send(404, {'ok': False, 'error': 'Route not found'})
            return

        content_length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(content_length) if content_length > 0 else b'{}'
        payload = json.loads(raw.decode('utf-8') or '{}')

        exam_id = int(payload.get('exam_id', 0))
        if exam_id < 1:
            self._send(400, {'ok': False, 'error': 'exam_id is required'})
            return

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        output_path = OUT_DIR / f'exam_{exam_id}_{timestamp}.txt'

        # Placeholder for actual WIA image capture and pyserial trigger logic.
        output_path.write_text(f'MOCK_SCAN exam_id={exam_id} at {timestamp}\n', encoding='utf-8')

        STATE.last_scan_at = datetime.now().isoformat()
        STATE.last_output = str(output_path)

        self._send(
            200,
            {
                'ok': True,
                'data': {
                    'exam_id': exam_id,
                    'file_path': str(output_path),
                    'detected_sheets': random.randint(1, 3),
                },
            },
        )


def main() -> None:
    host = '127.0.0.1'
    port = 5001
    server = ThreadingHTTPServer((host, port), Handler)
    print(f'Scanner service running at http://{host}:{port}')
    server.serve_forever()


if __name__ == '__main__':
    main()
