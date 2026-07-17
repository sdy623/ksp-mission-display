import math
import threading
import unittest

from kmd.krpc_adapter import KRPCAdapter, KRPCAdapterError, KRPCConfig


class FakeSituation:
    name = "orbiting"


class FakeBody:
    def __init__(self) -> None:
        self.reference_frame = object()
        self.non_rotating_reference_frame = object()


class FakeOrbit:
    def __init__(self, body: FakeBody, *, prelaunch: bool = False) -> None:
        self.body = body
        self.apoapsis_altitude = 105.0 if prelaunch else 220_581.0
        self.periapsis_altitude = -6_361_233.0 if prelaunch else 219_725.0
        self.semi_major_axis = 3_197_572.0 if prelaunch else 6_598_289.0
        self.eccentricity = 0.9947 if prelaunch else 0.0000648534
        self.inclination = 0.342318
        self.period = 1_799.457 if prelaunch else 5_334.061


class FakeFlight:
    def __init__(self, *, inertial: bool = False) -> None:
        self.mean_altitude = 84_620.0
        self.speed = 2_661.2 if inertial else 2_314.7
        self.vertical_speed = 182.4
        self.horizontal_speed = 2_307.5
        self.mach = 7.84
        self.dynamic_pressure = 12_640.0
        self.g_force = 2.18
        self.pitch = 18.6
        self.heading = 94.2
        self.roll = -0.8
        self.latitude = 27.4
        self.longitude = 146.8


class FakePart:
    def __init__(
        self,
        title: str,
        stage: int,
        decouple_stage: int,
        mass: float,
        dry_mass: float,
        *,
        radially_attached: bool = False,
    ) -> None:
        self.title = title
        self.name = title.lower().replace(" ", "-")
        self.stage = stage
        self.decouple_stage = decouple_stage
        self.mass = mass
        self.dry_mass = dry_mass
        self.radially_attached = radially_attached


class FakeEngine:
    def __init__(self, part: FakePart, thrust: float, isp: float) -> None:
        self.part = part
        self.max_vacuum_thrust = thrust
        self.vacuum_specific_impulse = isp
        self.active = False
        self.has_fuel = True


class FakeFairing:
    def __init__(self, part: FakePart) -> None:
        self.part = part
        self.jettisoned = False


class FakeParts:
    def __init__(self, all_parts, engines, fairings) -> None:
        self.all = all_parts
        self.engines = engines
        self.fairings = fairings


class FakeControl:
    current_stage = 5
    throttle = 0.0


class FakeVessel:
    def __init__(self, name: str, vessel_id: str, *, prelaunch: bool = False) -> None:
        self.name = name
        self.id = vessel_id
        self.met = 1_357.496
        self.situation = FakeSituation()
        self.orbit = FakeOrbit(FakeBody(), prelaunch=prelaunch)

    def flight(self, reference_frame):
        inertial = reference_frame is self.orbit.body.non_rotating_reference_frame
        return FakeFlight(inertial=inertial)


class FakeSpaceCenter:
    def __init__(self, vessels: list[FakeVessel]) -> None:
        self.ut = 450_581_502.680
        self.vessels = vessels
        self.active_vessel = vessels[0] if vessels else None


class FakeConnection:
    def __init__(self, space_center: FakeSpaceCenter) -> None:
        self.space_center = space_center
        self.closed = False
        self.stream_calls = 0

    def add_stream(self, function, obj, attribute):
        self.stream_calls += 1

        class FakeStream:
            def __init__(self):
                self.removed = False

            def __call__(self):
                return function(obj, attribute)

            def remove(self):
                self.removed = True

        return FakeStream()

    def close(self) -> None:
        self.closed = True


class PlannerBody(FakeBody):
    def __init__(self) -> None:
        super().__init__()
        self.name = "Earth"
        self.gravitational_parameter = 3.98600435436e14
        self.equatorial_radius = 6_371_000.0
        self.rotational_period = 86_164.0905

    def angular_velocity(self, _reference_frame):
        return (0.0, (2.0 * math.pi) / self.rotational_period, 0.0)


class PlannerOrbit(FakeOrbit):
    def __init__(self, body: PlannerBody, epoch: float) -> None:
        super().__init__(body)
        self.epoch = epoch
        self.semi_major_axis = 6_571_000.0
        self.apoapsis_altitude = 200_000.0
        self.periapsis_altitude = 200_000.0
        self.eccentricity = 0.0001
        self.inclination = math.radians(28.5)
        self.argument_of_periapsis = 0.0
        self.period = 2.0 * math.pi * math.sqrt(
            (self.semi_major_axis**3) / body.gravitational_parameter
        )

    def ut_at_true_anomaly(self, true_anomaly: float) -> float:
        mean_motion = (2.0 * math.pi) / self.period
        return self.epoch + ((true_anomaly % (2.0 * math.pi)) / mean_motion)

    def position_at(self, ut: float, reference_frame):
        theta = ((2.0 * math.pi) / self.period) * (ut - self.epoch)
        radius = self.semi_major_axis
        x = radius * math.cos(theta)
        y = radius * math.sin(theta) * math.sin(self.inclination)
        z = radius * math.sin(theta) * math.cos(self.inclination)
        if reference_frame is self.body.reference_frame:
            rotation = -((2.0 * math.pi) / self.body.rotational_period) * (
                ut - self.epoch
            )
            cosine = math.cos(rotation)
            sine = math.sin(rotation)
            return ((cosine * x) - (sine * z), y, (sine * x) + (cosine * z))
        return (x, y, z)


class PlannerVessel(FakeVessel):
    def __init__(self, epoch: float) -> None:
        super().__init__("Live Parking Vehicle", "planner-vessel")
        self.orbit = PlannerOrbit(PlannerBody(), epoch)
        self.met = 1_200.0


class AdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.primary = FakeVessel("Dissolution 2A", "vessel-001")
        self.secondary = FakeVessel("Lunar Payload", "vessel-002")
        self.connection = FakeConnection(FakeSpaceCenter([self.primary, self.secondary]))
        self.factory_kwargs = None

        def factory(**kwargs):
            self.factory_kwargs = kwargs
            return self.connection

        self.factory = factory

    def test_connects_read_only_and_builds_live_snapshot(self) -> None:
        adapter = KRPCAdapter(KRPCConfig(), connection_factory=self.factory)
        status = adapter.connect()
        snapshot = adapter.snapshot("TLI")

        self.assertEqual(status["state"], "connected")
        self.assertEqual(self.factory_kwargs["rpc_port"], 50_000)
        self.assertEqual(snapshot["source"], "krpc")
        self.assertEqual(snapshot["mission_profile"], "TLI")
        self.assertEqual(snapshot["vessel"]["name"], "Dissolution 2A")
        self.assertEqual(snapshot["flight"]["pitch_deg"], 18.6)
        self.assertEqual(snapshot["flight"]["inertial_speed_m_s"], 2_661.2)
        self.assertEqual(snapshot["flight"]["longitude_deg"], 146.8)
        self.assertEqual(snapshot["flight"]["g_force"], 2.18)
        self.assertEqual(snapshot["quality"]["orbit"], "valid")
        self.assertGreaterEqual(self.connection.stream_calls, 15)
        self.assertEqual(snapshot["sample_seq"], 1)
        self.assertGreater(snapshot["sample_monotonic_ns"], 0)
        self.assertGreater(snapshot["gateway_unix_ns"], 0)

        second = adapter.snapshot("TLI")
        self.assertEqual(second["sample_seq"], 2)

    def test_selects_configured_vessel_by_exact_name(self) -> None:
        config = KRPCConfig(vessel_name="Lunar Payload")
        adapter = KRPCAdapter(config, connection_factory=self.factory)
        adapter.connect()
        snapshot = adapter.snapshot()
        self.assertEqual(snapshot["vessel"]["id"], "vessel-002")

    def test_prelaunch_orbit_is_explicitly_invalid(self) -> None:
        vessel = FakeVessel("Pad Vehicle", "pad-001", prelaunch=True)
        connection = FakeConnection(FakeSpaceCenter([vessel]))
        adapter = KRPCAdapter(KRPCConfig(), connection_factory=lambda **_: connection)
        adapter.connect()
        snapshot = adapter.snapshot()
        self.assertEqual(snapshot["quality"]["orbit"], "invalid")
        self.assertLess(snapshot["orbit"]["periapsis_altitude_m"], 0.0)

    def test_connection_failure_is_reported_without_fake_data(self) -> None:
        def failing_factory(**_):
            raise ConnectionRefusedError("KSP kRPC server is not listening")

        adapter = KRPCAdapter(KRPCConfig(), connection_factory=failing_factory)
        with self.assertRaises(KRPCAdapterError):
            adapter.connect()
        status = adapter.status()
        self.assertEqual(status["state"], "disconnected")
        self.assertIn("ConnectionRefusedError", status["last_error"])

    def test_status_does_not_wait_for_slow_telemetry_lock(self) -> None:
        adapter = KRPCAdapter(KRPCConfig(), connection_factory=self.factory)
        lock_held = threading.Event()
        release_lock = threading.Event()

        def hold_adapter_lock() -> None:
            with adapter._lock:
                lock_held.set()
                release_lock.wait(timeout=1.0)

        worker = threading.Thread(target=hold_adapter_lock)
        worker.start()
        self.assertTrue(lock_held.wait(timeout=0.5))
        try:
            status = adapter.status()
            self.assertEqual(status["state"], "disconnected")
        finally:
            release_lock.set()
            worker.join(timeout=1.0)

    def test_disconnect_closes_connection(self) -> None:
        adapter = KRPCAdapter(KRPCConfig(), connection_factory=self.factory)
        adapter.connect()
        adapter.disconnect()
        self.assertTrue(self.connection.closed)
        self.assertEqual(adapter.status()["state"], "disconnected")

    def test_event_detector_records_cutoff_stage_and_fairing_edges(self) -> None:
        adapter = KRPCAdapter(KRPCConfig(), connection_factory=self.factory)
        base = {
            "current_stage": 3,
            "thrust_n": 1_000_000.0,
            "available_thrust_n": 1_100_000.0,
            "active_engine_count": 2,
            "fairing_count": 1,
            "jettisoned_fairing_count": 0,
        }
        adapter._detect_events(100.0, 10.0, base)
        adapter._detect_events(101.0, 11.0, {**base, "thrust_n": 0.0})
        adapter._detect_events(102.0, 12.0, {
            **base,
            "current_stage": 2,
            "thrust_n": 0.0,
            "fairing_count": 0,
        })

        event_types = [event["type"] for event in adapter._events]
        self.assertEqual(
            event_types,
            ["ENGINE_CUTOFF", "STAGE_CHANGE", "FAIRING_JETTISON"],
        )

    def test_infers_editable_stage_manifest_and_delta_v(self) -> None:
        core_engine_part = FakePart("CORE ENGINE", 5, 3, 10_000.0, 3_000.0)
        core_tank = FakePart("CORE TANK", 5, 3, 180_000.0, 22_000.0)
        upper_engine_part = FakePart("UPPER ENGINE", 2, 0, 5_000.0, 2_000.0)
        upper_tank = FakePart("UPPER TANK", 2, 0, 45_000.0, 8_000.0)
        payload = FakePart("PAYLOAD", 0, -1, 20_000.0, 20_000.0)
        fairing_part = FakePart("PROC FAIRING", 4, 3, 2_000.0, 2_000.0)
        all_parts = [
            core_engine_part,
            core_tank,
            upper_engine_part,
            upper_tank,
            payload,
            fairing_part,
        ]
        self.primary.parts = FakeParts(
            all_parts,
            [
                FakeEngine(core_engine_part, 3_000_000.0, 340.0),
                FakeEngine(upper_engine_part, 450_000.0, 450.0),
            ],
            [FakeFairing(fairing_part)],
        )
        self.primary.control = FakeControl()
        self.primary.mass = sum(part.mass for part in all_parts)
        self.primary.dry_mass = sum(part.dry_mass for part in all_parts)

        adapter = KRPCAdapter(KRPCConfig(), connection_factory=self.factory)
        adapter.connect()
        manifest = adapter.stage_manifest()

        self.assertEqual(manifest["vessel"]["name"], "Dissolution 2A")
        self.assertEqual(manifest["current_stage"], 5)
        self.assertEqual([stage["role"] for stage in manifest["stages"]], ["CORE", "UPPER"])
        self.assertEqual([stage["activation_stage"] for stage in manifest["stages"]], [5, 2])
        self.assertEqual(manifest["stages"][0]["cutoff_event"], "MECO")
        self.assertEqual(manifest["stages"][1]["cutoff_event"], "SECO")
        self.assertGreater(manifest["stages"][0]["estimated_delta_v_m_s"], 0.0)
        self.assertGreater(manifest["stages"][1]["estimated_burn_time_s"], 0.0)
        self.assertGreater(manifest["total_estimated_delta_v_m_s"], 0.0)
        self.assertEqual(manifest["fairings"][0]["title"], "PROC FAIRING")

    def test_geo_plan_uses_live_krpc_orbit_and_body_constants(self) -> None:
        epoch = 450_581_502.680
        vessel = PlannerVessel(epoch)
        connection = FakeConnection(FakeSpaceCenter([vessel]))
        adapter = KRPCAdapter(KRPCConfig(), connection_factory=lambda **_: connection)
        adapter.connect()

        plan = adapter.geo_plan(
            target_longitude_deg=110.0,
            tolerance_deg=0.1,
            node_filter="ALL",
            max_nodes=4,
        )

        self.assertTrue(plan["ready"])
        self.assertEqual(plan["source"], "krpc")
        self.assertEqual(plan["model"], "L1_TWO_BODY_IMPULSIVE")
        self.assertEqual(plan["vessel"]["name"], "Live Parking Vehicle")
        self.assertEqual(len(plan["candidates"]), 4)
        self.assertGreater(plan["body"]["synchronous_radius_m"], 42_000_000.0)
        first = plan["candidates"][0]
        self.assertIn(first["node"], {"AN", "DN"})
        self.assertGreater(first["delta_v_m_s"], 2_000.0)
        self.assertLess(first["delta_v_m_s"], 3_000.0)
        self.assertGreaterEqual(first["apoapsis_longitude_deg"], 0.0)
        self.assertLess(first["apoapsis_longitude_deg"], 360.0)


if __name__ == "__main__":
    unittest.main()
