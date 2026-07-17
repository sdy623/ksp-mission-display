# KMD backend

This directory contains the read-only kRPC telemetry gateway and flight-dynamics core.

Implemented Phase 1 connection scope:

- Versioned telemetry contracts.
- Thread-safe kRPC connection and explicit reconnect state.
- Exact vessel binding by id/name with active-vessel fallback.
- Live launch, attitude, orbit and body-fixed position snapshots.
- kRPC `add_stream` Fast channel for launch attitude, velocity, dynamic pressure and body-fixed position.
- REST snapshot endpoint and 25 Hz default WebSocket feed, with the launch FDO requesting the 50 Hz maximum.
- Nanosecond gateway timestamps, monotonic sample sequence and browser-side dropped-frame measurement.
- Simulated telemetry endpoint for offline UI development.
- Explicit KSP left-handed to internal right-handed coordinate conversion.
- Frame and fake-kRPC adapter unit tests.

The backend is intentionally read-only. It does not control throttle, staging, attitude, or maneuver execution.

## Start

1. Start KSP and enable the kRPC server on RPC port `50000` and stream port `50001`.
2. From the project root run:

```powershell
.\backend\run_backend.ps1
```

The API listens on `http://127.0.0.1:8021` by default.

Useful endpoints:

- `GET /health`
- `GET /v1/krpc/status`
- `POST /v1/krpc/connect`
- `GET /v1/telemetry/live?mission_profile=EARTH_ORBIT`
- `WS /v1/telemetry/ws?mission_profile=EARTH_ORBIT&hz=25`

## Binding a vessel

The adapter uses the active vessel unless one of these environment variables is set:

```powershell
$env:KMD_KRPC_VESSEL_NAME = "Exact vessel name"
# or
$env:KMD_KRPC_VESSEL_ID = "vessel-id"
```

Connection settings:

```powershell
$env:KMD_KRPC_ADDRESS = "127.0.0.1"
$env:KMD_KRPC_RPC_PORT = "50000"
$env:KMD_KRPC_STREAM_PORT = "50001"
$env:KMD_MISSION_PROFILE = "EARTH_ORBIT"
$env:KMD_WS_DEFAULT_HZ = "25"
$env:KMD_WS_MAX_HZ = "50"
$env:KMD_KRPC_SLOW_SAMPLE_INTERVAL_S = "0.5"
```
