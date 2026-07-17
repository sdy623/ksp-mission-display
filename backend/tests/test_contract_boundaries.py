import math
import unittest

from pydantic import ValidationError

from kmd.app import websocket_sample_hz
from kmd.contracts import TelemetrySnapshot
from kmd.fake_server import FakeState, geo_plan, stage_manifest, telemetry_snapshot


class ContractBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        from kmd.fake_server import state

        state.set_scenario("nominal_ascent")

    def test_contract_rejects_non_finite_and_extra_fields(self) -> None:
        payload = telemetry_snapshot()
        payload["sample_ut"] = math.inf
        with self.assertRaises(ValidationError):
            TelemetrySnapshot.model_validate(payload)

        payload = telemetry_snapshot()
        payload["unexpected"] = True
        with self.assertRaises(ValidationError):
            TelemetrySnapshot.model_validate(payload)

    def test_websocket_hz_is_finite_and_clamped(self) -> None:
        self.assertEqual(websocket_sample_hz("nan", 25.0, 50.0), 25.0)
        self.assertEqual(websocket_sample_hz("-10", 25.0, 50.0), 1.0)
        self.assertEqual(websocket_sample_hz("500", 25.0, 50.0), 50.0)
        self.assertEqual(websocket_sample_hz("garbage", 25.0, 50.0), 25.0)

    def test_fake_scenarios_cover_long_null_extreme_and_sequence_gap(self) -> None:
        from kmd.fake_server import state

        state.set_scenario("long_labels")
        self.assertGreater(len(telemetry_snapshot()["vessel"]["name"]), 200)
        self.assertGreater(len(stage_manifest()["stages"][0]["name"]), 200)

        state.set_scenario("null_values")
        self.assertTrue(all(value is None for value in telemetry_snapshot()["flight"].values()))

        state.set_scenario("numeric_extremes")
        extreme = telemetry_snapshot()
        self.assertTrue(math.isfinite(extreme["flight"]["altitude_m"]))

        state.set_scenario("sequence_gap")
        first = telemetry_snapshot()["sample_seq"]
        second = telemetry_snapshot()["sample_seq"]
        self.assertEqual(second - first, 3)

    def test_fake_planner_respects_filter_and_hold(self) -> None:
        from kmd.fake_server import state

        plan = geo_plan(110.0, 0.1, "DN", 3)
        self.assertTrue(plan["ready"])
        self.assertEqual({candidate["node"] for candidate in plan["candidates"]}, {"DN"})
        self.assertEqual(len(plan["candidates"]), 3)

        state.set_scenario("planner_hold")
        hold = geo_plan(110.0, 0.1, "ALL", 8)
        self.assertFalse(hold["ready"])
        self.assertEqual(hold["candidates"], [])
        self.assertIn("PARKING_ORBIT_NOT_STABLE", hold["rejection_reasons"])


if __name__ == "__main__":
    unittest.main()
