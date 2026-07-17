# KSP Mission Display

kRPC-driven launch telemetry, flight-dynamics console, and profile-driven mission window planner for KSP RSS/RO.

Open-source under the [MIT License](LICENSE).

## Repository publication model

Private development history stays on the local `main` branch. GitHub receives
only the squashed `public-main` snapshot, published as the remote `main` branch.
The tracked pre-push hook blocks every other local branch and ref mapping.

```powershell
git config core.hooksPath .githooks
git push origin public-main:main
```

See [`.githooks/README.md`](.githooks/README.md) for the local safety policy.

## Prototype routes

- `/` — mission overview
- `/broadcast` — OBS-oriented launch overlay
- `/fdo` — launch and orbital flight dynamics console with attitude director and ground track
- `/mission-planner` — live kRPC GEO L1 planner, J2 SSO designer, and simulated TLI profile
- `/geo-window` — compatibility entry that opens the GEO Slot profile
- `/api/telemetry` — versioned simulated telemetry response

## Current status

Prototype 0.2 can read live kRPC telemetry through the local Python gateway. It remains read-only and does not control KSP.

Implemented:

- Offline Barlow and IBM Plex typography.
- Responsive mission-control visual system.
- Five compiled application routes plus the telemetry endpoint.
- Mission Profile selector with live GEO Slot, J2 SSO, and simulated TLI views.
- Live kRPC parking-orbit input, body constants, AN/DN opportunities, impulsive GTO Δv, future apogee sub-satellite longitude and tolerance windows.
- Interactive GEO longitude, tolerance, and AN/DN filtering; invalid or missing parking orbits are explicitly held instead of replaced with sample candidates.
- Simulated TLI phase, C3, perilune and departure candidates.
- Sun-synchronous design in both directions: altitude → required retrograde inclination, or inclination → required altitude, with J2 nodal-rate closure and an altitude family table.
- Explicit SSO safety gate: two-body mode is held because it cannot preserve J2-driven Sun synchronization; the result is released only after multibody/J2 propagation is confirmed.
- Launch FDO data: attitude, velocity, dynamic pressure, Mach, attitude director and sub-satellite track.
- Live-first telemetry API with explicit simulated fallback and TypeScript contracts.
- Python FastAPI backend with read-only kRPC Stream sampling, vessel binding, REST and high-rate WebSocket telemetry.
- Launch FDO uses a 50 Hz WebSocket Fast channel and exposes measured rate, gateway latency, sequence and dropped frames.
- Mission creation surface with editable/reorderable stage and event definitions.
- Read-only kRPC craft inference for engine groups, activation/decouple stages, fairings, estimated burn time and ideal delta-V.
- Explicit KSP left-handed to internal right-handed coordinate conversion tests.

Not implemented yet:

- Validated finite-burn post-injection propagation and Earth–Moon ephemeris propagation.
- Finite-burn solver.
- Automatic control or maneuver execution.

## Run the web prototype

```powershell
npm install
npm run dev -- --port 3011
```

Open `http://localhost:3011/`.

## Run the live kRPC backend

Start KSP, enable its kRPC server, then run:

```powershell
.\backend\run_backend.ps1
```

The FDO page connects directly to `ws://127.0.0.1:8021/v1/telemetry/ws` at 50 Hz. When the backend or KSP is offline, it explicitly falls back to the REST simulation feed and is marked `SIM FALLBACK`.

The GEO planner reads the active vessel through `GET /v1/planner/geo`. Only the mission target (longitude, tolerance and AN/DN filter) is entered manually; the current UT/MET, orbit, body constants and reference frames come from kRPC. Its result is marked `L1_TWO_BODY_IMPULSIVE` and is advisory only.

The SSO designer uses `GET /v1/planner/sso`. Its Python backend applies the first-order, orbit-averaged J2 nodal precession model and matches it to one tropical-year mean solar motion. LTAN selects the desired plane phase but does not change the altitude/inclination pair; an epoch-aware solar ephemeris is still required to turn LTAN into an initial RAAN. The screen therefore remains `HOLD` until the operator confirms a multibody/J2 propagator.

## Build

The complete Windows build entry checks Node.js and Python, installs missing
dependencies, freezes the Python kRPC gateway, runs the full quality gate,
builds the standalone web runtime, and creates both Electron distributions:

```powershell
.\build.ps1
# equivalent: npm run build:all
```

Useful options:

```powershell
.\build.ps1 -SkipDependencyInstall  # use the existing local dependencies
.\build.ps1 -SkipTests              # package without rerunning the test matrix
.\build.ps1 -SkipPackaging          # verify and build web/backend only
.\build.ps1 -RefreshDependencies    # reinstall dependencies from declared ranges
```

If GNU Make is installed, the root `Makefile` provides short aliases:

```powershell
make help
make test
make release
make release-fast
```

Python selection is deterministic: `.venv\Scripts\python.exe` in the project
root is always preferred and must be Python 3.11. Only when that file does not
exist does the build fall back to `KMD_PYTHON`, the known Miniconda environment,
or `python.exe` on `PATH`. A local venv without pip is repaired with
`ensurepip`; runtime and PyInstaller packages remain in the ignored project
dependency layers under `backend/`, and user/global site-packages are disabled.

For only the standalone web application:

```powershell
npm run build
```

## Electron desktop application

Run the desktop shell in development mode:

```powershell
npm run electron:dev
```

Build only the Windows x64 installer, portable executable, and unpacked
application (the complete release path above is preferred for a clean release):

```powershell
npm run electron:dist
```

Artifacts are written to `release/`:

- `KSP Mission Display Setup 0.1.5.exe` — assisted Windows installer.
- `KSP Mission Display 0.1.5.exe` — portable executable.
- `win-unpacked/` — unpacked application for local validation.

The packaged desktop app opens the FDO console by default. It starts both its bundled standalone web server and its frozen `kmd-backend.exe` telemetry gateway, or reuses an existing backend on port `8021`. The installed and portable applications do not require a system Python installation. `KMD_PYTHON` is only used by the development shell when it needs to start the source backend.

### Optional LAN display sharing

The desktop application remains loopback-only by default. To make the display
available to trusted devices on the same private network, press `Alt` to reveal
the Electron menu, then enable **Server -> Expose display to local network**.
The application restarts and the same menu can show or copy addresses such as
`http://192.168.1.20:3011`.

LAN mode binds the display server and read-only telemetry gateway to all local
interfaces. It does not expose the kRPC game ports. There is currently no HTTP
authentication, so use this mode only on a trusted LAN and allow the Windows
Firewall prompt only for Private networks. Disable the menu option to return to
loopback-only mode.

Command-line and managed-launch equivalents:

```powershell
& ".\KSP Mission Display.exe" --lan
$env:KMD_EXPOSE_LAN = "1"  # locks the native menu setting for this process
npm run electron:dev:lan   # development mode
```

This prototype is not code-signed, so Windows SmartScreen may display an unknown-publisher warning. Runtime logs are stored in the Electron application log directory as `kmd-web.log` and `kmd-backend.log`.

## Automated tests

Run the complete reproducible matrix (Python unit tests, production build,
standalone server tests, fake-backend integration, and real Chrome button/layout
tests):

```powershell
npm run test:all
```

Individual layers:

```powershell
npm run test:python
npm run test:node
npm run test:e2e
```

The browser tests start a deterministic fake kRPC service on `127.0.0.1:18021`
and the packaged web application on `127.0.0.1:13013`. They cover mission and
stage editor buttons, fairing controls, craft auto-detection, GEO/SSO/TLI and AN/DN
controls, WebSocket telemetry, fallback/error states, Max-Q, the 100 km speed
frame change, long multilingual labels, mobile width, missing values, extreme
finite values, and malformed messages.

## Run the fake backend manually

The fake backend implements the same telemetry REST/WebSocket, stage-manifest,
and GEO/SSO planner endpoints used by the real frontend:

```powershell
npm run fake-backend
# or choose a scenario/port directly
.\scripts\run-fake-backend.ps1 -Port 8021 -Scenario long_labels
```

Available scenarios include `nominal_ascent`, `high_altitude`, `long_labels`,
`null_values`, `numeric_extremes`, `malformed`, `sequence_gap`, `planner_hold`,
`stage_error`, and `disconnected`.

For frontend development against it, start the fake backend first and then run:

```powershell
npm run dev:lan
```

See `DESIGN.md` for product scope, frame contracts, model levels, and phased development.
