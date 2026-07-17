import asyncio
import math
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .contracts import (
    GeoPlannerResponse,
    HealthResponse,
    KRPCStatusResponse,
    SsoPlannerResponse,
    TelemetrySnapshot,
)
from .krpc_adapter import KRPCAdapter, KRPCAdapterError, KRPCConfig
from .planner import PlannerError, sun_sync_design_point
from .simulator import demo_snapshot

adapter = KRPCAdapter(KRPCConfig.from_env())


def websocket_sample_hz(raw_value: str | None, default_hz: float, max_hz: float) -> float:
    try:
        requested_hz = float(raw_value if raw_value is not None else default_hz)
    except (TypeError, ValueError):
        requested_hz = default_hz
    if not math.isfinite(requested_hz):
        requested_hz = default_hz
    return min(max(requested_hz, 1.0), max_hz)


@asynccontextmanager
async def lifespan(_: FastAPI):
    connect_task: asyncio.Task[dict[str, object]] | None = None
    if adapter.config.auto_connect:
        # Never hold FastAPI startup hostage to KSP/kRPC. A TCP connection to
        # an unavailable kRPC server can remain pending for many seconds on
        # Windows; the REST API, Swagger UI and offline planners must still be
        # ready immediately.
        connect_task = asyncio.create_task(asyncio.to_thread(adapter.connect))
    try:
        yield
    finally:
        if connect_task is not None and not connect_task.done():
            connect_task.cancel()
        await asyncio.to_thread(adapter.disconnect)

app = FastAPI(
    title="KSP Mission Display API",
    version="0.2.0",
    description="Read-only live kRPC telemetry gateway.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3011",
    ],
    allow_origin_regex=(
        r"^http://(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|"
        r"192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})"
        r"(?::\d+)?$"
    ),
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/")
def api_root() -> dict[str, str]:
    return {
        "service": "KSP Mission Display API",
        "status": "running",
        "health": "/health",
        "docs": "/docs",
    }


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    status = adapter.status()
    state = status["state"]
    return HealthResponse(
        status="ok" if state == "connected" else "degraded",
        krpc_state=state,
        krpc_error=status["last_error"],
    )


@app.get("/v1/telemetry/demo", response_model=TelemetrySnapshot)
def telemetry_demo() -> TelemetrySnapshot:
    return demo_snapshot()


@app.get("/v1/krpc/status", response_model=KRPCStatusResponse)
def krpc_status() -> KRPCStatusResponse:
    return KRPCStatusResponse.model_validate(adapter.status())


@app.post("/v1/krpc/connect", response_model=KRPCStatusResponse)
def krpc_connect(force: bool = False) -> KRPCStatusResponse:
    try:
        status = adapter.connect(force=force)
    except KRPCAdapterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return KRPCStatusResponse.model_validate(status)


@app.post("/v1/krpc/disconnect", response_model=KRPCStatusResponse)
def krpc_disconnect() -> KRPCStatusResponse:
    adapter.disconnect()
    return KRPCStatusResponse.model_validate(adapter.status())


@app.get("/v1/telemetry/live", response_model=TelemetrySnapshot)
def telemetry_live(
    mission_profile: str = Query(default="EARTH_ORBIT"),
) -> TelemetrySnapshot:
    try:
        snapshot = adapter.snapshot(mission_profile=mission_profile)
    except KRPCAdapterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return TelemetrySnapshot.model_validate(snapshot)


@app.get("/v1/vehicle/stages")
def vehicle_stages() -> dict:
    try:
        return adapter.stage_manifest()
    except KRPCAdapterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/v1/planner/geo", response_model=GeoPlannerResponse)
def planner_geo(
    target_longitude_deg: float = Query(default=110.0),
    tolerance_deg: float = Query(default=0.1, gt=0.0, le=10.0),
    node_filter: str = Query(default="ALL"),
    max_nodes: int = Query(default=8, ge=1, le=24),
) -> GeoPlannerResponse:
    if not math.isfinite(target_longitude_deg) or not math.isfinite(tolerance_deg):
        raise HTTPException(status_code=422, detail="Planner inputs must be finite numbers")
    if node_filter not in {"ALL", "AN", "DN"}:
        raise HTTPException(status_code=422, detail="node_filter must be ALL, AN, or DN")
    try:
        result = adapter.geo_plan(
            target_longitude_deg=target_longitude_deg,
            tolerance_deg=tolerance_deg,
            node_filter=node_filter,
            max_nodes=max_nodes,
        )
    except KRPCAdapterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return GeoPlannerResponse.model_validate(result)


@app.get("/v1/planner/sso", response_model=SsoPlannerResponse)
def planner_sso(
    solve_for: str = Query(default="INCLINATION"),
    altitude_km: float = Query(default=600.0, gt=100.0, le=6_000.0),
    inclination_deg: float = Query(default=97.8, gt=90.0, lt=180.0),
    eccentricity: float = Query(default=0.0, ge=0.0, lt=0.9),
    ltan: str = Query(default="10:30"),
    multibody_enabled: bool = Query(default=False),
    mu_km3_s2: float = Query(default=398_600.435_436, gt=0.0),
    equatorial_radius_km: float = Query(default=6_371.0, gt=0.0),
    j2: float = Query(default=1.082_626_68e-3, gt=0.0),
    tropical_year_days: float = Query(default=365.2422, gt=0.0),
) -> SsoPlannerResponse:
    if solve_for not in {"INCLINATION", "ALTITUDE"}:
        raise HTTPException(status_code=422, detail="solve_for must be INCLINATION or ALTITUDE")
    if len(ltan) != 5 or ltan[2] != ":":
        raise HTTPException(status_code=422, detail="ltan must use HH:MM")
    try:
        hours, minutes = (int(part) for part in ltan.split(":"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="ltan must use HH:MM") from exc
    if not 0 <= hours <= 23 or not 0 <= minutes <= 59:
        raise HTTPException(status_code=422, detail="ltan must use a valid 24-hour time")

    mu = mu_km3_s2 * 1.0e9
    radius = equatorial_radius_km * 1.0e3
    try:
        selected = sun_sync_design_point(
            mu_m3_s2=mu,
            equatorial_radius_m=radius,
            j2=j2,
            altitude_m=altitude_km * 1.0e3 if solve_for == "INCLINATION" else None,
            inclination_rad=(
                math.radians(inclination_deg) if solve_for == "ALTITUDE" else None
            ),
            eccentricity=eccentricity,
            tropical_year_days=tropical_year_days,
        )
        sweep = [
            sun_sync_design_point(
                mu_m3_s2=mu,
                equatorial_radius_m=radius,
                j2=j2,
                altitude_m=height_km * 1.0e3,
                eccentricity=eccentricity,
                tropical_year_days=tropical_year_days,
            )
            for height_km in (300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 900.0, 1_000.0)
        ]
    except PlannerError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    warnings = [
        "LTAN fixes the RAAN phase at an epoch; it does not change the J2 altitude/inclination pair.",
        "Validate the design in the active multibody propagator with its complete gravity model.",
    ]
    if not multibody_enabled:
        warnings.insert(0, "Two-body KSP cannot maintain this SSO; multibody/J2 propagation is required.")
    return SsoPlannerResponse.model_validate({
        "ready": multibody_enabled,
        "multibody_enabled": multibody_enabled,
        "solve_for": solve_for,
        "ltan": ltan,
        "body": {
            "name": "RSS EARTH",
            "gravitational_parameter_m3_s2": mu,
            "equatorial_radius_m": radius,
            "j2": j2,
            "tropical_year_days": tropical_year_days,
        },
        "selected": selected,
        "sweep": sweep,
        "warnings": warnings,
    })


@app.websocket("/v1/telemetry/ws")
async def telemetry_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    profile = websocket.query_params.get("mission_profile", "EARTH_ORBIT")
    raw_hz = websocket.query_params.get("hz", str(adapter.config.websocket_default_hz))
    sample_hz = websocket_sample_hz(
        raw_hz,
        adapter.config.websocket_default_hz,
        adapter.config.websocket_max_hz,
    )
    try:
        requested_hz = float(raw_hz)
    except ValueError:
        requested_hz = adapter.config.websocket_default_hz
    if not math.isfinite(requested_hz):
        requested_hz = adapter.config.websocket_default_hz
    period_s = 1.0 / sample_hz
    loop = asyncio.get_running_loop()
    next_deadline = loop.time()
    last_error_sent = 0.0
    receive_task = asyncio.create_task(websocket.receive())

    try:
        while True:
            if receive_task.done():
                message = receive_task.result()
                if message["type"] == "websocket.disconnect":
                    break
                receive_task = asyncio.create_task(websocket.receive())
            try:
                snapshot = await asyncio.to_thread(adapter.snapshot, profile)
                await websocket.send_json(snapshot)
            except KRPCAdapterError as exc:
                # Do not flood the browser at the Fast-channel rate while KSP is offline.
                if loop.time() - last_error_sent >= 0.5:
                    connection_status = await asyncio.to_thread(adapter.status)
                    await websocket.send_json(
                        {
                            "type": "telemetry_error",
                            "detail": str(exc),
                            "connection": connection_status,
                            "requested_hz": requested_hz,
                            "effective_hz": sample_hz,
                        }
                    )
                    last_error_sent = loop.time()

            next_deadline += period_s
            delay = next_deadline - loop.time()
            if delay > 0:
                await asyncio.wait({receive_task}, timeout=delay)
            elif delay < -(period_s * 4.0):
                # Sampling overran badly; reset instead of sending a burst of stale frames.
                next_deadline = loop.time()
    except (WebSocketDisconnect, RuntimeError, OSError):
        return
    finally:
        if not receive_task.done():
            receive_task.cancel()
