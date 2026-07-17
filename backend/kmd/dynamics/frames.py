from __future__ import annotations

from dataclasses import dataclass
from math import atan2, degrees, hypot
from typing import Literal

Vector3 = tuple[float, float, float]


def ksp_lh_to_internal_rh(vector: Vector3) -> Vector3:
    """Convert KSP body axes (x=0E, y=north, z=90E) to conventional RH axes."""
    x_ksp, y_ksp, z_ksp = vector
    return x_ksp, z_ksp, y_ksp


def internal_rh_to_ksp_lh(vector: Vector3) -> Vector3:
    """Convert conventional RH axes back to KSP's left-handed body axes."""
    x_rh, y_rh, z_rh = vector
    return x_rh, z_rh, y_rh


def lon_lat_from_ksp_fixed(vector: Vector3) -> tuple[float, float]:
    """Return east-positive longitude [0, 360) and geocentric latitude in degrees."""
    x_ksp, y_ksp, z_ksp = vector
    longitude = degrees(atan2(z_ksp, x_ksp)) % 360.0
    latitude = degrees(atan2(y_ksp, hypot(x_ksp, z_ksp)))
    return longitude, latitude


@dataclass(frozen=True, slots=True)
class FrameStampedState:
    epoch_ut: float
    frame_id: str
    origin_body_id: str
    handedness: Literal["left", "right"]
    r_m: Vector3
    v_m_s: Vector3

    def to_internal_rh(self) -> "FrameStampedState":
        if self.handedness == "right":
            return self
        return FrameStampedState(
            epoch_ut=self.epoch_ut,
            frame_id=f"{self.frame_id}:internal-rh",
            origin_body_id=self.origin_body_id,
            handedness="right",
            r_m=ksp_lh_to_internal_rh(self.r_m),
            v_m_s=ksp_lh_to_internal_rh(self.v_m_s),
        )
