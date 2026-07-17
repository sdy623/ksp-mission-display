import time

from .contracts import FlightState, OrbitState, QualityState, StagingState, TelemetrySnapshot, VesselState


def demo_snapshot() -> TelemetrySnapshot:
    return TelemetrySnapshot(
        mission_id="prototype-multi-profile",
        mission_profile="TLI",
        source="simulated",
        sample_ut=450_581_502.680,
        sample_seq=0,
        sample_monotonic_ns=time.perf_counter_ns(),
        gateway_unix_ns=time.time_ns(),
        met_s=1_357.496,
        vessel=VesselState(
            id="demo-vessel-001",
            name="Dissolution 2A Comms",
            situation="orbiting",
        ),
        orbit=OrbitState(
            apoapsis_altitude_m=220_581.0,
            periapsis_altitude_m=219_725.0,
            eccentricity=0.0000648534,
            inclination_rad=0.342318,
            period_s=5_334.061,
        ),
        flight=FlightState(
            altitude_m=84_620.0,
            surface_speed_m_s=2_314.7,
            inertial_speed_m_s=2_661.2,
            vertical_speed_m_s=182.4,
            horizontal_speed_m_s=2_307.5,
            mach=7.84,
            dynamic_pressure_pa=12_640.0,
            g_force=2.18,
            pitch_deg=18.6,
            heading_deg=94.2,
            roll_deg=-0.8,
            latitude_deg=27.4,
            longitude_deg=146.8,
        ),
        staging=StagingState(
            current_stage=1,
            throttle=0.0,
            thrust_n=0.0,
            available_thrust_n=1_100_000.0,
            specific_impulse_s=451.0,
            mass_kg=31_420.0,
            dry_mass_kg=10_850.0,
            estimated_propellant_mass_kg=20_570.0,
            estimated_mass_flow_kg_s=248.7,
            estimated_burn_time_s=82.7,
            active_engine_count=1,
            fueled_engine_count=1,
            fairing_count=1,
            jettisoned_fairing_count=0,
        ),
        events=[],
        quality=QualityState(
            connection="simulated",
            orbit="valid",
            frames="pass",
        ),
    )
