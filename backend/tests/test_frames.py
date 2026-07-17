import math
import unittest

from kmd.dynamics.frames import (
    internal_rh_to_ksp_lh,
    ksp_lh_to_internal_rh,
    lon_lat_from_ksp_fixed,
)


class FrameTests(unittest.TestCase):
    def test_axis_mapping_round_trip(self) -> None:
        original = (12.0, -4.5, 9.25)
        self.assertEqual(internal_rh_to_ksp_lh(ksp_lh_to_internal_rh(original)), original)

    def test_cardinal_longitudes(self) -> None:
        cases = {
            (1.0, 0.0, 0.0): 0.0,
            (0.0, 0.0, 1.0): 90.0,
            (-1.0, 0.0, 0.0): 180.0,
            (0.0, 0.0, -1.0): 270.0,
        }
        for vector, expected in cases.items():
            longitude, latitude = lon_lat_from_ksp_fixed(vector)
            self.assertTrue(math.isclose(longitude, expected, abs_tol=1e-12))
            self.assertTrue(math.isclose(latitude, 0.0, abs_tol=1e-12))

    def test_north_pole_is_positive_latitude(self) -> None:
        _, latitude = lon_lat_from_ksp_fixed((0.0, 1.0, 0.0))
        self.assertTrue(math.isclose(latitude, 90.0, abs_tol=1e-12))

if __name__ == "__main__":
    unittest.main()
