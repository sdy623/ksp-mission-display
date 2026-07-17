from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class VesselState(ContractModel):
    id: str
    name: str
    situation: str


class OrbitState(ContractModel):
    apoapsis_altitude_m: float | None
    periapsis_altitude_m: float | None
    eccentricity: float | None
    inclination_rad: float | None
    period_s: float | None


class FlightState(ContractModel):
    altitude_m: float | None
    surface_speed_m_s: float | None
    inertial_speed_m_s: float | None
    vertical_speed_m_s: float | None
    horizontal_speed_m_s: float | None
    mach: float | None
    dynamic_pressure_pa: float | None
    g_force: float | None
    pitch_deg: float | None
    heading_deg: float | None
    roll_deg: float | None
    latitude_deg: float | None
    longitude_deg: float | None


class StagingState(ContractModel):
    current_stage: int | None
    throttle: float | None
    thrust_n: float | None
    available_thrust_n: float | None
    specific_impulse_s: float | None
    mass_kg: float | None
    dry_mass_kg: float | None
    estimated_propellant_mass_kg: float | None
    estimated_mass_flow_kg_s: float | None
    estimated_burn_time_s: float | None
    active_engine_count: int
    fueled_engine_count: int
    fairing_count: int
    jettisoned_fairing_count: int


class FlightEvent(ContractModel):
    sequence: int
    type: Literal["ENGINE_IGNITION", "ENGINE_CUTOFF", "STAGE_CHANGE", "FAIRING_JETTISON"]
    ut: float
    met_s: float
    stage: int | None
    detail: str


class QualityState(ContractModel):
    connection: Literal["connected", "simulated", "disconnected"]
    orbit: Literal["valid", "invalid", "unavailable"]
    frames: Literal["pass", "degraded", "fail"]


class TelemetrySnapshot(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    mission_id: str
    mission_profile: Literal["EARTH_ORBIT", "GEO_SLOT", "TLI", "SSO", "TMI", "CUSTOM"]
    source: Literal["simulated", "krpc", "replay"]
    sample_ut: float
    sample_seq: int
    sample_monotonic_ns: int
    gateway_unix_ns: int
    met_s: float
    vessel: VesselState
    orbit: OrbitState
    flight: FlightState
    staging: StagingState
    events: list[FlightEvent]
    quality: QualityState


class HealthResponse(ContractModel):
    status: Literal["ok", "degraded"] = "ok"
    service: str = "kmd-backend"
    version: str = "0.2.0"
    mode: Literal["live"] = "live"
    krpc_state: Literal["disconnected", "connecting", "connected", "degraded"]
    krpc_error: str | None = None


class KRPCStatusResponse(ContractModel):
    state: Literal["disconnected", "connecting", "connected", "degraded"]
    address: str
    rpc_port: int
    stream_port: int
    vessel_id: str | None
    vessel_name: str | None
    connected_at_monotonic: float | None
    last_sample_ut: float | None
    last_error: str | None


class GeoPlannerVessel(ContractModel):
    id: str
    name: str
    situation: str


class GeoPlannerBody(ContractModel):
    name: str
    gravitational_parameter_m3_s2: float | None
    equatorial_radius_m: float | None
    rotational_speed_rad_s: float | None
    synchronous_radius_m: float | None


class GeoPlannerParkingOrbit(ContractModel):
    semi_major_axis_m: float | None
    periapsis_altitude_m: float | None
    apoapsis_altitude_m: float | None
    eccentricity: float | None
    inclination_rad: float | None
    period_s: float | None


class GeoPlannerCandidate(ContractModel):
    id: str
    sequence: int
    node: Literal["AN", "DN"]
    burn_ut: float
    burn_met_s: float | None = None
    wait_s: float
    burn_longitude_deg: float | None = None
    burn_latitude_deg: float | None = None
    delta_v_m_s: float | None = None
    coast_to_apoapsis_s: float | None = None
    apoapsis_ut: float | None = None
    apoapsis_longitude_deg: float | None = None
    apoapsis_latitude_deg: float | None = None
    transfer_semi_major_axis_m: float | None = None
    transfer_eccentricity: float | None = None
    transfer_periapsis_radius_m: float | None = None
    transfer_apoapsis_radius_m: float | None = None
    longitude_error_deg: float | None = None
    longitude_rate_deg_s: float | None = None
    window_open_ut: float | None = None
    window_close_ut: float | None = None
    window_width_s: float | None = None
    feasible: bool
    rejection_reason: str | None = None
    score: float


class GeoPlannerResponse(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    source: Literal["krpc"]
    model: Literal["L1_TWO_BODY_IMPULSIVE"]
    ready: bool
    sample_ut: float | None
    met_s: float | None
    target_longitude_deg: float
    tolerance_deg: float
    node_filter: Literal["ALL", "AN", "DN"]
    vessel: GeoPlannerVessel
    body: GeoPlannerBody
    parking_orbit: GeoPlannerParkingOrbit
    rejection_reasons: list[str]
    warnings: list[str]
    candidates: list[GeoPlannerCandidate]


class SsoDesignPoint(ContractModel):
    altitude_m: float
    semi_major_axis_m: float
    eccentricity: float
    inclination_rad: float
    period_s: float
    nodal_precession_rad_s: float
    nodal_precession_deg_day: float
    target_precession_deg_day: float
    rate_error_deg_day: float


class SsoPlannerBody(ContractModel):
    name: str
    gravitational_parameter_m3_s2: float
    equatorial_radius_m: float
    j2: float
    tropical_year_days: float


class SsoPlannerResponse(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    source: Literal["analytic"] = "analytic"
    model: Literal["J2_SECULAR_FIRST_ORDER"] = "J2_SECULAR_FIRST_ORDER"
    ready: bool
    multibody_required: Literal[True] = True
    multibody_enabled: bool
    solve_for: Literal["INCLINATION", "ALTITUDE"]
    ltan: str
    body: SsoPlannerBody
    selected: SsoDesignPoint
    sweep: list[SsoDesignPoint]
    warnings: list[str]
