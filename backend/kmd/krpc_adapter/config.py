from __future__ import annotations

from dataclasses import dataclass
import os


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class KRPCConfig:
    address: str = "127.0.0.1"
    rpc_port: int = 50_000
    stream_port: int = 50_001
    client_name: str = "KSP Mission Display"
    vessel_name: str | None = None
    vessel_id: str | None = None
    mission_id: str = "live-ksp-session"
    mission_profile: str = "EARTH_ORBIT"
    auto_connect: bool = False
    reconnect_interval_s: float = 2.0
    slow_sample_interval_s: float = 0.5
    websocket_default_hz: float = 25.0
    websocket_max_hz: float = 50.0

    @classmethod
    def from_env(cls) -> "KRPCConfig":
        return cls(
            address=os.getenv("KMD_KRPC_ADDRESS", "127.0.0.1"),
            rpc_port=int(os.getenv("KMD_KRPC_RPC_PORT", "50000")),
            stream_port=int(os.getenv("KMD_KRPC_STREAM_PORT", "50001")),
            client_name=os.getenv("KMD_KRPC_CLIENT_NAME", "KSP Mission Display"),
            vessel_name=os.getenv("KMD_KRPC_VESSEL_NAME") or None,
            vessel_id=os.getenv("KMD_KRPC_VESSEL_ID") or None,
            mission_id=os.getenv("KMD_MISSION_ID", "live-ksp-session"),
            mission_profile=os.getenv("KMD_MISSION_PROFILE", "EARTH_ORBIT").upper(),
            auto_connect=_env_bool("KMD_KRPC_AUTO_CONNECT", False),
            reconnect_interval_s=float(os.getenv("KMD_KRPC_RECONNECT_INTERVAL_S", "2.0")),
            slow_sample_interval_s=float(os.getenv("KMD_KRPC_SLOW_SAMPLE_INTERVAL_S", "0.5")),
            websocket_default_hz=float(os.getenv("KMD_WS_DEFAULT_HZ", "25.0")),
            websocket_max_hz=float(os.getenv("KMD_WS_MAX_HZ", "50.0")),
        )
