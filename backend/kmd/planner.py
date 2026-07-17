from __future__ import annotations

import math
from typing import Iterable

import numpy as np


class PlannerError(RuntimeError):
    """Raised when an advisory trajectory cannot be produced safely."""


SECONDS_PER_DAY = 86_400.0
DEFAULT_TROPICAL_YEAR_DAYS = 365.2422


def wrap_longitude_deg(value: float) -> float:
    return value % 360.0


def wrap_error_deg(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def norm(vector: Iterable[float]) -> float:
    return float(np.linalg.norm(np.asarray(tuple(vector), dtype=float)))


def orbital_shape(mu: float, position: np.ndarray, velocity: np.ndarray) -> dict[str, object]:
    radius = float(np.linalg.norm(position))
    speed_sq = float(np.dot(velocity, velocity))
    radial_dot = float(np.dot(position, velocity))
    if mu <= 0.0 or radius <= 0.0:
        raise PlannerError("Invalid gravitational parameter or orbital radius")

    energy = (speed_sq * 0.5) - (mu / radius)
    if energy >= 0.0:
        raise PlannerError("Post-burn trajectory is not elliptic")
    semi_major_axis = -mu / (2.0 * energy)
    eccentricity_vector = (
        ((speed_sq - (mu / radius)) * position) - (radial_dot * velocity)
    ) / mu
    eccentricity = float(np.linalg.norm(eccentricity_vector))
    if not 0.0 < eccentricity < 1.0:
        raise PlannerError("Post-burn eccentricity is outside the elliptic range")

    return {
        "semi_major_axis_m": semi_major_axis,
        "eccentricity": eccentricity,
        "eccentricity_vector": eccentricity_vector,
        "periapsis_radius_m": semi_major_axis * (1.0 - eccentricity),
        "apoapsis_radius_m": semi_major_axis * (1.0 + eccentricity),
    }


def solve_prograde_to_apoapsis(
    mu: float,
    position: np.ndarray,
    velocity: np.ndarray,
    target_apoapsis_radius_m: float,
    *,
    maximum_delta_v_m_s: float = 8_000.0,
) -> tuple[float, np.ndarray, dict[str, object]]:
    velocity_norm = float(np.linalg.norm(velocity))
    if velocity_norm <= 0.0:
        raise PlannerError("Burn-point velocity is unavailable")
    direction = velocity / velocity_norm

    def evaluate(delta_v: float) -> tuple[float, np.ndarray, dict[str, object]]:
        post_velocity = velocity + (direction * delta_v)
        shape = orbital_shape(mu, position, post_velocity)
        return float(shape["apoapsis_radius_m"]), post_velocity, shape

    initial_apoapsis, initial_velocity, initial_shape = evaluate(0.0)
    if initial_apoapsis >= target_apoapsis_radius_m:
        return 0.0, initial_velocity, initial_shape

    lower = 0.0
    upper = min(250.0, maximum_delta_v_m_s)
    while True:
        try:
            upper_apoapsis, _, _ = evaluate(upper)
        except PlannerError as exc:
            raise PlannerError(
                "Target apoapsis was not reached before the trajectory became non-elliptic"
            ) from exc
        if upper_apoapsis >= target_apoapsis_radius_m:
            break
        lower = upper
        upper += 250.0
        if upper > maximum_delta_v_m_s:
            raise PlannerError("Configured delta-V search bound cannot reach the target apoapsis")
    for _ in range(64):
        middle = (lower + upper) * 0.5
        apoapsis, _, _ = evaluate(middle)
        if apoapsis >= target_apoapsis_radius_m:
            upper = middle
        else:
            lower = middle
    _, post_velocity, shape = evaluate(upper)
    return upper, post_velocity, shape


def time_and_position_at_apoapsis(
    mu: float,
    position: np.ndarray,
    velocity: np.ndarray,
    shape: dict[str, object],
) -> tuple[float, np.ndarray]:
    semi_major_axis = float(shape["semi_major_axis_m"])
    eccentricity = float(shape["eccentricity"])
    eccentricity_vector = np.asarray(shape["eccentricity_vector"], dtype=float)
    radius = float(np.linalg.norm(position))

    cos_true_anomaly = float(np.dot(eccentricity_vector, position)) / (
        eccentricity * radius
    )
    cos_true_anomaly = max(-1.0, min(1.0, cos_true_anomaly))
    true_anomaly = math.acos(cos_true_anomaly)
    if float(np.dot(position, velocity)) < 0.0:
        true_anomaly = (2.0 * math.pi) - true_anomaly

    eccentric_anomaly = 2.0 * math.atan2(
        math.sqrt(1.0 - eccentricity) * math.sin(true_anomaly * 0.5),
        math.sqrt(1.0 + eccentricity) * math.cos(true_anomaly * 0.5),
    )
    mean_anomaly = (eccentric_anomaly - eccentricity * math.sin(eccentric_anomaly)) % (
        2.0 * math.pi
    )
    mean_motion = math.sqrt(mu / (semi_major_axis**3))
    coast_s = ((math.pi - mean_anomaly) % (2.0 * math.pi)) / mean_motion

    apoapsis_radius = float(shape["apoapsis_radius_m"])
    apoapsis_position = -(eccentricity_vector / eccentricity) * apoapsis_radius
    return coast_s, apoapsis_position


def map_inertial_to_future_fixed(
    vector_inertial: np.ndarray,
    reference_inertial: np.ndarray,
    reference_fixed: np.ndarray,
) -> np.ndarray:
    """Apply the kRPC future-frame x/z rotation inferred at the same UT.

    kRPC's body frames use y toward the north pole, x at 0E and z at 90E.
    Both body-centered frames share their origin and north axis, so one future
    position expressed in both frames determines the x/z rotation without a
    real-world GMST or a guessed RSS epoch.
    """
    xi, _, zi = reference_inertial
    xf, _, zf = reference_fixed
    denominator = (xi * xi) + (zi * zi)
    if denominator <= 1.0e-12:
        raise PlannerError("Cannot infer the future body-fixed rotation near the pole")
    cosine = ((xi * xf) + (zi * zf)) / denominator
    sine = ((xi * zf) - (zi * xf)) / denominator
    scale = math.hypot(cosine, sine)
    if scale <= 0.0:
        raise PlannerError("Future reference-frame rotation is singular")
    cosine /= scale
    sine /= scale

    x, y, z = vector_inertial
    return np.array([
        (cosine * x) - (sine * z),
        y,
        (sine * x) + (cosine * z),
    ])


def ksp_fixed_lon_lat(vector_fixed: np.ndarray) -> tuple[float, float]:
    x, y, z = vector_fixed
    longitude = wrap_longitude_deg(math.degrees(math.atan2(z, x)))
    latitude = math.degrees(math.atan2(y, math.hypot(x, z)))
    return longitude, latitude


def solar_mean_motion_rad_s(
    tropical_year_days: float = DEFAULT_TROPICAL_YEAR_DAYS,
) -> float:
    """Return the mean apparent solar motion required by a Sun-synchronous plane."""
    if not math.isfinite(tropical_year_days) or tropical_year_days <= 0.0:
        raise PlannerError("Solar year must be a positive finite duration")
    return (2.0 * math.pi) / (tropical_year_days * SECONDS_PER_DAY)


def j2_nodal_precession_rad_s(
    mu_m3_s2: float,
    equatorial_radius_m: float,
    j2: float,
    semi_major_axis_m: float,
    eccentricity: float,
    inclination_rad: float,
) -> float:
    """First-order, orbit-averaged J2 rate of right ascension of the ascending node."""
    values = (
        mu_m3_s2,
        equatorial_radius_m,
        j2,
        semi_major_axis_m,
        eccentricity,
        inclination_rad,
    )
    if not all(math.isfinite(value) for value in values):
        raise PlannerError("J2 design inputs must be finite")
    if mu_m3_s2 <= 0.0 or equatorial_radius_m <= 0.0 or j2 <= 0.0:
        raise PlannerError("Body mu, equatorial radius, and J2 must be positive")
    if semi_major_axis_m <= equatorial_radius_m:
        raise PlannerError("Semi-major axis must be above the body surface")
    if not 0.0 <= eccentricity < 1.0:
        raise PlannerError("Eccentricity must be in the elliptic range [0, 1)")

    mean_motion = math.sqrt(mu_m3_s2 / (semi_major_axis_m**3))
    semilatus_rectum = semi_major_axis_m * (1.0 - eccentricity**2)
    return (
        -1.5
        * j2
        * mean_motion
        * (equatorial_radius_m / semilatus_rectum) ** 2
        * math.cos(inclination_rad)
    )


def solve_sun_sync_inclination_rad(
    mu_m3_s2: float,
    equatorial_radius_m: float,
    j2: float,
    semi_major_axis_m: float,
    eccentricity: float = 0.0,
    tropical_year_days: float = DEFAULT_TROPICAL_YEAR_DAYS,
) -> float:
    """Solve the retrograde inclination whose first-order J2 rate follows the Sun."""
    target_rate = solar_mean_motion_rad_s(tropical_year_days)
    mean_motion = math.sqrt(mu_m3_s2 / (semi_major_axis_m**3))
    semilatus_rectum = semi_major_axis_m * (1.0 - eccentricity**2)
    denominator = (
        1.5
        * j2
        * mean_motion
        * (equatorial_radius_m / semilatus_rectum) ** 2
    )
    if denominator <= 0.0:
        raise PlannerError("J2 inclination solution is singular")
    cosine = -target_rate / denominator
    if abs(cosine) > 1.0:
        raise PlannerError("No physical Sun-synchronous inclination exists at this altitude")
    return math.acos(cosine)


def solve_sun_sync_semi_major_axis_m(
    mu_m3_s2: float,
    equatorial_radius_m: float,
    j2: float,
    inclination_rad: float,
    eccentricity: float = 0.0,
    tropical_year_days: float = DEFAULT_TROPICAL_YEAR_DAYS,
) -> float:
    """Solve semi-major axis for a requested retrograde Sun-synchronous inclination."""
    if not math.pi * 0.5 < inclination_rad < math.pi:
        raise PlannerError("Sun-synchronous inclination must be retrograde (90 to 180 deg)")
    if not 0.0 <= eccentricity < 1.0:
        raise PlannerError("Eccentricity must be in the elliptic range [0, 1)")
    target_rate = solar_mean_motion_rad_s(tropical_year_days)
    numerator = (
        -1.5
        * j2
        * math.sqrt(mu_m3_s2)
        * (equatorial_radius_m**2)
        * math.cos(inclination_rad)
    )
    denominator = target_rate * ((1.0 - eccentricity**2) ** 2)
    if numerator <= 0.0 or denominator <= 0.0:
        raise PlannerError("J2 altitude solution is singular")
    semi_major_axis_m = (numerator / denominator) ** (2.0 / 7.0)
    if semi_major_axis_m <= equatorial_radius_m:
        raise PlannerError("Requested inclination produces a sub-surface SSO altitude")
    return semi_major_axis_m


def sun_sync_design_point(
    *,
    mu_m3_s2: float,
    equatorial_radius_m: float,
    j2: float,
    altitude_m: float | None = None,
    inclination_rad: float | None = None,
    eccentricity: float = 0.0,
    tropical_year_days: float = DEFAULT_TROPICAL_YEAR_DAYS,
) -> dict[str, float]:
    """Build one SSO design point by solving either inclination or altitude."""
    if (altitude_m is None) == (inclination_rad is None):
        raise PlannerError("Provide exactly one of altitude or inclination")
    if altitude_m is not None:
        if not math.isfinite(altitude_m) or altitude_m <= 0.0:
            raise PlannerError("Altitude must be positive and finite")
        semi_major_axis_m = equatorial_radius_m + altitude_m
        solved_inclination = solve_sun_sync_inclination_rad(
            mu_m3_s2,
            equatorial_radius_m,
            j2,
            semi_major_axis_m,
            eccentricity,
            tropical_year_days,
        )
    else:
        assert inclination_rad is not None
        solved_inclination = inclination_rad
        semi_major_axis_m = solve_sun_sync_semi_major_axis_m(
            mu_m3_s2,
            equatorial_radius_m,
            j2,
            inclination_rad,
            eccentricity,
            tropical_year_days,
        )
        altitude_m = semi_major_axis_m - equatorial_radius_m

    nodal_rate = j2_nodal_precession_rad_s(
        mu_m3_s2,
        equatorial_radius_m,
        j2,
        semi_major_axis_m,
        eccentricity,
        solved_inclination,
    )
    target_rate = solar_mean_motion_rad_s(tropical_year_days)
    period_s = 2.0 * math.pi * math.sqrt((semi_major_axis_m**3) / mu_m3_s2)
    return {
        "altitude_m": float(altitude_m),
        "semi_major_axis_m": semi_major_axis_m,
        "eccentricity": eccentricity,
        "inclination_rad": solved_inclination,
        "period_s": period_s,
        "nodal_precession_rad_s": nodal_rate,
        "nodal_precession_deg_day": math.degrees(nodal_rate) * SECONDS_PER_DAY,
        "target_precession_deg_day": math.degrees(target_rate) * SECONDS_PER_DAY,
        "rate_error_deg_day": math.degrees(nodal_rate - target_rate) * SECONDS_PER_DAY,
    }
