import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

import main
import online_scanner


class FeederTests(unittest.TestCase):
    def setUp(self):
        self.state = main.ScannerState()
        state_patch = patch.object(main, "STATE", self.state)
        state_patch.start()
        self.addCleanup(state_patch.stop)

    def test_detects_arduino_on_a_renumbered_port(self):
        feeder = SimpleNamespace(device="COM11", vid=0x2341, description="Arduino")
        ports = SimpleNamespace(comports=lambda: [feeder])
        with patch.object(main, "list_ports", ports):
            self.assertEqual(main.find_feeder_port(), "COM11")
            self.assertTrue(main.feeder_port_present())

    def test_detects_the_configured_fallback_port(self):
        fallback = SimpleNamespace(device=main.SERIAL_PORT, vid=None, description="USB Serial")
        ports = SimpleNamespace(comports=lambda: [fallback])
        with patch.object(main, "list_ports", ports):
            self.assertEqual(main.find_feeder_port(), main.SERIAL_PORT)
            self.assertTrue(main.feeder_port_present())

    def test_waits_for_ready_before_using_the_feeder(self):
        feeder = Mock()
        feeder.readline.return_value = b"READY\n"
        serial = SimpleNamespace(Serial=Mock(return_value=feeder))
        with patch.object(main, "serial", serial), patch.object(main, "find_feeder_port", return_value="COM11"):
            self.assertIs(main.open_feeder(), feeder)
        serial.Serial.assert_called_once_with("COM11", main.SERIAL_BAUD, timeout=main.SERIAL_READ_TIMEOUT)
        feeder.write.assert_not_called()

    def test_unconfirmed_feed_stops_before_checking_the_scanner(self):
        feeder = Mock()
        feeder.readline.side_effect = [
            b"FEED_STARTED\n", b"FEED_ATTEMPT:1\n", b"FEED_ATTEMPT:2\n", b"FEED_CANCELLED\n",
        ]
        self.assertEqual(main.feed_one_sheet(feeder), "UNCONFIRMED")
        self.assertEqual(feeder.write.call_args_list, [call(b"FEED\n"), call(b"STOP\n")])
        self.assertEqual(self.state.snapshot()["feed_attempt"], 1)

    def test_connection_timeout_finishes_the_paper_handoff_before_stopping(self):
        feeder = Mock()
        feeder.readline.side_effect = [
            b"FEED_STARTED\n", b"FEED_ATTEMPT:1\n", b"FEED_ATTEMPT:2\n",
            b"FEED_CANCELLED\n", b"PUSH_DONE\n",
        ]
        online = Mock()
        image = object()
        payload = {"sheet_index": 1, "status": "ok"}

        def wait_for_sheet():
            if not self.state.should_stop_after_sheet():
                self.state.request_stop_after_sheet()
                raise RuntimeError("Paper empty")
            return image

        self.state.start_batch("test-session")
        with (
            TemporaryDirectory() as output,
            patch.multiple(main, _SERIAL_AVAILABLE=True, _WIA_AVAILABLE=True, _PIL_AVAILABLE=True, pythoncom=None),
            patch.object(main, "OUT_DIR", Path(output)),
            patch.object(main, "open_feeder", return_value=feeder),
            patch.object(main, "scan_sheet_wia_with_timeout", side_effect=wait_for_sheet) as scan,
            patch.object(main.time, "sleep"),
            patch.object(main.omr, "process_sheet", return_value=SimpleNamespace(status="ok")),
            patch.object(main.omr, "sheet_result_to_dict", return_value=payload),
        ):
            main._batch_loop("test-session", use_hardware=True, online=online)

        self.assertEqual(
            feeder.write.call_args_list,
            [call(b"BEEP_START\n"), call(b"FEED\n"), call(b"STOP\n"), call(b"PUSH:4\n")],
        )
        self.assertEqual(scan.call_count, 2)
        online.post_sheet.assert_called_once_with("test-session", payload)
        self.assertEqual(self.state.snapshot()["last_batch_reason"], "disconnected")

    def test_wia_error_is_uploaded_to_the_active_online_session(self):
        online = Mock()
        self.state.start_batch("test-session")
        with (
            patch.multiple(main, _WIA_AVAILABLE=True, _PIL_AVAILABLE=True, pythoncom=None),
            patch.object(main, "scan_sheet_wia_with_timeout", side_effect=RuntimeError("Scanner driver failure")),
            patch.object(main, "_requests") as local_http,
        ):
            main._batch_loop("test-session", use_hardware=True, single=True, online=online)
        local_http.post.assert_not_called()
        online.post_sheet.assert_called_once()
        session, result = online.post_sheet.call_args.args
        self.assertEqual(session, "test-session")
        self.assertEqual(result["flag_reasons"], ["SCAN_ERROR"])
        self.assertEqual(self.state.snapshot()["last_batch_reason"], "scan_error")


class OnlineStopTests(unittest.TestCase):
    def test_poll_timeout_defers_stop_but_explicit_stop_is_immediate(self):
        session = "12345678-1234-4321-1234-123456789012"
        scanner = online_scanner.OnlineScanner("http://localhost:5000/api", "a" * 64, simulate=True)
        state = Mock(is_running=True)
        state.snapshot.return_value = {"active_session_id": session}
        response = Mock()
        response.json.return_value = {"data": {"job": {"session_id": session, "stop": True}}}
        with (
            patch.object(scanner, "_request", side_effect=[online_scanner.requests.Timeout(), response, KeyboardInterrupt()]),
            patch.object(online_scanner.time, "monotonic", side_effect=[0, 20, 21]),
            patch.object(online_scanner.time, "sleep"),
            self.assertRaises(KeyboardInterrupt),
        ):
            scanner.run(state, lambda: (True, True), Mock())

        stop_calls = [entry for entry in state.method_calls if entry[0].startswith("request_stop")]
        self.assertEqual(stop_calls, [call.request_stop_after_sheet(), call.request_stop(), call.request_stop()])


if __name__ == "__main__":
    unittest.main()
