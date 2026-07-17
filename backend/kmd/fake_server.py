"""Deterministic fake kRPC backend for UI development and integration tests."""

from __future__ import annotations

import asyncio
import math
import os
import time
from copy import deepcopy
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .planner import sun_sync_design_point
from .simulator import demo_snapshot


SCENARIOS = {
    "nominal_ascent",
    "high_altitude",
    "long_labels",
    "null_values",
    "numeric_extremes",
    "malformed",
    "sequence_gap",
    "planner_hold",
    "stage_error",
    "disconnected",
}


class FakeState:
    def __init__(self) -> None:
        self.scenario = "nominal_ascent"
        self.sequence = 0

    def set_scenario(self, scenario: str) -> None:
        if scenario not in SCENARIOS:
            raise ValueError(f"Unknown fake scenario: {scenario}")
        self.scenario = scenario
        self.sequence = 0

    def next_sequence(self) -> int:
        self.sequence += 3 if self.scenario == "sequence_gap" else 1
        return self.sequence


state = FakeState()
state.set_scenario(os.getenv("KMD_FAKE_SCENARIO", "nominal_ascent"))
app = FastAPI(title="KMD fake backend", version="1.0-test")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _profile(value: str) -> str:
    allowed = {"EARTH_ORBIT", "GEO_SLOT", "TLI", "SSO", "TMI", "CUSTOM"}
    return value if value in allowed else "CUSTOM"


def telemetry_snapshot(mission_profile: str = "EARTH_ORBIT") -> dict[str, Any]:
    if state.scenario == "malformed":
        return {"schema_version": "1.0", "source": "krpc", "mission_id": "malformed"}

    payload = demo_snapshot().model_dump()
    sequence = state.next_sequence()
    payload.update(
        source="krpc",
        mission_profile=_profile(mission_profile),
        mission_id="fake-integration-flight",
        sample_seq=sequence,
        sample_ut=450_581_502.680 + (sequence / 50.0),
        sample_monotonic_ns=time.perf_counter_ns(),
        gateway_unix_ns=time.time_ns(),
        met_s=1357.496 + (sequence / 50.0),
    )
    payload["quality"] = {"connection": "connected", "orbit": "valid", "frames": "pass"}
    payload["vessel"] = {
        "id": "fake-vessel-001",
        "name": "SELENE-KAGUYA TEST VEHICLE",
        "situation": "flying",
    }
    payload["flight"]["altitude_m"] = 84_620.0
    payload["flight"]["surface_speed_m_s"] = 2_314.7
    payload["flight"]["inertial_speed_m_s"] = 2_661.2

    if state.scenario == "high_altitude":
        payload["flight"]["altitude_m"] = 125_000.0
        payload["vessel"]["situation"] = "orbiting"
    elif state.scenario == "long_labels":
        payload["vessel"]["name"] = "超長名称試験機体 / " + ("KAGUYA-EXTENDED-VEHICLE-NAME-" * 10)
        payload["vessel"]["situation"] = "orbiting_with_an_intentionally_long_status_label"
        payload["events"] = [
            {
                "sequence": 1,
                "type": "ENGINE_CUTOFF",
                "ut": payload["sample_ut"],
                "met_s": payload["met_s"],
                "stage": 4,
                "detail": "LONG EVENT " + ("UPPER-STAGE-CUTOFF-" * 12),
            }
        ]
    elif state.scenario == "null_values":
        payload["orbit"] = {key: None for key in payload["orbit"]}
        payload["flight"] = {key: None for key in payload["flight"]}
        for key in (
            "current_stage", "throttle", "thrust_n", "available_thrust_n",
            "specific_impulse_s", "mass_kg", "dry_mass_kg",
            "estimated_propellant_mass_kg", "estimated_mass_flow_kg_s",
            "estimated_burn_time_s",
        ):
            payload["staging"][key] = None
        payload["quality"]["orbit"] = "unavailable"
    elif state.scenario == "numeric_extremes":
        for key in payload["flight"]:
            payload["flight"][key] = 9.999e15
        payload["orbit"]["apoapsis_altitude_m"] = 9.999e15
        payload["orbit"]["periapsis_altitude_m"] = -9.999e15
        payload["met_s"] = 31_536_000_000.99
        payload["sample_ut"] = 1.0e20

    return payload


def stage_manifest() -> dict[str, Any]:
    long = state.scenario == "long_labels"
    stage_name = "UPPER STAGE " + ("WITH-AN-INTENTIONALLY-LONG-DESIGNATION-" * 8) if long else "CORE STAGE"
    engine_group = "ENGINE GROUP " + ("EXTREMELY-LONG-" * 10) if long else "MAIN ENGINES"
    return {
        "schema_version": "1.0",
        "vessel": {"id": "fake-vessel-001", "name": telemetry_snapshot()["vessel"]["name"]},
        "current_stage": 4,
        "confidence": "estimated",
        "total_estimated_delta_v_m_s": 9_432.4,
        "stages": [
            {
                "activation_stage": 4,
                "decouple_stage": 3,
                "name": stage_name,
                "role": "CORE",
                "engine_group": engine_group,
                "engine_titles": [engine_group],
                "engine_count": 2,
                "max_vacuum_thrust_n": 2_200_000.0,
                "vacuum_specific_impulse_s": 342.0,
                "wet_mass_kg": 185_000.0,
                "dry_mass_kg": 23_000.0,
                "propellant_mass_kg": 162_000.0,
                "estimated_delta_v_m_s": 5_180.0,
                "estimated_burn_time_s": 178.4,
                "planned_ignitions": 1,
                "cutoff_event": "MECO",
            },
            {
                "activation_stage": 2,
                "decouple_stage": 1,
                "name": "CRYOGENIC UPPER STAGE",
                "role": "UPPER",
                "engine_group": "UPPER ENGINE",
                "engine_titles": ["UPPER ENGINE"],
                "engine_count": 1,
                "max_vacuum_thrust_n": 440_000.0,
                "vacuum_specific_impulse_s": 451.0,
                "wet_mass_kg": 49_000.0,
                "dry_mass_kg": 8_500.0,
                "propellant_mass_kg": 40_500.0,
                "estimated_delta_v_m_s": 4_252.4,
                "estimated_burn_time_s": 512.2,
                "planned_ignitions": 3,
                "cutoff_event": "SECO",
            },
        ],
        "fairings": [
            {"title": "PAYLOAD FAIRING", "activation_stage": 3, "decouple_stage": 2, "jettisoned": False}
        ],
        "warnings": (["LONG LABEL SCENARIO " + ("WARNING-" * 40)] if long else []),
    }


def geo_plan(target: float, tolerance: float, node_filter: str, max_nodes: int) -> dict[str, Any]:
    hold = state.scenario == "planner_hold"
    nodes = ["AN", "DN"] if node_filter == "ALL" else [node_filter]
    candidates = []
    if not hold:
        for index in range(min(max_nodes, 4)):
            node = nodes[index % len(nodes)]
            error = (-0.06 if index == 0 else 0.42 + index)
            candidates.append(
                {
                    "id": f"fake-{node.lower()}-{index}",
                    "sequence": index,
                    "node": node,
                    "burn_ut": 450_582_000.0 + (index * 2_700.0),
                    "burn_met_s": 1_855.0 + (index * 2_700.0),
                    "wait_s": 497.5 + (index * 2_700.0),
                    "burn_longitude_deg": 289.3,
                    "burn_latitude_deg": 0.0,
                    "delta_v_m_s": 2_431.8,
                    "coast_to_apoapsis_s": 18_943.7,
                    "apoapsis_ut": 450_600_943.7 + (index * 2_700.0),
                    "apoapsis_longitude_deg": (target + error) % 360.0,
                    "apoapsis_latitude_deg": 0.0,
                    "transfer_semi_major_axis_m": 24_367_586.0,
                    "transfer_eccentricity": 0.7303,
                    "transfer_periapsis_radius_m": 6_571_000.0,
                    "transfer_apoapsis_radius_m": 42_164_172.0,
                    "longitude_error_deg": error,
                    "longitude_rate_deg_s": -0.00417,
                    "window_open_ut": 450_581_985.6 if abs(error) <= tolerance else None,
                    "window_close_ut": 450_582_014.4 if abs(error) <= tolerance else None,
                    "window_width_s": 28.8 if abs(error) <= tolerance else None,
                    "feasible": abs(error) <= tolerance,
                    "rejection_reason": None if abs(error) <= tolerance else "OUTSIDE_LONGITUDE_TOLERANCE",
                    "score": abs(error),
                }
            )
    return {
        "schema_version": "1.0",
        "source": "krpc",
        "model": "L1_TWO_BODY_IMPULSIVE",
        "ready": not hold,
        "sample_ut": 450_581_502.68,
        "met_s": 1_357.496,
        "target_longitude_deg": target,
        "tolerance_deg": tolerance,
        "node_filter": node_filter,
        "vessel": {"id": "fake-vessel-001", "name": telemetry_snapshot()["vessel"]["name"], "situation": "orbiting"},
        "body": {
            "name": "Earth",
            "gravitational_parameter_m3_s2": 3.98600435436e14,
            "equatorial_radius_m": 6_371_000.0,
            "rotational_speed_rad_s": 7.2921151e-5,
            "synchronous_radius_m": 42_164_172.0,
        },
        "parking_orbit": {
            "semi_major_axis_m": 6_591_000.0,
            "periapsis_altitude_m": 219_725.0,
            "apoapsis_altitude_m": 220_581.0,
            "eccentricity": 0.0000648,
            "inclination_rad": 0.342318,
            "period_s": 5_334.061,
        },
        "rejection_reasons": (["PARKING_ORBIT_NOT_STABLE"] if hold else []),
        "warnings": [],
        "candidates": candidates,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "service": "kmd-fake-backend", "scenario": state.scenario}


@app.post("/__test__/scenario/{scenario}")
def select_scenario(scenario: str) -> dict[str, str]:
    try:
        state.set_scenario(scenario)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"scenario": state.scenario}


@app.get("/v1/telemetry/live")
def telemetry_live(mission_profile: str = Query(default="EARTH_ORBIT")) -> dict[str, Any]:
    if state.scenario == "disconnected":
        raise HTTPException(status_code=503, detail="Fake kRPC link disconnected")
    return telemetry_snapshot(mission_profile)


@app.get("/v1/vehicle/stages")
def vehicle_stages() -> dict[str, Any]:
    if state.scenario == "stage_error":
        raise HTTPException(status_code=503, detail="Fake craft topology unavailable")
    return stage_manifest()


@app.get("/v1/planner/geo")
def planner_geo(
    target_longitude_deg: float = Query(default=110.0),
    tolerance_deg: float = Query(default=0.1),
    node_filter: str = Query(default="ALL"),
    max_nodes: int = Query(default=8),
) -> dict[str, Any]:
    return geo_plan(target_longitude_deg, tolerance_deg, node_filter, max_nodes)


@app.get("/v1/planner/sso")
def planner_sso(
    solve_for: str = Query(default="INCLINATION"),
    altitude_km: float = Query(default=600.0),
    inclination_deg: float = Query(default=97.8),
    eccentricity: float = Query(default=0.0),
    ltan: str = Query(default="10:30"),
    multibody_enabled: bool = Query(default=False),
    mu_km3_s2: float = Query(default=398_600.435_436),
    equatorial_radius_km: float = Query(default=6_371.0),
    j2: float = Query(default=1.082_626_68e-3),
    tropical_year_days: float = Query(default=365.2422),
) -> dict[str, Any]:
    mu = mu_km3_s2 * 1.0e9
    radius = equatorial_radius_km * 1.0e3
    selected = sun_sync_design_point(
        mu_m3_s2=mu,
        equatorial_radius_m=radius,
        j2=j2,
        altitude_m=altitude_km * 1.0e3 if solve_for == "INCLINATION" else None,
        inclination_rad=math.radians(inclination_deg) if solve_for == "ALTITUDE" else None,
        eccentricity=eccentricity,
        tropical_year_days=tropical_year_days,
    )
    sweep = [
        sun_sync_design_point(
            mu_m3_s2=mu,
            equatorial_radius_m=radius,
            j2=j2,
            altitude_m=height_km * 1.0e3,
            eccentricity=eccentricity,
            tropical_year_days=tropical_year_days,
        )
        for height_km in (300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 900.0, 1_000.0)
    ]
    return {
        "schema_version": "1.0",
        "source": "analytic",
        "model": "J2_SECULAR_FIRST_ORDER",
        "ready": multibody_enabled,
        "multibody_required": True,
        "multibody_enabled": multibody_enabled,
        "solve_for": solve_for,
        "ltan": ltan,
        "body": {
            "name": "RSS EARTH",
            "gravitational_parameter_m3_s2": mu,
            "equatorial_radius_m": radius,
            "j2": j2,
            "tropical_year_days": tropical_year_days,
        },
        "selected": selected,
        "sweep": sweep,
        "warnings": ["Deterministic SSO design fixture."],
    }


@app.websocket("/v1/telemetry/ws")
async def telemetry_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    profile = websocket.query_params.get("mission_profile", "EARTH_ORBIT")
    try:
        requested_hz = float(websocket.query_params.get("hz", "25"))
    except ValueError:
        requested_hz = 25.0
    if not math.isfinite(requested_hz):
        requested_hz = 25.0
    hz = min(max(requested_hz, 1.0), 50.0)
    try:
        while True:
            if state.scenario == "disconnected":
                await websocket.send_json({"type": "telemetry_error", "detail": "Fake kRPC link disconnected"})
            else:
                await websocket.send_json(deepcopy(telemetry_snapshot(profile)))
            await asyncio.sleep(1.0 / hz)
    except (WebSocketDisconnect, RuntimeError, OSError):
        return
