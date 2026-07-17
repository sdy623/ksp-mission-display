from __future__ import annotations

from dataclasses import asdict, dataclass
import math
import threading
import time
from typing import Any, Callable, Literal

import numpy as np

from ..planner import (
    PlannerError,
    ksp_fixed_lon_lat,
    map_inertial_to_future_fixed,
    solve_prograde_to_apoapsis,
    time_and_position_at_apoapsis,
    wrap_error_deg,
    wrap_longitude_deg,
)
from .config import KRPCConfig


class KRPCAdapterError(RuntimeError):
    """Base error raised by the read-only kRPC adapter."""


class NoVesselError(KRPCAdapterError):
    """Raised when no vessel matches the configured binding rules."""


ConnectionFactory = Callable[..., Any]


@dataclass(slots=True)
class AdapterStatus:
    state: Literal["disconnected", "connecting", "connected", "degraded"] = "disconnected"
    address: str = "127.0.0.1"
    rpc_port: int = 50_000
    stream_port: int = 50_001
    vessel_id: str | None = None
    vessel_name: str | None = None
    connected_at_monotonic: float | None = None
    last_sample_ut: float | None = None
    last_error: str | None = None


def _default_connection_factory(**kwargs: Any) -> Any:
    try:
        import krpc
    except ImportError as exc:
        raise KRPCAdapterError(
            "Python package 'krpc' is not installed in this interpreter."
        ) from exc
    return krpc.connect(**kwargs)


def _enum_text(value: Any) -> str:
    if value is None:
        return "unknown"
    name = getattr(value, "name", None)
    if name:
        return str(name).lower()
    return str(value).split(".")[-1].lower()


def _finite_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _safe_read(obj: Any, attribute: str) -> Any:
    try:
        value = getattr(obj, attribute)
        return value() if callable(value) else value
    except Exception:
        return None


class KRPCAdapter:
    """Thread-safe, read-only access to KSP telemetry through kRPC.

    The adapter reads control, staging, engine and part state, but never writes
    control inputs or activates stages, engines, fairings or maneuver nodes.
    """

    def __init__(
        self,
        config: KRPCConfig | None = None,
        connection_factory: ConnectionFactory | None = None,
    ) -> None:
        self.config = config or KRPCConfig.from_env()
        self._connection_factory = connection_factory or _default_connection_factory
        self._connection: Any | None = None
        self._space_center: Any | None = None
        self._vessel: Any | None = None
        self._fixed_flight: Any | None = None
        self._inertial_flight: Any | None = None
        self._streams: dict[str, Any] = {}
        self._slow_cache: dict[str, Any] | None = None
        self._slow_cache_at = 0.0
        self._sample_sequence = 0
        self._event_sequence = 0
        self._events: list[dict[str, Any]] = []
        self._previous_event_signals: dict[str, Any] | None = None
        self._event_engine_groups: list[dict[str, Any]] = []
        self._event_fairing_groups: list[dict[str, Any]] = []
        self._event_decoupler_groups: list[dict[str, Any]] = []
        self._lock = threading.RLock()
        self._last_connect_attempt = 0.0
        self._status = AdapterStatus(
            address=self.config.address,
            rpc_port=self.config.rpc_port,
            stream_port=self.config.stream_port,
        )

    def status(self) -> dict[str, Any]:
        # Status is diagnostic state made only of immutable scalar values.
        # Reading it must never wait behind a slow socket connect or telemetry
        # RPC while `/health` and WebSocket error reporting are trying to say
        # that kRPC is unavailable.
        return asdict(self._status)

    def connect(self, *, force: bool = False) -> dict[str, Any]:
        with self._lock:
            if self._connection is not None and not force:
                return self.status()

            if force:
                self.disconnect()

            self._status.state = "connecting"
            self._status.last_error = None
            self._last_connect_attempt = time.monotonic()
            try:
                connection = self._connection_factory(
                    name=self.config.client_name,
                    address=self.config.address,
                    rpc_port=self.config.rpc_port,
                    stream_port=self.config.stream_port,
                )
                space_center = connection.space_center
                vessel = self._select_vessel(space_center)
                self._configure_streams(connection, space_center, vessel)
            except Exception as exc:
                self._remove_streams()
                self._connection = None
                self._space_center = None
                self._vessel = None
                self._status.state = "disconnected"
                self._status.last_error = f"{type(exc).__name__}: {exc}"
                raise KRPCAdapterError(self._status.last_error) from exc

            self._connection = connection
            self._space_center = space_center
            self._vessel = vessel
            self._status.state = "connected"
            self._status.connected_at_monotonic = time.monotonic()
            self._bind_status_to_vessel(vessel)
            return self.status()

    def disconnect(self) -> None:
        with self._lock:
            connection = self._connection
            self._remove_streams()
            self._connection = None
            self._space_center = None
            self._vessel = None
            self._fixed_flight = None
            self._inertial_flight = None
            self._slow_cache = None
            self._slow_cache_at = 0.0
            self._events = []
            self._previous_event_signals = None
            self._event_engine_groups = []
            self._event_fairing_groups = []
            self._event_decoupler_groups = []
            self._status.state = "disconnected"
            self._status.vessel_id = None
            self._status.vessel_name = None
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass

    def ensure_connected(self) -> None:
        with self._lock:
            if self._connection is not None:
                return
            elapsed = time.monotonic() - self._last_connect_attempt
            if elapsed < self.config.reconnect_interval_s:
                raise KRPCAdapterError(
                    f"Reconnect backoff active for {self.config.reconnect_interval_s - elapsed:.2f}s"
                )
        self.connect()

    def refresh_vessel_binding(self) -> dict[str, Any]:
        with self._lock:
            self.ensure_connected()
            assert self._space_center is not None
            self._vessel = self._select_vessel(self._space_center)
            assert self._connection is not None
            self._remove_streams()
            self._configure_streams(self._connection, self._space_center, self._vessel)
            self._bind_status_to_vessel(self._vessel)
            return self.status()

    def snapshot(self, mission_profile: str | None = None) -> dict[str, Any]:
        with self._lock:
            self.ensure_connected()
            assert self._space_center is not None
            assert self._vessel is not None

            try:
                snapshot = self._read_snapshot(
                    self._space_center,
                    self._vessel,
                    mission_profile or self.config.mission_profile,
                )
            except Exception as exc:
                self._status.state = "degraded"
                self._status.last_error = f"{type(exc).__name__}: {exc}"
                raise KRPCAdapterError(self._status.last_error) from exc

            self._status.state = "connected"
            self._status.last_error = None
            self._status.last_sample_ut = snapshot["sample_ut"]
            return snapshot

    def stage_manifest(self) -> dict[str, Any]:
        """Infer an editable launch-vehicle staging plan from the active vessel.

        This is intentionally read-only and conservative. Stock kRPC exposes
        loaded-vessel part topology, not the original .craft file or RO's full
        propellant routing model, so parallel/crossfeed results are estimates.
        """
        with self._lock:
            self.ensure_connected()
            assert self._vessel is not None
            try:
                return self._infer_stage_manifest(self._vessel)
            except KRPCAdapterError:
                raise
            except Exception as exc:
                raise KRPCAdapterError(
                    f"Unable to infer staging from the active vessel: {type(exc).__name__}: {exc}"
                ) from exc

    def geo_plan(
        self,
        *,
        target_longitude_deg: float = 110.0,
        tolerance_deg: float = 0.1,
        node_filter: str = "ALL",
        max_nodes: int = 8,
    ) -> dict[str, Any]:
        """Build live L1 GEO injection candidates from the active kRPC orbit.

        The model is deliberately advisory: an instantaneous prograde burn is
        solved at each future equator crossing. It uses kRPC's future orbit
        positions in both body-centered frames to preserve KSP's actual prime
        meridian, y-north axis and game epoch.
        """
        with self._lock:
            self.ensure_connected()
            assert self._space_center is not None
            assert self._vessel is not None

            space_center = self._space_center
            vessel = self._vessel
            orbit = _safe_read(vessel, "orbit")
            body = _safe_read(orbit, "body") if orbit is not None else None
            ut_now = _finite_or_none(_safe_read(space_center, "ut"))
            met_now = _finite_or_none(_safe_read(vessel, "met"))
            vessel_name = str(_safe_read(vessel, "name") or "Unnamed vessel")
            body_name = str(_safe_read(body, "name") or "Unknown body")
            target_longitude_deg = wrap_longitude_deg(float(target_longitude_deg))
            tolerance_deg = max(0.001, min(abs(float(tolerance_deg)), 10.0))
            node_filter = node_filter.upper()
            if node_filter not in {"ALL", "AN", "DN"}:
                node_filter = "ALL"
            max_nodes = max(1, min(int(max_nodes), 24))

            rejection_reasons: list[str] = []
            if orbit is None or body is None or ut_now is None:
                rejection_reasons.append("NO_ACTIVE_ORBIT")

            mu = _finite_or_none(_safe_read(body, "gravitational_parameter"))
            equatorial_radius = _finite_or_none(_safe_read(body, "equatorial_radius"))
            semi_major_axis = _finite_or_none(_safe_read(orbit, "semi_major_axis"))
            periapsis_altitude = _finite_or_none(_safe_read(orbit, "periapsis_altitude"))
            apoapsis_altitude = _finite_or_none(_safe_read(orbit, "apoapsis_altitude"))
            eccentricity = _finite_or_none(_safe_read(orbit, "eccentricity"))
            inclination = _finite_or_none(_safe_read(orbit, "inclination"))
            period_s = _finite_or_none(_safe_read(orbit, "period"))
            argument_of_periapsis = _finite_or_none(
                _safe_read(orbit, "argument_of_periapsis")
            )

            if mu is None or mu <= 0.0:
                rejection_reasons.append("BODY_MU_UNAVAILABLE")
            if equatorial_radius is None or equatorial_radius <= 0.0:
                rejection_reasons.append("BODY_RADIUS_UNAVAILABLE")
            if semi_major_axis is None or semi_major_axis <= 0.0 or period_s is None:
                rejection_reasons.append("ORBIT_ELEMENTS_UNAVAILABLE")
            if periapsis_altitude is None or periapsis_altitude <= 0.0:
                rejection_reasons.append("PARKING_ORBIT_NOT_STABLE")
            if inclination is None or abs(math.sin(inclination)) < 1.0e-5:
                rejection_reasons.append("EQUATORIAL_NODE_UNDEFINED")
            if argument_of_periapsis is None:
                rejection_reasons.append("ARGUMENT_OF_PERIAPSIS_UNAVAILABLE")

            fixed_frame = _safe_read(body, "reference_frame")
            inertial_frame = _safe_read(body, "non_rotating_reference_frame")
            if fixed_frame is None or inertial_frame is None:
                rejection_reasons.append("REFERENCE_FRAMES_UNAVAILABLE")

            omega = None
            angular_velocity = getattr(body, "angular_velocity", None) if body is not None else None
            if callable(angular_velocity) and fixed_frame is not None:
                try:
                    vector = np.asarray(angular_velocity(fixed_frame), dtype=float)
                    magnitude = float(np.linalg.norm(vector))
                    omega = magnitude if math.isfinite(magnitude) and magnitude > 0.0 else None
                except Exception:
                    omega = None
            if omega is None:
                rotational_period = _finite_or_none(_safe_read(body, "rotational_period"))
                if rotational_period is not None and rotational_period > 0.0:
                    omega = (2.0 * math.pi) / rotational_period
            if omega is None or mu is None:
                rejection_reasons.append("BODY_ROTATION_UNAVAILABLE")
                synchronous_radius = None
            else:
                synchronous_radius = (mu / (omega**2)) ** (1.0 / 3.0)

            base = {
                "schema_version": "1.0",
                "source": "krpc",
                "model": "L1_TWO_BODY_IMPULSIVE",
                "ready": not rejection_reasons,
                "sample_ut": ut_now,
                "met_s": met_now,
                "target_longitude_deg": target_longitude_deg,
                "tolerance_deg": tolerance_deg,
                "node_filter": node_filter,
                "vessel": {
                    "id": str(_safe_read(vessel, "id") or "unknown-vessel"),
                    "name": vessel_name,
                    "situation": _enum_text(_safe_read(vessel, "situation")),
                },
                "body": {
                    "name": body_name,
                    "gravitational_parameter_m3_s2": mu,
                    "equatorial_radius_m": equatorial_radius,
                    "rotational_speed_rad_s": omega,
                    "synchronous_radius_m": synchronous_radius,
                },
                "parking_orbit": {
                    "semi_major_axis_m": semi_major_axis,
                    "periapsis_altitude_m": periapsis_altitude,
                    "apoapsis_altitude_m": apoapsis_altitude,
                    "eccentricity": eccentricity,
                    "inclination_rad": inclination,
                    "period_s": period_s,
                },
                "rejection_reasons": rejection_reasons,
                "warnings": [
                    "Instantaneous prograde burn; finite-burn steering and propellant use are not integrated.",
                    "GTO inclination is retained; GEO circularization and plane change are not included.",
                ],
                "candidates": [],
            }
            if rejection_reasons:
                return base

            assert mu is not None
            assert synchronous_radius is not None
            assert period_s is not None
            assert argument_of_periapsis is not None
            assert inertial_frame is not None
            assert fixed_frame is not None
            assert ut_now is not None

            ut_at_true_anomaly = getattr(orbit, "ut_at_true_anomaly", None)
            position_at = getattr(orbit, "position_at", None)
            if not callable(ut_at_true_anomaly) or not callable(position_at):
                base["ready"] = False
                base["rejection_reasons"] = ["KRPC_ORBIT_PREDICTION_UNAVAILABLE"]
                return base

            def next_occurrence(true_anomaly: float) -> float:
                candidate_ut = float(ut_at_true_anomaly(true_anomaly))
                while candidate_ut <= ut_now + 0.01:
                    candidate_ut += period_s
                return candidate_ut

            node_seeds = {
                "AN": next_occurrence((-argument_of_periapsis) % (2.0 * math.pi)),
                "DN": next_occurrence((math.pi - argument_of_periapsis) % (2.0 * math.pi)),
            }
            node_times: list[tuple[float, str]] = []
            for node_type, seed_ut in node_seeds.items():
                if node_filter != "ALL" and node_filter != node_type:
                    continue
                for orbit_index in range(max_nodes):
                    node_times.append((seed_ut + (orbit_index * period_s), node_type))
            node_times.sort(key=lambda item: item[0])
            node_times = node_times[:max_nodes]

            def evaluate_burn(burn_ut: float) -> dict[str, float]:
                position = np.asarray(position_at(burn_ut, inertial_frame), dtype=float)
                derivative_step_s = 0.25
                before = np.asarray(
                    position_at(burn_ut - derivative_step_s, inertial_frame), dtype=float
                )
                after = np.asarray(
                    position_at(burn_ut + derivative_step_s, inertial_frame), dtype=float
                )
                velocity = (after - before) / (2.0 * derivative_step_s)
                delta_v, post_velocity, shape = solve_prograde_to_apoapsis(
                    mu,
                    position,
                    velocity,
                    synchronous_radius,
                )
                coast_s, apoapsis_inertial = time_and_position_at_apoapsis(
                    mu,
                    position,
                    post_velocity,
                    shape,
                )
                apoapsis_ut = burn_ut + coast_s
                reference_inertial = np.asarray(
                    position_at(apoapsis_ut, inertial_frame), dtype=float
                )
                reference_fixed = np.asarray(position_at(apoapsis_ut, fixed_frame), dtype=float)
                apoapsis_fixed = map_inertial_to_future_fixed(
                    apoapsis_inertial,
                    reference_inertial,
                    reference_fixed,
                )
                apoapsis_lon, apoapsis_lat = ksp_fixed_lon_lat(apoapsis_fixed)
                burn_fixed = np.asarray(position_at(burn_ut, fixed_frame), dtype=float)
                burn_lon, burn_lat = ksp_fixed_lon_lat(burn_fixed)
                return {
                    "burn_ut": burn_ut,
                    "burn_met_s": (met_now or 0.0) + (burn_ut - ut_now),
                    "wait_s": burn_ut - ut_now,
                    "burn_longitude_deg": burn_lon,
                    "burn_latitude_deg": burn_lat,
                    "delta_v_m_s": delta_v,
                    "coast_to_apoapsis_s": coast_s,
                    "apoapsis_ut": apoapsis_ut,
                    "apoapsis_longitude_deg": apoapsis_lon,
                    "apoapsis_latitude_deg": apoapsis_lat,
                    "transfer_semi_major_axis_m": float(shape["semi_major_axis_m"]),
                    "transfer_eccentricity": float(shape["eccentricity"]),
                    "transfer_periapsis_radius_m": float(shape["periapsis_radius_m"]),
                    "transfer_apoapsis_radius_m": float(shape["apoapsis_radius_m"]),
                }

            candidates = []
            for sequence, (node_ut, node_type) in enumerate(node_times):
                try:
                    center = evaluate_burn(node_ut)
                    minus = evaluate_burn(node_ut - 0.5)
                    plus = evaluate_burn(node_ut + 0.5)
                    longitude_rate = wrap_error_deg(
                        plus["apoapsis_longitude_deg"]
                        - minus["apoapsis_longitude_deg"]
                    )
                    error = wrap_error_deg(
                        center["apoapsis_longitude_deg"] - target_longitude_deg
                    )
                    window_open_ut = None
                    window_close_ut = None
                    if abs(error) <= tolerance_deg and abs(longitude_rate) > 1.0e-7:
                        boundaries = sorted((
                            (-tolerance_deg - error) / longitude_rate,
                            (tolerance_deg - error) / longitude_rate,
                        ))
                        window_open_ut = node_ut + boundaries[0]
                        window_close_ut = node_ut + boundaries[1]
                    candidates.append({
                        "id": f"{node_type.lower()}-{sequence:02d}",
                        "sequence": sequence,
                        "node": node_type,
                        **center,
                        "longitude_error_deg": error,
                        "longitude_rate_deg_s": longitude_rate,
                        "window_open_ut": window_open_ut,
                        "window_close_ut": window_close_ut,
                        "window_width_s": (
                            window_close_ut - window_open_ut
                            if window_open_ut is not None and window_close_ut is not None
                            else None
                        ),
                        "feasible": window_open_ut is not None,
                        "score": abs(error) + (abs(center["apoapsis_latitude_deg"]) * 0.25),
                    })
                except (PlannerError, ValueError, TypeError, ArithmeticError) as exc:
                    candidates.append({
                        "id": f"{node_type.lower()}-{sequence:02d}",
                        "sequence": sequence,
                        "node": node_type,
                        "burn_ut": node_ut,
                        "wait_s": node_ut - ut_now,
                        "feasible": False,
                        "rejection_reason": str(exc),
                        "score": 1.0e30,
                    })

            candidates.sort(key=lambda candidate: (not candidate["feasible"], candidate["score"]))
            base["candidates"] = candidates
            return base

    def _configure_streams(self, connection: Any, space_center: Any, vessel: Any) -> None:
        """Create the Fast-channel stream bank once per vessel binding.

        kRPC streams are pushed over the dedicated stream socket and avoid a
        separate RPC round trip for every field at every WebSocket frame.
        """
        orbit = _safe_read(vessel, "orbit")
        body = _safe_read(orbit, "body") if orbit is not None else None
        fixed_frame = _safe_read(body, "reference_frame") if body is not None else None
        inertial_frame = (
            _safe_read(body, "non_rotating_reference_frame") if body is not None else None
        )
        self._fixed_flight = self._flight(vessel, fixed_frame)
        self._inertial_flight = self._flight(vessel, inertial_frame)
        control = _safe_read(vessel, "control")
        self._streams = {}
        self._slow_cache = None
        self._slow_cache_at = 0.0
        self._sample_sequence = 0
        self._event_sequence = 0
        self._events = []
        self._previous_event_signals = None
        self._event_engine_groups = []
        self._event_fairing_groups = []
        self._event_decoupler_groups = []

        add_stream = getattr(connection, "add_stream", None)
        if not callable(add_stream):
            return

        stream_fields = {
            "ut": (space_center, "ut"),
            "met": (vessel, "met"),
            "situation": (vessel, "situation"),
            "altitude": (self._fixed_flight, "mean_altitude"),
            "surface_speed": (self._fixed_flight, "speed"),
            "inertial_speed": (self._inertial_flight, "speed"),
            "vertical_speed": (self._fixed_flight, "vertical_speed"),
            "horizontal_speed": (self._fixed_flight, "horizontal_speed"),
            "mach": (self._fixed_flight, "mach"),
            "dynamic_pressure": (self._fixed_flight, "dynamic_pressure"),
            "g_force": (self._fixed_flight, "g_force"),
            "pitch": (self._fixed_flight, "pitch"),
            "heading": (self._fixed_flight, "heading"),
            "roll": (self._fixed_flight, "roll"),
            "latitude": (self._fixed_flight, "latitude"),
            "longitude": (self._fixed_flight, "longitude"),
            "current_stage": (control, "current_stage"),
            "throttle": (control, "throttle"),
            "thrust": (vessel, "thrust"),
            "available_thrust": (vessel, "available_thrust"),
            "specific_impulse": (vessel, "specific_impulse"),
            "mass": (vessel, "mass"),
            "dry_mass": (vessel, "dry_mass"),
        }
        for key, (obj, attribute) in stream_fields.items():
            if obj is None:
                continue
            try:
                self._streams[key] = add_stream(getattr, obj, attribute)
            except Exception:
                # A single unavailable field must not tear down the whole feed.
                continue

        self._configure_event_streams(connection, vessel)

    def _configure_event_streams(self, connection: Any, vessel: Any) -> None:
        """Create high-rate streams for physical launch-event edges.

        Whole-vessel thrust cannot see booster cutoff while a core stage is
        still firing. Engines are therefore grouped by their KSP activation
        and decouple stages. Fairings and decouplers are grouped so paired or
        radial hardware produces one launch-record event rather than one event
        per part.
        """
        add_stream = getattr(connection, "add_stream", None)
        if not callable(add_stream):
            return

        parts = _safe_read(vessel, "parts")
        engines = list(_safe_read(parts, "engines") or []) if parts is not None else []
        fairings = list(_safe_read(parts, "fairings") or []) if parts is not None else []
        decouplers = list(_safe_read(parts, "decouplers") or []) if parts is not None else []

        def stage_number(part: Any, attribute: str) -> int:
            number = _finite_or_none(_safe_read(part, attribute))
            return int(number) if number is not None else -1

        engine_groups: dict[tuple[int, int], list[Any]] = {}
        for engine in engines:
            part = _safe_read(engine, "part")
            key = (stage_number(part, "stage"), stage_number(part, "decouple_stage"))
            engine_groups.setdefault(key, []).append(engine)

        for group_index, ((activation_stage, decouple_stage), group) in enumerate(
            sorted(engine_groups.items(), reverse=True)
        ):
            titles = sorted({
                str(
                    _safe_read(_safe_read(engine, "part"), "title")
                    or _safe_read(_safe_read(engine, "part"), "name")
                    or "ENGINE"
                )
                for engine in group
            })
            stream_members: list[dict[str, Any]] = []
            max_thrust_n = 0.0
            for engine_index, engine in enumerate(group):
                member: dict[str, Any] = {"engine": engine}
                for attribute in ("thrust", "active", "has_fuel"):
                    stream_key = f"event_engine_{group_index}_{engine_index}_{attribute}"
                    try:
                        self._streams[stream_key] = add_stream(getattr, engine, attribute)
                        member[attribute] = stream_key
                    except Exception:
                        continue
                stream_members.append(member)
                rated_thrust = _finite_or_none(_safe_read(engine, "max_vacuum_thrust"))
                if rated_thrust is None or rated_thrust <= 0.0:
                    rated_thrust = _finite_or_none(_safe_read(engine, "max_thrust"))
                max_thrust_n += max(0.0, rated_thrust or 0.0)

            self._event_engine_groups.append({
                "id": f"engine:{activation_stage}:{decouple_stage}",
                "activation_stage": activation_stage,
                "decouple_stage": decouple_stage,
                "title": " + ".join(titles),
                "engine_count": len(group),
                "max_thrust_n": max_thrust_n,
                "members": stream_members,
            })

        fairing_groups: dict[tuple[int, int], list[Any]] = {}
        for fairing in fairings:
            part = _safe_read(fairing, "part")
            key = (stage_number(part, "stage"), stage_number(part, "decouple_stage"))
            fairing_groups.setdefault(key, []).append(fairing)
        for group_index, ((activation_stage, decouple_stage), group) in enumerate(
            sorted(fairing_groups.items(), reverse=True)
        ):
            stream_keys: list[str | None] = []
            titles: set[str] = set()
            for fairing_index, fairing in enumerate(group):
                part = _safe_read(fairing, "part")
                titles.add(str(_safe_read(part, "title") or _safe_read(part, "name") or "FAIRING"))
                stream_key = f"event_fairing_{group_index}_{fairing_index}"
                try:
                    self._streams[stream_key] = add_stream(getattr, fairing, "jettisoned")
                    stream_keys.append(stream_key)
                except Exception:
                    stream_keys.append(None)
            self._event_fairing_groups.append({
                "id": f"fairing:{activation_stage}:{decouple_stage}",
                "activation_stage": activation_stage,
                "decouple_stage": decouple_stage,
                "title": " + ".join(sorted(titles)),
                "stream_keys": stream_keys,
                "fairings": group,
            })

        decoupler_groups: dict[int, list[Any]] = {}
        for decoupler in decouplers:
            part = _safe_read(decoupler, "part")
            decouple_stage = stage_number(part, "decouple_stage")
            decoupler_groups.setdefault(decouple_stage, []).append(decoupler)
        for group_index, (decouple_stage, group) in enumerate(
            sorted(decoupler_groups.items(), reverse=True)
        ):
            stream_keys: list[str | None] = []
            titles: set[str] = set()
            for decoupler_index, decoupler in enumerate(group):
                part = _safe_read(decoupler, "part")
                titles.add(str(_safe_read(part, "title") or _safe_read(part, "name") or "DECOUPLER"))
                stream_key = f"event_decoupler_{group_index}_{decoupler_index}"
                try:
                    self._streams[stream_key] = add_stream(getattr, decoupler, "decoupled")
                    stream_keys.append(stream_key)
                except Exception:
                    stream_keys.append(None)
            self._event_decoupler_groups.append({
                "id": f"decoupler:{decouple_stage}",
                "decouple_stage": decouple_stage,
                "title": " + ".join(sorted(titles)),
                "stream_keys": stream_keys,
                "decouplers": group,
            })

    def _read_fast_event_signals(self) -> dict[str, Any]:
        """Read the high-rate edge signals configured for the active vessel."""

        def stream_value(key: str | None, obj: Any, attribute: str) -> Any:
            if key:
                stream = self._streams.get(key)
                if stream is not None:
                    try:
                        return stream()
                    except Exception:
                        pass
            return _safe_read(obj, attribute)

        engine_groups: dict[str, dict[str, Any]] = {}
        for group in self._event_engine_groups:
            thrust_n = 0.0
            active_count = 0
            fueled_count = 0
            readable_thrust = False
            for member in group["members"]:
                engine = member["engine"]
                thrust = _finite_or_none(stream_value(member.get("thrust"), engine, "thrust"))
                if thrust is not None:
                    thrust_n += max(0.0, thrust)
                    readable_thrust = True
                if bool(stream_value(member.get("active"), engine, "active")):
                    active_count += 1
                if bool(stream_value(member.get("has_fuel"), engine, "has_fuel")):
                    fueled_count += 1
            threshold_n = max(100.0, float(group["max_thrust_n"] or 0.0) * 0.01)
            engine_groups[group["id"]] = {
                "activation_stage": group["activation_stage"],
                "decouple_stage": group["decouple_stage"],
                "title": group["title"],
                "engine_count": group["engine_count"],
                "active_count": active_count,
                "fueled_count": fueled_count,
                "thrust_n": thrust_n if readable_thrust else 0.0,
                "threshold_n": threshold_n,
            }

        fairing_groups: dict[str, dict[str, Any]] = {}
        for group in self._event_fairing_groups:
            states = []
            for index, fairing in enumerate(group["fairings"]):
                key = group["stream_keys"][index] if index < len(group["stream_keys"]) else None
                states.append(bool(stream_value(key, fairing, "jettisoned")))
            fairing_groups[group["id"]] = {
                "activation_stage": group["activation_stage"],
                "decouple_stage": group["decouple_stage"],
                "title": group["title"],
                "jettisoned": any(states),
            }

        decoupler_groups: dict[str, dict[str, Any]] = {}
        for group in self._event_decoupler_groups:
            states = []
            for index, decoupler in enumerate(group["decouplers"]):
                key = group["stream_keys"][index] if index < len(group["stream_keys"]) else None
                states.append(bool(stream_value(key, decoupler, "decoupled")))
            decoupler_groups[group["id"]] = {
                "decouple_stage": group["decouple_stage"],
                "title": group["title"],
                "decoupled": any(states),
            }

        return {
            "engine_groups": engine_groups,
            "fairing_groups": fairing_groups,
            "decoupler_groups": decoupler_groups,
        }

    def _remove_streams(self) -> None:
        for stream in self._streams.values():
            remove = getattr(stream, "remove", None)
            if callable(remove):
                try:
                    remove()
                except Exception:
                    pass
        self._streams = {}

    def _stream_or_read(self, key: str, obj: Any, attribute: str) -> Any:
        stream = self._streams.get(key)
        if stream is not None:
            try:
                return stream()
            except Exception:
                pass
        return _safe_read(obj, attribute)

    def _select_vessel(self, space_center: Any) -> Any:
        vessels = list(_safe_read(space_center, "vessels") or [])

        if self.config.vessel_id:
            for vessel in vessels:
                if str(_safe_read(vessel, "id")) == self.config.vessel_id:
                    return vessel
            raise NoVesselError(f"Configured vessel id not found: {self.config.vessel_id}")

        if self.config.vessel_name:
            for vessel in vessels:
                if str(_safe_read(vessel, "name")) == self.config.vessel_name:
                    return vessel
            raise NoVesselError(f"Configured vessel name not found: {self.config.vessel_name}")

        active = _safe_read(space_center, "active_vessel")
        if active is not None:
            return active
        if vessels:
            return vessels[0]
        raise NoVesselError("KSP has no active or selectable vessel")

    def _bind_status_to_vessel(self, vessel: Any) -> None:
        vessel_id = _safe_read(vessel, "id")
        self._status.vessel_id = None if vessel_id is None else str(vessel_id)
        self._status.vessel_name = str(_safe_read(vessel, "name") or "Unnamed vessel")

    def _read_snapshot(
        self,
        space_center: Any,
        vessel: Any,
        mission_profile: str,
    ) -> dict[str, Any]:
        sampled_monotonic_ns = time.perf_counter_ns()
        gateway_unix_ns = time.time_ns()
        ut = _finite_or_none(self._stream_or_read("ut", space_center, "ut"))
        if ut is None:
            raise KRPCAdapterError("space_center.ut is unavailable")

        orbit = _safe_read(vessel, "orbit")
        fixed_flight = self._fixed_flight
        inertial_flight = self._inertial_flight

        now = time.monotonic()
        if (
            self._slow_cache is None
            or now - self._slow_cache_at >= self.config.slow_sample_interval_s
        ):
            apoapsis = _finite_or_none(_safe_read(orbit, "apoapsis_altitude"))
            periapsis = _finite_or_none(_safe_read(orbit, "periapsis_altitude"))
            semi_major_axis = _finite_or_none(_safe_read(orbit, "semi_major_axis"))
            orbit_available = orbit is not None and apoapsis is not None and periapsis is not None
            orbit_valid = bool(
                orbit_available
                and semi_major_axis is not None
                and semi_major_axis > 0.0
                and apoapsis > 0.0
                and periapsis > 0.0
            )
            self._slow_cache = {
                "vessel": {
                    "id": str(_safe_read(vessel, "id") or "unknown-vessel"),
                    "name": str(_safe_read(vessel, "name") or "Unnamed vessel"),
                    "situation": _enum_text(_safe_read(vessel, "situation")),
                },
                "orbit": {
                    "apoapsis_altitude_m": apoapsis,
                    "periapsis_altitude_m": periapsis,
                    "eccentricity": _finite_or_none(_safe_read(orbit, "eccentricity")),
                    "inclination_rad": _finite_or_none(_safe_read(orbit, "inclination")),
                    "period_s": _finite_or_none(_safe_read(orbit, "period")),
                },
                "orbit_quality": (
                    "valid" if orbit_valid else ("invalid" if orbit_available else "unavailable")
                ),
                "staging_topology": self._read_staging_topology(vessel),
            }
            self._slow_cache_at = now

        assert self._slow_cache is not None
        latitude = _finite_or_none(self._stream_or_read("latitude", fixed_flight, "latitude"))
        longitude = _finite_or_none(self._stream_or_read("longitude", fixed_flight, "longitude"))
        frames_valid = bool(
            latitude is not None
            and longitude is not None
            and -90.0 <= latitude <= 90.0
            and -180.0 <= longitude <= 360.0
        )

        profile = mission_profile.upper()
        if profile not in {"EARTH_ORBIT", "GEO_SLOT", "TLI", "SSO", "TMI", "CUSTOM"}:
            profile = "CUSTOM"

        self._sample_sequence += 1

        control = _safe_read(vessel, "control")
        current_stage_number = _finite_or_none(
            self._stream_or_read("current_stage", control, "current_stage")
        )
        thrust = _finite_or_none(self._stream_or_read("thrust", vessel, "thrust"))
        available_thrust = _finite_or_none(
            self._stream_or_read("available_thrust", vessel, "available_thrust")
        )
        specific_impulse = _finite_or_none(
            self._stream_or_read("specific_impulse", vessel, "specific_impulse")
        )
        topology = self._slow_cache["staging_topology"]
        estimated_propellant_mass = topology["estimated_propellant_mass_kg"]
        estimated_mass_flow = None
        estimated_burn_time = None
        if (
            available_thrust is not None
            and available_thrust > 0.0
            and specific_impulse is not None
            and specific_impulse > 0.0
        ):
            estimated_mass_flow = available_thrust / (specific_impulse * 9.80665)
            if estimated_propellant_mass is not None and estimated_mass_flow > 0.0:
                estimated_burn_time = estimated_propellant_mass / estimated_mass_flow

        met = _finite_or_none(self._stream_or_read("met", vessel, "met")) or 0.0
        staging_state = {
            "current_stage": (
                int(current_stage_number) if current_stage_number is not None else None
            ),
            "throttle": _finite_or_none(
                self._stream_or_read("throttle", control, "throttle")
            ),
            "thrust_n": thrust,
            "available_thrust_n": available_thrust,
            "specific_impulse_s": specific_impulse,
            "mass_kg": _finite_or_none(self._stream_or_read("mass", vessel, "mass")),
            "dry_mass_kg": _finite_or_none(
                self._stream_or_read("dry_mass", vessel, "dry_mass")
            ),
            "estimated_propellant_mass_kg": estimated_propellant_mass,
            "estimated_mass_flow_kg_s": estimated_mass_flow,
            "estimated_burn_time_s": estimated_burn_time,
            "active_engine_count": topology["active_engine_count"],
            "fueled_engine_count": topology["fueled_engine_count"],
            "fairing_count": topology["fairing_count"],
            "jettisoned_fairing_count": topology["jettisoned_fairing_count"],
        }
        self._detect_events(ut, met, staging_state)

        return {
            "schema_version": "1.0",
            "mission_id": self.config.mission_id,
            "mission_profile": profile,
            "source": "krpc",
            "sample_ut": ut,
            "sample_seq": self._sample_sequence,
            "sample_monotonic_ns": sampled_monotonic_ns,
            "gateway_unix_ns": gateway_unix_ns,
            "met_s": met,
            "vessel": self._slow_cache["vessel"],
            "orbit": self._slow_cache["orbit"],
            "flight": {
                "altitude_m": _finite_or_none(self._stream_or_read("altitude", fixed_flight, "mean_altitude")),
                "surface_speed_m_s": _finite_or_none(self._stream_or_read("surface_speed", fixed_flight, "speed")),
                "inertial_speed_m_s": _finite_or_none(self._stream_or_read("inertial_speed", inertial_flight, "speed")),
                "vertical_speed_m_s": _finite_or_none(self._stream_or_read("vertical_speed", fixed_flight, "vertical_speed")),
                "horizontal_speed_m_s": _finite_or_none(self._stream_or_read("horizontal_speed", fixed_flight, "horizontal_speed")),
                "mach": _finite_or_none(self._stream_or_read("mach", fixed_flight, "mach")),
                "dynamic_pressure_pa": _finite_or_none(self._stream_or_read("dynamic_pressure", fixed_flight, "dynamic_pressure")),
                "g_force": _finite_or_none(self._stream_or_read("g_force", fixed_flight, "g_force")),
                "pitch_deg": _finite_or_none(self._stream_or_read("pitch", fixed_flight, "pitch")),
                "heading_deg": _finite_or_none(self._stream_or_read("heading", fixed_flight, "heading")),
                "roll_deg": _finite_or_none(self._stream_or_read("roll", fixed_flight, "roll")),
                "latitude_deg": latitude,
                "longitude_deg": longitude,
            },
            "staging": staging_state,
            "events": list(self._events),
            "quality": {
                "connection": "connected",
                "orbit": self._slow_cache["orbit_quality"],
                "frames": "pass" if frames_valid else "degraded",
            },
        }

    def _detect_events(self, ut: float, met: float, staging: dict[str, Any]) -> None:
        current = {
            "stage": staging["current_stage"],
            "thrust": float(staging["thrust_n"] or 0.0),
            "available_thrust": float(staging["available_thrust_n"] or 0.0),
            "active_engines": int(staging["active_engine_count"]),
            "fairings": int(staging["fairing_count"]),
            "jettisoned_fairings": int(staging["jettisoned_fairing_count"]),
        }
        previous = self._previous_event_signals
        self._previous_event_signals = current
        if previous is None or met < 0.0:
            if met < 0.0:
                self._events = []
                self._event_sequence = 0
            return

        threshold = max(100.0, current["available_thrust"] * 0.01)
        previous_threshold = max(100.0, previous["available_thrust"] * 0.01)

        if previous["thrust"] <= previous_threshold and current["thrust"] > threshold:
            self._append_event(
                "ENGINE_IGNITION", ut, met, current["stage"],
                f"{current['active_engines']} active engine(s)",
            )
        if previous["thrust"] > previous_threshold and current["thrust"] <= threshold:
            self._append_event(
                "ENGINE_CUTOFF", ut, met, current["stage"],
                "Vessel thrust crossed the cutoff threshold",
            )
        if previous["stage"] != current["stage"]:
            self._append_event(
                "STAGE_CHANGE", ut, met, current["stage"],
                f"KSP stage {previous['stage']} -> {current['stage']}",
            )
        fairing_removed = previous["fairings"] > current["fairings"]
        fairing_flagged = previous["jettisoned_fairings"] < current["jettisoned_fairings"]
        if fairing_removed or fairing_flagged:
            self._append_event(
                "FAIRING_JETTISON", ut, met, current["stage"],
                "Fairing topology changed or jettison flag was raised",
            )

    def _append_event(
        self,
        event_type: str,
        ut: float,
        met: float,
        stage: int | None,
        detail: str,
    ) -> None:
        self._event_sequence += 1
        self._events.append({
            "sequence": self._event_sequence,
            "type": event_type,
            "ut": ut,
            "met_s": met,
            "stage": stage,
            "detail": detail,
        })
        self._events = self._events[-32:]

    @staticmethod
    def _read_staging_topology(vessel: Any) -> dict[str, Any]:
        parts = _safe_read(vessel, "parts")
        engines = list(_safe_read(parts, "engines") or []) if parts is not None else []
        fairings = list(_safe_read(parts, "fairings") or []) if parts is not None else []
        all_parts = list(_safe_read(parts, "all") or []) if parts is not None else []

        active_engines = [engine for engine in engines if bool(_safe_read(engine, "active"))]
        fueled_engines = [
            engine for engine in active_engines if bool(_safe_read(engine, "has_fuel"))
        ]
        active_decouple_stages = {
            int(stage)
            for engine in active_engines
            if (stage := _finite_or_none(_safe_read(_safe_read(engine, "part"), "decouple_stage")))
            is not None
            and stage >= 0
        }

        propellant_mass = 0.0
        matched_propellant_parts = 0
        for part in all_parts:
            decouple_stage = _finite_or_none(_safe_read(part, "decouple_stage"))
            if not active_decouple_stages or decouple_stage not in active_decouple_stages:
                continue
            mass = _finite_or_none(_safe_read(part, "mass"))
            dry_mass = _finite_or_none(_safe_read(part, "dry_mass"))
            if mass is None or dry_mass is None:
                continue
            propellant_mass += max(0.0, mass - dry_mass)
            matched_propellant_parts += 1

        return {
            "active_engine_count": len(active_engines),
            "fueled_engine_count": len(fueled_engines),
            "fairing_count": len(fairings),
            "jettisoned_fairing_count": sum(
                1 for fairing in fairings if bool(_safe_read(fairing, "jettisoned"))
            ),
            "estimated_propellant_mass_kg": (
                propellant_mass if matched_propellant_parts > 0 else None
            ),
        }

    @staticmethod
    def _infer_stage_manifest(vessel: Any) -> dict[str, Any]:
        parts = _safe_read(vessel, "parts")
        engines = list(_safe_read(parts, "engines") or []) if parts is not None else []
        fairings = list(_safe_read(parts, "fairings") or []) if parts is not None else []
        all_parts = list(_safe_read(parts, "all") or []) if parts is not None else []
        if not engines:
            raise KRPCAdapterError(
                "The active vessel has no engines visible to kRPC; load the launch vehicle before auto-detecting stages."
            )

        def stage_number(value: Any) -> int:
            number = _finite_or_none(value)
            return int(number) if number is not None else -1

        part_buckets: dict[int, dict[str, float]] = {}
        for part in all_parts:
            decouple_stage = stage_number(_safe_read(part, "decouple_stage"))
            mass = _finite_or_none(_safe_read(part, "mass"))
            dry_mass = _finite_or_none(_safe_read(part, "dry_mass"))
            if mass is None or dry_mass is None:
                continue
            bucket = part_buckets.setdefault(
                decouple_stage,
                {"wet": 0.0, "dry": 0.0, "propellant": 0.0},
            )
            bucket["wet"] += max(0.0, mass)
            bucket["dry"] += max(0.0, dry_mass)
            bucket["propellant"] += max(0.0, mass - dry_mass)

        engine_groups: dict[tuple[int, int], list[dict[str, Any]]] = {}
        for engine in engines:
            part = _safe_read(engine, "part")
            activation_stage = stage_number(_safe_read(part, "stage"))
            decouple_stage = stage_number(_safe_read(part, "decouple_stage"))
            thrust = _finite_or_none(_safe_read(engine, "max_vacuum_thrust"))
            if thrust is None or thrust <= 0.0:
                thrust = _finite_or_none(_safe_read(engine, "max_thrust"))
            isp = _finite_or_none(_safe_read(engine, "vacuum_specific_impulse"))
            if isp is None or isp <= 0.0:
                isp = _finite_or_none(_safe_read(engine, "specific_impulse"))
            title = str(
                _safe_read(part, "title")
                or _safe_read(part, "name")
                or "ENGINE"
            )
            engine_groups.setdefault((activation_stage, decouple_stage), []).append({
                "title": title,
                "thrust": thrust,
                "isp": isp,
                "radial": bool(_safe_read(part, "radially_attached")),
            })

        ordered_groups = sorted(
            engine_groups.items(),
            key=lambda item: (-item[0][0], -int(any(e["radial"] for e in item[1])), -item[0][1]),
        )
        activation_counts: dict[int, int] = {}
        for (activation_stage, _), group in ordered_groups:
            activation_counts[activation_stage] = activation_counts.get(activation_stage, 0) + 1

        warnings = [
            "Delta-V and burn time are inferred from loaded-part mass, dry mass, vacuum thrust and vacuum Isp.",
            "Ignition counts cannot be read reliably from generic kRPC/RealFuels fields and default to 1.",
        ]
        if any(count > 1 for count in activation_counts.values()):
            warnings.append(
                "Parallel engine groups share an activation stage; booster/core crossfeed and unequal cutoff timing reduce delta-V accuracy."
            )
        if -1 in part_buckets:
            warnings.append(
                "Parts with decouple_stage -1 are attached to the root stack; payload and retained hardware may be combined."
            )

        vessel_mass = _finite_or_none(_safe_read(vessel, "mass"))
        if vessel_mass is None or vessel_mass <= 0.0:
            vessel_mass = sum(bucket["wet"] for bucket in part_buckets.values()) or None
        remaining_mass = vessel_mass
        total_delta_v = 0.0
        total_delta_v_valid = False
        inferred: list[dict[str, Any]] = []
        non_radial_sequence = 0
        upper_sequence = 0

        by_activation: dict[int, list[tuple[tuple[int, int], list[dict[str, Any]]]]] = {}
        for key, group in ordered_groups:
            by_activation.setdefault(key[0], []).append((key, group))

        for activation_stage in sorted(by_activation, reverse=True):
            level = by_activation[activation_stage]
            level_thrust = 0.0
            level_flow = 0.0
            level_propellant = 0.0
            level_decouple_stages: set[int] = set()

            for (_, decouple_stage), group in level:
                radial = sum(1 for engine in group if engine["radial"]) >= len(group) / 2
                if radial:
                    role = "BOOSTER"
                    name = "BOOSTER STAGE"
                    cutoff_event = "BECO"
                else:
                    non_radial_sequence += 1
                    if non_radial_sequence == 1:
                        role = "CORE"
                        name = "CORE STAGE"
                        cutoff_event = "MECO"
                    else:
                        upper_sequence += 1
                        role = "UPPER" if upper_sequence == 1 else "KICK"
                        name = "UPPER STAGE" if upper_sequence == 1 else f"KICK STAGE {upper_sequence}"
                        cutoff_event = "SECO" if upper_sequence == 1 else f"SECO-{upper_sequence}"

                titles = sorted({engine["title"] for engine in group})
                thrusts = [engine["thrust"] for engine in group if engine["thrust"] and engine["thrust"] > 0.0]
                usable = [engine for engine in group if engine["thrust"] and engine["isp"] and engine["isp"] > 0.0]
                thrust = sum(thrusts) if thrusts else None
                flow = sum(engine["thrust"] / (engine["isp"] * 9.80665) for engine in usable)
                equivalent_isp = (sum(engine["thrust"] for engine in usable) / (flow * 9.80665)) if flow > 0.0 else None
                mass_bucket = part_buckets.get(decouple_stage)
                wet_mass = mass_bucket["wet"] if mass_bucket else None
                dry_mass = mass_bucket["dry"] if mass_bucket else None
                propellant_mass = mass_bucket["propellant"] if mass_bucket else None
                burn_time = (
                    propellant_mass / flow
                    if propellant_mass is not None and propellant_mass > 0.0 and flow > 0.0
                    else None
                )
                delta_v = None
                if (
                    remaining_mass is not None
                    and remaining_mass > 0.0
                    and propellant_mass is not None
                    and propellant_mass > 0.0
                    and equivalent_isp is not None
                    and remaining_mass > propellant_mass
                ):
                    delta_v = equivalent_isp * 9.80665 * math.log(
                        remaining_mass / (remaining_mass - propellant_mass)
                    )

                inferred.append({
                    "activation_stage": activation_stage,
                    "decouple_stage": decouple_stage,
                    "name": name,
                    "role": role,
                    "engine_group": " + ".join(titles),
                    "engine_titles": titles,
                    "engine_count": len(group),
                    "max_vacuum_thrust_n": thrust,
                    "vacuum_specific_impulse_s": equivalent_isp,
                    "wet_mass_kg": wet_mass,
                    "dry_mass_kg": dry_mass,
                    "propellant_mass_kg": propellant_mass,
                    "estimated_delta_v_m_s": delta_v,
                    "estimated_burn_time_s": burn_time,
                    "planned_ignitions": 1,
                    "cutoff_event": cutoff_event,
                })

                if thrust is not None:
                    level_thrust += thrust
                level_flow += flow
                if propellant_mass is not None and decouple_stage not in level_decouple_stages:
                    level_propellant += propellant_mass
                level_decouple_stages.add(decouple_stage)

            level_isp = level_thrust / (level_flow * 9.80665) if level_flow > 0.0 else None
            if (
                remaining_mass is not None
                and remaining_mass > level_propellant > 0.0
                and level_isp is not None
            ):
                total_delta_v += level_isp * 9.80665 * math.log(
                    remaining_mass / (remaining_mass - level_propellant)
                )
                total_delta_v_valid = True
                remaining_mass -= level_propellant
                for decouple_stage in level_decouple_stages:
                    if decouple_stage >= 0:
                        remaining_mass -= part_buckets.get(decouple_stage, {}).get("dry", 0.0)
                remaining_mass = max(0.0, remaining_mass)

        fairing_manifest = []
        for fairing in fairings:
            part = _safe_read(fairing, "part")
            fairing_manifest.append({
                "title": str(_safe_read(part, "title") or _safe_read(part, "name") or "FAIRING"),
                "activation_stage": stage_number(_safe_read(part, "stage")),
                "decouple_stage": stage_number(_safe_read(part, "decouple_stage")),
                "jettisoned": bool(_safe_read(fairing, "jettisoned")),
            })

        control = _safe_read(vessel, "control")
        current_stage = _finite_or_none(_safe_read(control, "current_stage"))
        return {
            "schema_version": "1.0",
            "vessel": {
                "id": str(_safe_read(vessel, "id") or "unknown-vessel"),
                "name": str(_safe_read(vessel, "name") or "Unnamed vessel"),
            },
            "current_stage": int(current_stage) if current_stage is not None else None,
            "confidence": "low" if any(count > 1 for count in activation_counts.values()) else "estimated",
            "total_estimated_delta_v_m_s": total_delta_v if total_delta_v_valid else None,
            "stages": inferred,
            "fairings": fairing_manifest,
            "warnings": warnings,
        }

    @staticmethod
    def _flight(vessel: Any, reference_frame: Any) -> Any | None:
        if reference_frame is None:
            return None
        try:
            return vessel.flight(reference_frame)
        except Exception:
            return None
