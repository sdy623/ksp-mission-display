import math
import unittest

import numpy as np

from kmd.planner import (
    j2_nodal_precession_rad_s,
    ksp_fixed_lon_lat,
    map_inertial_to_future_fixed,
    solve_prograde_to_apoapsis,
    sun_sync_design_point,
    time_and_position_at_apoapsis,
    wrap_error_deg,
)


class GeoPlannerMathTests(unittest.TestCase):
    def test_solves_leo_prograde_injection_to_geo_radius(self) -> None:
        mu = 3.98600435436e14
        parking_radius = 6_571_000.0
        geo_radius = 42_164_172.0
        position = np.array([parking_radius, 0.0, 0.0])
        velocity = np.array([0.0, 0.0, math.sqrt(mu / parking_radius)])

        delta_v, post_velocity, shape = solve_prograde_to_apoapsis(
            mu,
            position,
            velocity,
            geo_radius,
        )
        coast_s, apoapsis_position = time_and_position_at_apoapsis(
            mu,
            position,
            post_velocity,
            shape,
        )

        self.assertAlmostEqual(float(shape["apoapsis_radius_m"]), geo_radius, delta=0.1)
        self.assertGreater(delta_v, 2_000.0)
        self.assertLess(delta_v, 3_000.0)
        self.assertGreater(coast_s, 18_000.0)
        self.assertLess(coast_s, 20_000.0)
        self.assertAlmostEqual(apoapsis_position[0], -geo_radius, delta=1.0)

    def test_infers_ksp_y_north_future_frame_rotation(self) -> None:
        mapped = map_inertial_to_future_fixed(
            np.array([0.0, 0.0, 2.0]),
            np.array([1.0, 0.0, 0.0]),
            np.array([0.0, 0.0, 1.0]),
        )
        longitude, latitude = ksp_fixed_lon_lat(mapped)

        self.assertTrue(np.allclose(mapped, [-2.0, 0.0, 0.0]))
        self.assertAlmostEqual(longitude, 180.0)
        self.assertAlmostEqual(latitude, 0.0)

    def test_longitude_error_wraps_across_zero(self) -> None:
        self.assertAlmostEqual(wrap_error_deg(359.5), -0.5)
        self.assertAlmostEqual(wrap_error_deg(-359.5), 0.5)

    def test_solves_sun_synchronous_inclination_at_600_km(self) -> None:
        point = sun_sync_design_point(
            mu_m3_s2=398_600.435_436e9,
            equatorial_radius_m=6_371_000.0,
            j2=1.082_626_68e-3,
            altitude_m=600_000.0,
        )

        inclination_deg = math.degrees(point["inclination_rad"])
        self.assertGreater(inclination_deg, 97.0)
        self.assertLess(inclination_deg, 99.0)
        self.assertAlmostEqual(point["nodal_precession_deg_day"], 0.985647, places=5)
        self.assertAlmostEqual(point["rate_error_deg_day"], 0.0, places=10)

    def test_sun_synchronous_altitude_inverse_closes(self) -> None:
        initial = sun_sync_design_point(
            mu_m3_s2=398_600.435_436e9,
            equatorial_radius_m=6_371_000.0,
            j2=1.082_626_68e-3,
            altitude_m=800_000.0,
            eccentricity=0.001,
        )
        inverse = sun_sync_design_point(
            mu_m3_s2=398_600.435_436e9,
            equatorial_radius_m=6_371_000.0,
            j2=1.082_626_68e-3,
            inclination_rad=initial["inclination_rad"],
            eccentricity=0.001,
        )

        self.assertAlmostEqual(inverse["altitude_m"], 800_000.0, delta=0.001)
        rate = j2_nodal_precession_rad_s(
            398_600.435_436e9,
            6_371_000.0,
            1.082_626_68e-3,
            inverse["semi_major_axis_m"],
            inverse["eccentricity"],
            inverse["inclination_rad"],
        )
        self.assertAlmostEqual(rate, inverse["nodal_precession_rad_s"], places=16)


if __name__ == "__main__":
    unittest.main()
