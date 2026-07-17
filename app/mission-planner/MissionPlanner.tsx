"use client";

import { useEffect, useMemo, useState } from "react";
import { toast, Toaster } from "sonner";
import { StatusBadge } from "../_components/StatusBadge";
import type { GeoPlannerResponse, SsoPlannerResponse } from "../contracts";
import { useTelemetry } from "../_hooks/useTelemetry";

export type MissionProfile = "GEO_SLOT" | "TLI" | "SSO";

type TliCandidate = {
  id: string;
  index: number;
  burnIn: string;
  burnUt: string;
  phaseError: number;
  c3: number;
  deltaV: number;
  coast: string;
  perilune: number;
  declination: number;
  ignition: string;
};

const tliCandidates: TliCandidate[] = [
  { id: "tli-00", index: 0, burnIn: "00:18:12", burnUt: "450582595.041", phaseError: 1.34, c3: -1.823, deltaV: 3118, coast: "3d 10:34", perilune: 121, declination: 18.7, ignition: "2 / 4" },
  { id: "tli-01", index: 1, burnIn: "01:47:06", burnUt: "450587928.934", phaseError: 0.18, c3: -1.818, deltaV: 3114, coast: "3d 08:42", perilune: 100, declination: 20.1, ignition: "2 / 4" },
  { id: "tli-02", index: 2, burnIn: "03:15:59", burnUt: "450593261.820", phaseError: -0.46, c3: -1.806, deltaV: 3109, coast: "3d 06:51", perilune: 84, declination: 21.4, ignition: "2 / 4" },
  { id: "tli-03", index: 3, burnIn: "04:44:53", burnUt: "450598595.707", phaseError: -1.22, c3: -1.796, deltaV: 3105, coast: "3d 05:04", perilune: 62, declination: 22.8, ignition: "2 / 4" },
];

const profileOptions = [
  { id: "GEO_SLOT", label: "GEO SLOT", detail: "地固经度 / 同步轨道", available: true },
  { id: "TLI", label: "TLI", detail: "月球相位 / 近月点", available: true },
  { id: "SSO", label: "SSO", detail: "J2 进动 / LTAN", available: true },
  { id: "CUSTOM", label: "CUSTOM", detail: "自定义目标函数", available: false },
] as const;

const SSO_REQUEST_TIMEOUT_MS = 5_000;
const SSO_NOTICE_DURATION_MS = 4_500;

function ProfileSelector({ profile, onChange }: { profile: MissionProfile; onChange: (profile: MissionProfile) => void }) {
  return (
    <section className="profile-selector console-panel" aria-label="任务类型">
      <div className="profile-selector-heading"><span>MISSION PROFILE</span><strong>选择任务目标，不改变底层遥测与参考系契约</strong></div>
      <div className="profile-options">
        {profileOptions.map((option) => (
          <button
            aria-pressed={option.available ? profile === option.id : undefined}
            className={`${option.available && profile === option.id ? "active" : ""} ${!option.available ? "planned" : ""}`}
            disabled={!option.available}
            key={option.id}
            onClick={() => option.available && onChange(option.id)}
            type="button"
          >
            <span>{option.label}</span>
            <small>{option.detail}</small>
            {!option.available ? <em>PLANNED</em> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "−" : "";
  let remaining = Math.abs(seconds);
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const secs = remaining - (minutes * 60);
  const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
  return `${sign}${days ? `${days}d ` : ""}${clock}`;
}

function plannerNumber(value: number | null | undefined, digits = 3, scale = 1) {
  return value == null || !Number.isFinite(value) ? "—" : (value / scale).toFixed(digits);
}

const rejectionLabels: Record<string, string> = {
  NO_ACTIVE_ORBIT: "没有可用的当前轨道",
  BODY_MU_UNAVAILABLE: "天体引力参数不可用",
  BODY_RADIUS_UNAVAILABLE: "天体半径不可用",
  ORBIT_ELEMENTS_UNAVAILABLE: "轨道要素不完整",
  PARKING_ORBIT_NOT_STABLE: "尚未进入稳定停车轨道",
  EQUATORIAL_NODE_UNDEFINED: "赤道轨道的 AN/DN 定义退化",
  ARGUMENT_OF_PERIAPSIS_UNAVAILABLE: "近地点幅角不可用",
  REFERENCE_FRAMES_UNAVAILABLE: "KSP 参考系不可用",
  BODY_ROTATION_UNAVAILABLE: "天体自转数据不可用",
  KRPC_ORBIT_PREDICTION_UNAVAILABLE: "kRPC 未来轨道接口不可用",
};

function GeoProfile() {
  const [target, setTarget] = useState(110);
  const [tolerance, setTolerance] = useState(0.1);
  const [nodeFilter, setNodeFilter] = useState<"ALL" | "AN" | "DN">("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [plan, setPlan] = useState<GeoPlannerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [solverError, setSolverError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setSolverError(null);
      const query = new URLSearchParams({
        target_longitude_deg: String(target),
        tolerance_deg: String(tolerance),
        node_filter: nodeFilter,
        max_nodes: "8",
      });
      try {
        const response = await fetch(`/api/planner/geo?${query.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail ?? `Planner HTTP ${response.status}`);
        setPlan(body as GeoPlannerResponse);
      } catch (error) {
        if (!controller.signal.aborted) {
          setPlan(null);
          setSolverError(error instanceof Error ? error.message : "Planner unavailable");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [nodeFilter, target, tolerance]);

  const ranked = plan?.candidates ?? [];
  const selected = ranked.find((candidate) => candidate.id === selectedId) ?? ranked[0];
  const validSelected = selected?.longitude_error_deg != null;
  const inTolerance = Boolean(selected?.feasible);
  const targetMarker = ((target % 360) + 360) % 360;
  const openDelta = selected?.window_open_ut == null ? null : selected.window_open_ut - selected.burn_ut;
  const closeDelta = selected?.window_close_ut == null ? null : selected.window_close_ut - selected.burn_ut;
  const holdReasons = plan?.rejection_reasons.map((reason) => rejectionLabels[reason] ?? reason) ?? [];

  return (
    <>
      <section className="planner-controls console-panel" aria-label="GEO 规划条件">
        <label>
          <span>TARGET LONGITUDE</span>
          <div className="input-with-unit">
            <input aria-label="目标东经" max="360" min="-360" onChange={(event) => setTarget(Number(event.target.value) || 0)} step="0.001" type="number" value={target} />
            <b>°E</b>
          </div>
        </label>
        <label>
          <span>LONGITUDE TOLERANCE</span>
          <select aria-label="经度容差" onChange={(event) => setTolerance(Number(event.target.value))} value={tolerance}>
            <option value="0.05">±0.05° / 5.6 km</option>
            <option value="0.1">±0.10° / 11.1 km</option>
            <option value="0.25">±0.25° / 27.8 km</option>
            <option value="1">±1.00° / 111 km</option>
          </select>
        </label>
        <fieldset>
          <legend>NODE FILTER</legend>
          <div className="segmented-control">
            {(["ALL", "AN", "DN"] as const).map((node) => (
              <button className={nodeFilter === node ? "active" : ""} key={node} onClick={() => setNodeFilter(node)} type="button">{node}</button>
            ))}
          </div>
        </fieldset>
        <div className={`solver-health ${plan?.ready ? "solver-live" : "solver-hold"}`}>
          <span>SOLVER HEALTH</span>
          <strong><i /> {loading ? "SOLVING" : plan?.ready ? "LIVE INPUT" : "HOLD"}</strong>
          <small>GEO L1 · {ranked.length} CANDIDATES</small>
        </div>
      </section>

      <section className="planner-live-input console-panel" aria-label="kRPC 实际规划输入">
        <div><span>DATA SOURCE</span><strong>{plan ? "KRPC LIVE" : "NO DATA"}</strong></div>
        <div><span>VESSEL</span><strong>{plan?.vessel.name ?? "—"}</strong></div>
        <div><span>STATE UT</span><strong>{plannerNumber(plan?.sample_ut, 3)}</strong></div>
        <div><span>PARKING ORBIT</span><strong>{plannerNumber(plan?.parking_orbit.periapsis_altitude_m, 1, 1000)} × {plannerNumber(plan?.parking_orbit.apoapsis_altitude_m, 1, 1000)} km</strong></div>
        <div><span>INCLINATION</span><strong>{plannerNumber(plan?.parking_orbit.inclination_rad == null ? null : plan.parking_orbit.inclination_rad * 180 / Math.PI, 4)}°</strong></div>
        <div><span>SYNC ALTITUDE</span><strong>{plannerNumber(plan?.body.synchronous_radius_m == null || plan.body.equatorial_radius_m == null ? null : plan.body.synchronous_radius_m - plan.body.equatorial_radius_m, 1, 1000)} km</strong></div>
      </section>

      {(solverError || holdReasons.length > 0) ? (
        <section className="planner-gate console-panel" role="status">
          <strong>{solverError ? "PLANNER BACKEND OFFLINE" : "TRAJECTORY SOLVER HOLD"}</strong>
          <span>{solverError ?? holdReasons.join(" · ")}</span>
        </section>
      ) : null}

      <section className="geo-map-panel console-panel">
        <header>
          <div><span>KSP BODY-FIXED LONGITUDE</span><strong>APOGEE SUB-SATELLITE POINT</strong></div>
          <div className="map-legend"><span><i className="target-legend" /> TARGET</span><span><i className="candidate-legend" /> LIVE CANDIDATE</span></div>
        </header>
        <div className="longitude-map" aria-label="0 到 360 度东经示意">
          <div className="latitude-line latitude-north"><span>+30°</span></div>
          <div className="latitude-line latitude-equator"><span>EQ</span></div>
          <div className="latitude-line latitude-south"><span>−30°</span></div>
          {[0, 60, 120, 180, 240, 300, 360].map((longitude) => (
            <div className="longitude-line" key={longitude} style={{ left: `${(longitude / 360) * 100}%` }}><span>{longitude}°E</span></div>
          ))}
          <div className="target-marker" style={{ left: `${(targetMarker / 360) * 100}%` }}><span>{targetMarker.toFixed(3)}°E</span></div>
          {ranked.filter((candidate) => candidate.apoapsis_longitude_deg != null).map((candidate) => (
            <button
              aria-label={`${candidate.node} 候选，远地点东经 ${candidate.apoapsis_longitude_deg}`}
              className={`candidate-marker ${selected?.id === candidate.id ? "selected" : ""}`}
              key={candidate.id}
              onClick={() => setSelectedId(candidate.id)}
              style={{ left: `${((candidate.apoapsis_longitude_deg ?? 0) / 360) * 100}%` }}
              type="button"
            ><i /><span>{candidate.node}-{candidate.sequence}</span></button>
          ))}
        </div>
      </section>

      <section className="planner-results">
        <article className="console-panel candidate-list-panel">
          <div className="panel-title"><span>01</span><div><p>GEO SLOT PROFILE / KRPC STATE</p><h2>NODE CANDIDATES</h2></div></div>
          <div className="candidate-table" role="table" aria-label="节点候选">
            <div className="candidate-table-head" role="row"><span>RANK</span><span>NODE</span><span>BURN IN</span><span>AP LON</span><span>ERROR</span><span>ΔV</span></div>
            {ranked.map((candidate, rank) => (
              <button className={selected?.id === candidate.id ? "selected" : ""} key={candidate.id} onClick={() => setSelectedId(candidate.id)} role="row" type="button">
                <span>{rank.toString().padStart(2, "0")}</span><b>{candidate.node}</b><span>{formatDuration(candidate.wait_s)}</span><span>{plannerNumber(candidate.apoapsis_longitude_deg, 3)}°</span>
                <em className={candidate.feasible ? "error-good" : "error-miss"}>{candidate.longitude_error_deg == null ? "REJECT" : `${candidate.longitude_error_deg >= 0 ? "+" : ""}${candidate.longitude_error_deg.toFixed(3)}°`}</em>
                <span>{plannerNumber(candidate.delta_v_m_s, 0)} m/s</span>
              </button>
            ))}
            {!loading && ranked.length === 0 ? <div className="candidate-empty">NO LIVE CANDIDATES · LOAD A STABLE PARKING ORBIT</div> : null}
          </div>
        </article>

        {selected ? (
          <article className="console-panel selected-solution">
            <div className="panel-title"><span>02</span><div><p>SELECTED LIVE SOLUTION</p><h2>{selected.node}-{selected.sequence.toString().padStart(2, "0")} / GTO INJECTION</h2></div></div>
            <div className="solution-hero">
              <span>LONGITUDE ERROR</span>
              <strong className={inTolerance ? "error-good" : "error-miss"}>{validSelected ? `${(selected.longitude_error_deg ?? 0) >= 0 ? "+" : ""}${selected.longitude_error_deg?.toFixed(4)}°` : "REJECTED"}</strong>
              <small>{inTolerance ? "WITHIN SELECTED TOLERANCE" : selected.rejection_reason ?? "EXACT NODE MISSES SELECTED TOLERANCE"}</small>
            </div>
            <div className="solution-grid">
              <div><span>UT BURN</span><strong>{selected.burn_ut.toFixed(3)}</strong></div>
              <div><span>MET BURN</span><strong>{formatDuration(selected.burn_met_s)}</strong></div>
              <div><span>BURN → APOGEE</span><strong>{formatDuration(selected.coast_to_apoapsis_s)}</strong></div>
              <div><span>APOGEE LAT</span><strong>{plannerNumber(selected.apoapsis_latitude_deg, 4)}°</strong></div>
              <div><span>EST. ΔV</span><strong>{plannerNumber(selected.delta_v_m_s, 1)} m/s</strong></div>
              <div><span>MODEL</span><strong>L1 IMPULSIVE</strong></div>
            </div>
            <div className={`window-result ${inTolerance ? "window-open" : "window-miss"}`}>
              <div><span>ALLOWABLE WINDOW</span><strong>{inTolerance ? `${plannerNumber(openDelta, 2)} s / +${plannerNumber(closeDelta, 2)} s` : "NO VALID NODE WINDOW"}</strong></div>
              <StatusBadge tone={inTolerance ? "success" : "danger"}>{inTolerance ? "OPEN" : "MISS"}</StatusBadge>
            </div>
          </article>
        ) : (
          <article className="console-panel selected-solution selected-solution-empty">
            <div className="panel-title"><span>02</span><div><p>SELECTED LIVE SOLUTION</p><h2>WAITING FOR VALID ORBIT</h2></div></div>
          </article>
        )}
      </section>
    </>
  );
}

function TliProfile() {
  const [phaseTolerance, setPhaseTolerance] = useState(0.25);
  const [targetPerilune, setTargetPerilune] = useState(100);
  const [selectedId, setSelectedId] = useState("tli-01");

  const ranked = useMemo(() => {
    return tliCandidates
      .map((candidate) => ({
        ...candidate,
        periluneError: candidate.perilune - targetPerilune,
        score: Math.abs(candidate.phaseError) + Math.abs(candidate.perilune - targetPerilune) / 100,
      }))
      .sort((a, b) => a.score - b.score);
  }, [targetPerilune]);

  const selected = ranked.find((candidate) => candidate.id === selectedId) ?? ranked[0];
  const inTolerance = Math.abs(selected.phaseError) <= phaseTolerance && Math.abs(selected.periluneError) <= 25;

  return (
    <>
      <section className="planner-controls tli-controls console-panel" aria-label="TLI 规划条件">
        <label>
          <span>TARGET PERILUNE</span>
          <div className="input-with-unit">
            <input aria-label="目标近月点高度" min="20" onChange={(event) => setTargetPerilune(Number(event.target.value) || 100)} step="1" type="number" value={targetPerilune} />
            <b>km</b>
          </div>
        </label>
        <label>
          <span>LUNAR PHASE TOLERANCE</span>
          <select aria-label="月球相位容差" onChange={(event) => setPhaseTolerance(Number(event.target.value))} value={phaseTolerance}>
            <option value="0.1">±0.10°</option>
            <option value="0.25">±0.25°</option>
            <option value="0.5">±0.50°</option>
            <option value="1">±1.00°</option>
          </select>
        </label>
        <div className="profile-constraint"><span>DEPARTURE MODEL</span><strong>LEO → TLI</strong><small>IMPULSIVE / EARTH-CENTERED</small></div>
        <div className="solver-health"><span>SOLVER HEALTH</span><strong><i /> READY</strong><small>TLI L1 · 4 OPPORTUNITIES</small></div>
      </section>

      <section className="tli-trajectory-panel console-panel" aria-label="地月转移轨迹示意">
        <header><div><span>EARTH–MOON GEOMETRY</span><strong>TRANS-LUNAR INJECTION CORRIDOR</strong></div><div className="tli-epoch">EPOCH <b>UT 450581502.680</b></div></header>
        <div className="tli-space">
          <div className="tli-grid" />
          <div className="tli-earth"><i /><span>EARTH</span></div>
          <div className="parking-orbit" />
          <div className="transfer-arc"><i /></div>
          <div className="tli-moon"><i /><span>MOON</span></div>
          <div className="departure-vector"><span>TLI</span></div>
          <div className="arrival-corridor"><span>PERILUNE<br />{targetPerilune} km</span></div>
          <div className="phase-annotation"><span>LUNAR PHASE ERROR</span><strong>{selected.phaseError >= 0 ? "+" : ""}{selected.phaseError.toFixed(2)}°</strong></div>
        </div>
      </section>

      <section className="planner-results">
        <article className="console-panel candidate-list-panel">
          <div className="panel-title"><span>01</span><div><p>TLI PROFILE / RANKED BY PHASE + PERILUNE</p><h2>DEPARTURE OPPORTUNITIES</h2></div></div>
          <div className="candidate-table tli-candidate-table" role="table" aria-label="TLI 候选窗口">
            <div className="candidate-table-head" role="row"><span>RANK</span><span>OPP</span><span>BURN IN</span><span>PHASE ERR</span><span>C3</span><span>ΔV</span></div>
            {ranked.map((candidate, rank) => (
              <button className={selected.id === candidate.id ? "selected" : ""} key={candidate.id} onClick={() => setSelectedId(candidate.id)} role="row" type="button">
                <span>0{rank}</span><b>TLI-{candidate.index}</b><span>{candidate.burnIn}</span>
                <em className={Math.abs(candidate.phaseError) <= phaseTolerance ? "error-good" : "error-miss"}>{candidate.phaseError >= 0 ? "+" : ""}{candidate.phaseError.toFixed(2)}°</em>
                <span>{candidate.c3.toFixed(3)}</span><span>{candidate.deltaV} m/s</span>
              </button>
            ))}
          </div>
        </article>

        <article className="console-panel selected-solution">
          <div className="panel-title"><span>02</span><div><p>SELECTED SOLUTION</p><h2>TLI-{selected.index.toString().padStart(2, "0")} / LUNAR DEPARTURE</h2></div></div>
          <div className="solution-hero">
            <span>LUNAR PHASE ERROR</span>
            <strong className={inTolerance ? "error-good" : "error-miss"}>{selected.phaseError >= 0 ? "+" : ""}{selected.phaseError.toFixed(3)}°</strong>
            <small>{inTolerance ? "PHASE + PERILUNE CONSTRAINTS PASS" : "CONSTRAINT REVIEW REQUIRED"}</small>
          </div>
          <div className="solution-grid">
            <div><span>UT BURN</span><strong>{selected.burnUt}</strong></div>
            <div><span>NOW → BURN</span><strong>{selected.burnIn}</strong></div>
            <div><span>TIME OF FLIGHT</span><strong>{selected.coast}</strong></div>
            <div><span>PERILUNE ALT</span><strong>{selected.perilune} km</strong></div>
            <div><span>EST. ΔV</span><strong>{selected.deltaV} m/s</strong></div>
            <div><span>C3 / DECL.</span><strong>{selected.c3.toFixed(3)} / {selected.declination.toFixed(1)}°</strong></div>
          </div>
          <div className={`window-result ${inTolerance ? "window-open" : "window-miss"}`}>
            <div><span>DEPARTURE OPPORTUNITY</span><strong>{inTolerance ? "GO FOR TLI" : "HOLD / RETARGET"}</strong></div>
            <StatusBadge tone={inTolerance ? "success" : "danger"}>{inTolerance ? "OPEN" : "MISS"}</StatusBadge>
          </div>
        </article>
      </section>
    </>
  );
}

function SsoProfile() {
  const [solveFor, setSolveFor] = useState<"INCLINATION" | "ALTITUDE">("INCLINATION");
  const [altitudeKm, setAltitudeKm] = useState(600);
  const [inclinationDeg, setInclinationDeg] = useState(97.8);
  const [eccentricity, setEccentricity] = useState(0);
  const [ltan, setLtan] = useState("10:30");
  const [multibodyEnabled, setMultibodyEnabled] = useState(false);
  const [plan, setPlan] = useState<SsoPlannerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [solverError, setSolverError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let requestTimedOut = false;
    let requestTimeout: number | undefined;
    const debounceTimer = window.setTimeout(async () => {
      setLoading(true);
      setSolverError(null);
      const query = new URLSearchParams({
        solve_for: solveFor,
        altitude_km: String(altitudeKm),
        inclination_deg: String(inclinationDeg),
        eccentricity: String(eccentricity),
        ltan,
        multibody_enabled: String(multibodyEnabled),
      });
      try {
        requestTimeout = window.setTimeout(() => {
          requestTimedOut = true;
          controller.abort();
        }, SSO_REQUEST_TIMEOUT_MS);
        const response = await fetch(`/api/planner/sso?${query.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (response.status === 504) requestTimedOut = true;
        if (!response.ok) throw new Error(body.detail ?? `Planner HTTP ${response.status}`);
        setPlan(body as SsoPlannerResponse);
        toast.dismiss("sso-solver-status");
      } catch (error) {
        if (!disposed) {
          const message = requestTimedOut
            ? "SSO 计算超过 5 秒，已停止本次请求。请检查 Python 后端或 kRPC 连接后重试。"
            : error instanceof Error ? error.message : "SSO planner unavailable";
          setPlan(null);
          setSolverError(message);
          toast.error(requestTimedOut ? "SSO SOLVER TIMEOUT" : "SSO SOLVER ERROR", {
            description: message,
            duration: SSO_NOTICE_DURATION_MS,
            id: "sso-solver-status",
          });
        }
      } finally {
        if (requestTimeout != null) window.clearTimeout(requestTimeout);
        if (!disposed) setLoading(false);
      }
    }, 180);
    return () => {
      disposed = true;
      window.clearTimeout(debounceTimer);
      if (requestTimeout != null) window.clearTimeout(requestTimeout);
      controller.abort();
    };
  }, [altitudeKm, eccentricity, inclinationDeg, ltan, multibodyEnabled, solveFor]);

  const solution = plan?.selected;
  const inclination = solution == null ? null : solution.inclination_rad * 180 / Math.PI;
  const rateMatch = solution == null ? false : Math.abs(solution.rate_error_deg_day) < 1e-6;
  const ready = Boolean(plan?.ready && rateMatch);

  return (
    <>
      <section className="planner-controls sso-controls console-panel" aria-label="太阳同步轨道规划条件">
        <fieldset>
          <legend>SOLVE FOR</legend>
          <div className="segmented-control segmented-control-two">
            <button className={solveFor === "INCLINATION" ? "active" : ""} onClick={() => setSolveFor("INCLINATION")} type="button">INCLINATION</button>
            <button className={solveFor === "ALTITUDE" ? "active" : ""} onClick={() => setSolveFor("ALTITUDE")} type="button">ALTITUDE</button>
          </div>
        </fieldset>
        <label>
          <span>{solveFor === "INCLINATION" ? "TARGET MEAN ALTITUDE" : "TARGET INCLINATION"}</span>
          <div className="input-with-unit">
            <input
              aria-label={solveFor === "INCLINATION" ? "目标平均高度" : "目标倾角"}
              max={solveFor === "INCLINATION" ? 6000 : 179.9}
              min={solveFor === "INCLINATION" ? 101 : 90.1}
              onChange={(event) => solveFor === "INCLINATION" ? setAltitudeKm(Number(event.target.value) || 600) : setInclinationDeg(Number(event.target.value) || 97.8)}
              step={solveFor === "INCLINATION" ? 1 : 0.01}
              type="number"
              value={solveFor === "INCLINATION" ? altitudeKm : inclinationDeg}
            />
            <b>{solveFor === "INCLINATION" ? "km" : "deg"}</b>
          </div>
        </label>
        <label>
          <span>ECCENTRICITY</span>
          <input aria-label="目标偏心率" max="0.2" min="0" onChange={(event) => setEccentricity(Number(event.target.value) || 0)} step="0.0001" type="number" value={eccentricity} />
        </label>
        <label>
          <span>LOCAL TIME OF ASCENDING NODE</span>
          <select aria-label="升交点地方时" onChange={(event) => setLtan(event.target.value)} value={ltan}>
            <option value="06:00">06:00 / DAWN</option>
            <option value="10:30">10:30 / MORNING</option>
            <option value="13:30">13:30 / AFTERNOON</option>
            <option value="18:00">18:00 / DUSK</option>
          </select>
        </label>
        <div className={`profile-constraint sso-model-toggle ${multibodyEnabled ? "confirmed" : ""}`}>
          <span>PROPAGATION MODEL</span>
          <button aria-pressed={multibodyEnabled} onClick={() => setMultibodyEnabled((enabled) => !enabled)} type="button">
            <i /> {multibodyEnabled ? "MULTIBODY + J2" : "TWO-BODY / HOLD"}
          </button>
        </div>
        <div className={`solver-health ${ready ? "solver-live" : "solver-hold"}`}>
          <span>SOLVER HEALTH</span>
          <strong><i /> {loading ? "SOLVING" : ready ? "J2 MATCH" : "HOLD"}</strong>
          <small>SSO L1 · SECULAR J2</small>
        </div>
      </section>

      <section className="planner-live-input sso-body-input console-panel" aria-label="SSO 天体模型输入">
        <div><span>BODY MODEL</span><strong>{plan?.body.name ?? "RSS EARTH"}</strong></div>
        <div><span>μ</span><strong>{plannerNumber(plan?.body.gravitational_parameter_m3_s2, 3, 1e9)} km³/s²</strong></div>
        <div><span>EQUATORIAL RADIUS</span><strong>{plannerNumber(plan?.body.equatorial_radius_m, 3, 1000)} km</strong></div>
        <div><span>J2</span><strong>{plannerNumber(plan?.body.j2, 10)}</strong></div>
        <div><span>SOLAR YEAR</span><strong>{plannerNumber(plan?.body.tropical_year_days, 4)} d</strong></div>
        <div><span>LTAN TARGET</span><strong>{ltan}</strong></div>
      </section>

      {(!multibodyEnabled || solverError) ? (
        <section className="planner-gate console-panel" role="status">
          <strong>{solverError ? "SSO SOLVER OFFLINE" : "MULTIBODY MODEL REQUIRED"}</strong>
          <span>{solverError ?? "普通两体 KSP 不产生 J2 轨道面进动。仅在 Principia / 多体摄动模型已启用并确认其 Earth J2 参数时放行。"}</span>
        </section>
      ) : null}

      <section className="sso-geometry-panel console-panel" aria-label="太阳同步轨道面进动关系">
        <header>
          <div><span>ORBIT PLANE PRECESSION</span><strong>J2 RATE ↔ MEAN SUN MOTION</strong></div>
          <div className="tli-epoch">LTAN <b>{ltan}</b></div>
        </header>
        <div className="sso-geometry">
          <div className="sso-sun"><i /><span>MEAN SUN</span></div>
          <div className="sso-earth"><i /></div>
          <div className="sso-orbit-plane" style={{ transform: `translate(-50%, -50%) rotate(${inclination == null ? -8 : inclination - 98}deg)` }}><i /></div>
          <div className="sso-precession-arrow"><span>Ω̇ +EAST</span></div>
          <div className="sso-rate-readout">
            <span>REQUIRED / COMPUTED</span>
            <strong>{plannerNumber(solution?.target_precession_deg_day, 6)} / {plannerNumber(solution?.nodal_precession_deg_day, 6)}</strong>
            <small>deg / mean solar day</small>
          </div>
        </div>
      </section>

      <section className="planner-results">
        <article className="console-panel candidate-list-panel">
          <div className="panel-title"><span>01</span><div><p>SSO DESIGN FAMILY / FIRST-ORDER J2</p><h2>ALTITUDE–INCLINATION PAIRS</h2></div></div>
          <div className="candidate-table sso-candidate-table" role="table" aria-label="SSO 高度倾角组合">
            <div className="candidate-table-head" role="row"><span>ALT</span><span>INC</span><span>PERIOD</span><span>Ω̇ J2</span><span>Ω̇ SUN</span><span>ERROR</span></div>
            {plan?.sweep.map((point) => (
              <button key={point.altitude_m} onClick={() => { setSolveFor("INCLINATION"); setAltitudeKm(Math.round(point.altitude_m / 1000)); }} role="row" type="button">
                <b>{(point.altitude_m / 1000).toFixed(0)} km</b>
                <span>{(point.inclination_rad * 180 / Math.PI).toFixed(4)}°</span>
                <span>{formatDuration(point.period_s)}</span>
                <span>{point.nodal_precession_deg_day.toFixed(6)}</span>
                <span>{point.target_precession_deg_day.toFixed(6)}</span>
                <em className="error-good">{point.rate_error_deg_day.toExponential(1)}</em>
              </button>
            ))}
          </div>
        </article>

        <article className="console-panel selected-solution">
          <div className="panel-title"><span>02</span><div><p>SELECTED J2 EQUILIBRIUM</p><h2>SUN-SYNCHRONOUS DESIGN</h2></div></div>
          <div className="solution-hero">
            <span>{solveFor === "INCLINATION" ? "REQUIRED INCLINATION" : "REQUIRED MEAN ALTITUDE"}</span>
            <strong className={rateMatch ? "error-good" : "error-miss"}>{solveFor === "INCLINATION" ? `${plannerNumber(inclination, 5)}°` : `${plannerNumber(solution?.altitude_m, 2, 1000)} km`}</strong>
            <small>RETROGRADE · LTAN {ltan} PLANE PHASE</small>
          </div>
          <div className="solution-grid">
            <div><span>MEAN ALTITUDE</span><strong>{plannerNumber(solution?.altitude_m, 3, 1000)} km</strong></div>
            <div><span>INCLINATION</span><strong>{plannerNumber(inclination, 5)}°</strong></div>
            <div><span>ORBIT PERIOD</span><strong>{formatDuration(solution?.period_s)}</strong></div>
            <div><span>ECCENTRICITY</span><strong>{plannerNumber(solution?.eccentricity, 6)}</strong></div>
            <div><span>NODAL RATE</span><strong>{plannerNumber(solution?.nodal_precession_deg_day, 6)}°/d</strong></div>
            <div><span>MODEL</span><strong>J2 SECULAR L1</strong></div>
          </div>
          <div className={`window-result ${ready ? "window-open" : "window-miss"}`}>
            <div><span>PLANE PRECESSION MATCH</span><strong>{ready ? "GO FOR SSO DESIGN" : "HOLD / MODEL UNCONFIRMED"}</strong></div>
            <StatusBadge tone={ready ? "success" : "warning"}>{ready ? "MATCH" : "HOLD"}</StatusBadge>
          </div>
        </article>
      </section>
    </>
  );
}

export function MissionPlanner({ initialProfile = "GEO_SLOT" }: { initialProfile?: MissionProfile }) {
  const [profile, setProfile] = useState<MissionProfile>(initialProfile);
  const tli = profile === "TLI";
  const sso = profile === "SSO";
  const { snapshot, feedState } = useTelemetry(tli ? "TLI" : sso ? "SSO" : "GEO_SLOT", 5);
  const live = feedState === "krpc-ws" && snapshot?.source === "krpc";
  const framesPass = snapshot?.quality.frames === "pass";

  return (
    <>
      <Toaster
        className="kmd-sonner"
        closeButton
        duration={SSO_NOTICE_DURATION_MS}
        expand
        icons={{ error: <span aria-hidden="true" className="kmd-toast-code">ERR</span> }}
        mobileOffset={{ top: 72, right: 16, left: 16 }}
        offset={{ top: 82, right: 24 }}
        position="top-right"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast: "kmd-toast",
            error: "kmd-toast-error",
            content: "kmd-toast-content",
            icon: "kmd-toast-icon",
            title: "kmd-toast-title",
            description: "kmd-toast-description",
            closeButton: "kmd-toast-close",
          },
        }}
        visibleToasts={3}
      />
      <header className="planner-header">
        <div>
          <p className="kicker">PROFILE-DRIVEN TRAJECTORY / WINDOW SOLVER</p>
          <h1>{tli ? "TRANS-LUNAR INJECTION" : sso ? "SUN-SYNCHRONOUS ORBIT" : "GEO SLOT INSERTION"}</h1>
          <p>{tli ? "停车轨道到月球转移注入 · 相位、能量与近月点约束" : sso ? "J2 轨道面进动匹配太阳平均视运动 · 高度、倾角与 LTAN 约束" : "停车轨道到地球同步槽位 · 节点、远地点经度与允许窗口"}</p>
        </div>
        <div className="console-statuses">
          <StatusBadge tone={framesPass ? "success" : "warning"}>{framesPass ? "FRAME PASS" : "FRAME HOLD"}</StatusBadge>
          <StatusBadge tone={live ? "success" : "warning"}>{live ? "KRPC LIVE" : "NO LIVE ORBIT"}</StatusBadge>
          <StatusBadge tone="warning">READ-ONLY</StatusBadge>
        </div>
      </header>

      <ProfileSelector onChange={setProfile} profile={profile} />
      {tli ? <TliProfile /> : sso ? <SsoProfile /> : <GeoProfile />}

      <footer className="planner-disclaimer">
        <strong>{tli ? "TLI SIMULATED" : sso ? "SSO L1 · J2 REQUIRED" : "GEO L1 · KRPC INPUT"}</strong>
        <span>{tli ? "月球星历 Provider 尚未接入，当前 TLI 候选仍为界面示例。" : sso ? "一阶平均 J2 设计值只定义长期轨道面进动；LTAN 对应的初始 RAAN 仍需太阳星历与任务 epoch。请在实际多体传播器中复核。" : "实际停车轨道与 KSP 固定参考系 · 瞬时顺行脉冲。有限燃烧与平面变化验证前不得作为自动点火指令。"}</span>
      </footer>
    </>
  );
}
