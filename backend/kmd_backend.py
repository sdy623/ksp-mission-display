"""Frozen Windows entry point for the KSP Mission Display telemetry backend."""

from __future__ import annotations

from multiprocessing import freeze_support
import os

import uvicorn

from kmd.app import app


def main() -> None:
    host = os.getenv("KMD_BACKEND_HOST", "127.0.0.1")
    port = int(os.getenv("KMD_BACKEND_PORT", "8021"))
    log_level = os.getenv("KMD_BACKEND_LOG_LEVEL", "info")

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=log_level,
        access_log=False,
        loop="asyncio",
        http="h11",
        ws="websockets",
        lifespan="on",
        workers=1,
    )


if __name__ == "__main__":
    freeze_support()
    main()
