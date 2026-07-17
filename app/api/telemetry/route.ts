const simulatedTelemetry = {
  schema_version: "1.0",
  mission_id: "prototype-multi-profile",
  mission_profile: "TLI",
  source: "simulated",
  sample_ut: 450581502.68,
  sample_seq: 0,
  sample_monotonic_ns: 0,
  gateway_unix_ns: 0,
  met_s: 1357.496,
  vessel: {
    id: "demo-vessel-001",
    name: "Dissolution 2A Comms",
    situation: "orbiting",
  },
  orbit: {
    apoapsis_altitude_m: 220581,
    periapsis_altitude_m: 219725,
    eccentricity: 0.0000648534,
    inclination_rad: 0.342318,
    period_s: 5334.061,
  },
  flight: {
    altitude_m: 84620,
    surface_speed_m_s: 2314.7,
    inertial_speed_m_s: 2661.2,
    vertical_speed_m_s: 182.4,
    horizontal_speed_m_s: 2307.5,
    mach: 7.84,
    dynamic_pressure_pa: 12640,
    g_force: 2.18,
    pitch_deg: 18.6,
    heading_deg: 94.2,
    roll_deg: -0.8,
    latitude_deg: 27.4,
    longitude_deg: 146.8,
  },
  staging: {
    current_stage: 1,
    throttle: 0,
    thrust_n: 0,
    available_thrust_n: 1100000,
    specific_impulse_s: 451,
    mass_kg: 31420,
    dry_mass_kg: 10850,
    estimated_propellant_mass_kg: 20570,
    estimated_mass_flow_kg_s: 248.7,
    estimated_burn_time_s: 82.7,
    active_engine_count: 1,
    fueled_engine_count: 1,
    fairing_count: 1,
    jettisoned_fairing_count: 0,
  },
  events: [],
  quality: {
    connection: "simulated",
    orbit: "valid",
    frames: "pass",
  },
};

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const requestedProfile = requestUrl.searchParams.get("mission_profile") ?? "EARTH_ORBIT";
  const missionProfile = ["EARTH_ORBIT", "GEO_SLOT", "TLI", "SSO", "TMI", "CUSTOM"].includes(requestedProfile)
    ? requestedProfile
    : "CUSTOM";
  const backendUrl = process.env.KMD_BACKEND_URL ?? "http://127.0.0.1:8021";

  try {
    const response = await fetch(
      `${backendUrl}/v1/telemetry/live?mission_profile=${encodeURIComponent(missionProfile)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(1_200),
      },
    );
    if (response.ok) {
      return Response.json(await response.json(), {
        headers: {
          "Cache-Control": "no-store",
          "X-KMD-Telemetry-Source": "krpc",
        },
      });
    }
  } catch {
    // The page remains usable when KSP or the local gateway is offline.
  }

  return Response.json(
    {
      ...simulatedTelemetry,
      mission_profile: missionProfile,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-KMD-Telemetry-Source": "simulated-fallback",
      },
    },
  );
}
