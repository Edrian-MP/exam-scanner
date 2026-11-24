import unittest
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

import main


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


if __name__ == "__main__":
    unittest.main()
