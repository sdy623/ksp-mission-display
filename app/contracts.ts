export type QualityState = "pass" | "degraded" | "fail";
export type MissionProfile = "EARTH_ORBIT" | "GEO_SLOT" | "TLI" | "SSO" | "TMI" | "CUSTOM";

export type InferredStage = {
  activation_stage: number;
  decouple_stage: number;
  name: string;
  role: "BOOSTER" | "CORE" | "UPPER" | "KICK";
  engine_group: string;
  engine_titles: string[];
  engine_count: number;
  max_vacuum_thrust_n: number | null;
  vacuum_specific_impulse_s: number | null;
  wet_mass_kg: number | null;
  dry_mass_kg: number | null;
  propellant_mass_kg: number | null;
  estimated_delta_v_m_s: number | null;
  estimated_burn_time_s: number | null;
  planned_ignitions: number;
  cutoff_event: string;
};

export type StageManifest = {
  schema_version: "1.0";
  vessel: { id: string; name: string };
  current_stage: number | null;
  confidence: "estimated" | "low";
  total_estimated_delta_v_m_s: number | null;
  stages: InferredStage[];
  fairings: Array<{
    title: string;
    activation_stage: number;
    decouple_stage: number;
    jettisoned: boolean;
  }>;
  warnings: string[];
};

export type TelemetrySnapshot = {
  schema_version: "1.0";
  mission_id: string;
  mission_profile: MissionProfile;
  source: "simulated" | "krpc" | "replay";
  sample_ut: number;
  sample_seq: number;
  sample_monotonic_ns: number;
  gateway_unix_ns: number;
  met_s: number;
  vessel: {
    id: string;
    name: string;
    situation: string;
  };
  orbit: {
    apoapsis_altitude_m: number | null;
    periapsis_altitude_m: number | null;
    eccentricity: number | null;
    inclination_rad: number | null;
    period_s: number | null;
  };
  flight: {
    altitude_m: number | null;
    surface_speed_m_s: number | null;
    inertial_speed_m_s: number | null;
    vertical_speed_m_s: number | null;
    horizontal_speed_m_s: number | null;
    mach: number | null;
    dynamic_pressure_pa: number | null;
    g_force: number | null;
    pitch_deg: number | null;
    heading_deg: number | null;
    roll_deg: number | null;
    latitude_deg: number | null;
    longitude_deg: number | null;
  };
  staging: {
    current_stage: number | null;
    throttle: number | null;
    thrust_n: number | null;
    available_thrust_n: number | null;
    specific_impulse_s: number | null;
    mass_kg: number | null;
    dry_mass_kg: number | null;
    estimated_propellant_mass_kg: number | null;
    estimated_mass_flow_kg_s: number | null;
    estimated_burn_time_s: number | null;
    active_engine_count: number;
    fueled_engine_count: number;
    fairing_count: number;
    jettisoned_fairing_count: number;
  };
  events: Array<{
    sequence: number;
    type: "ENGINE_IGNITION" | "ENGINE_CUTOFF" | "STAGE_CHANGE" | "FAIRING_JETTISON";
    ut: number;
    met_s: number;
    stage: number | null;
    detail: string;
  }>;
  quality: {
    connection: "connected" | "simulated" | "disconnected";
    orbit: "valid" | "invalid" | "unavailable";
    frames: QualityState;
  };
};

export type GeoPlannerCandidate = {
  id: string;
  sequence: number;
  node: "AN" | "DN";
  burn_ut: number;
  burn_met_s: number | null;
  wait_s: number;
  burn_longitude_deg: number | null;
  burn_latitude_deg: number | null;
  delta_v_m_s: number | null;
  coast_to_apoapsis_s: number | null;
  apoapsis_ut: number | null;
  apoapsis_longitude_deg: number | null;
  apoapsis_latitude_deg: number | null;
  transfer_semi_major_axis_m: number | null;
  transfer_eccentricity: number | null;
  transfer_periapsis_radius_m: number | null;
  transfer_apoapsis_radius_m: number | null;
  longitude_error_deg: number | null;
  longitude_rate_deg_s: number | null;
  window_open_ut: number | null;
  window_close_ut: number | null;
  window_width_s: number | null;
  feasible: boolean;
  rejection_reason?: string | null;
  score: number;
};

export type GeoPlannerResponse = {
  schema_version: "1.0";
  source: "krpc";
  model: "L1_TWO_BODY_IMPULSIVE";
  ready: boolean;
  sample_ut: number | null;
  met_s: number | null;
  target_longitude_deg: number;
  tolerance_deg: number;
  node_filter: "ALL" | "AN" | "DN";
  vessel: { id: string; name: string; situation: string };
  body: {
    name: string;
    gravitational_parameter_m3_s2: number | null;
    equatorial_radius_m: number | null;
    rotational_speed_rad_s: number | null;
    synchronous_radius_m: number | null;
  };
  parking_orbit: {
    semi_major_axis_m: number | null;
    periapsis_altitude_m: number | null;
    apoapsis_altitude_m: number | null;
    eccentricity: number | null;
    inclination_rad: number | null;
    period_s: number | null;
  };
  rejection_reasons: string[];
  warnings: string[];
  candidates: GeoPlannerCandidate[];
};

export type SsoDesignPoint = {
  altitude_m: number;
  semi_major_axis_m: number;
  eccentricity: number;
  inclination_rad: number;
  period_s: number;
  nodal_precession_rad_s: number;
  nodal_precession_deg_day: number;
  target_precession_deg_day: number;
  rate_error_deg_day: number;
};

export type SsoPlannerResponse = {
  schema_version: "1.0";
  source: "analytic";
  model: "J2_SECULAR_FIRST_ORDER";
  ready: boolean;
  multibody_required: true;
  multibody_enabled: boolean;
  solve_for: "INCLINATION" | "ALTITUDE";
  ltan: string;
  body: {
    name: string;
    gravitational_parameter_m3_s2: number;
    equatorial_radius_m: number;
    j2: number;
    tropical_year_days: number;
  };
  selected: SsoDesignPoint;
  sweep: SsoDesignPoint[];
  warnings: string[];
};
