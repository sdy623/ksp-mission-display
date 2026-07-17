"use client";

import { MetricBlock } from "../_components/MetricBlock";
import { MissionNav } from "../_components/MissionNav";
import { useActiveMission } from "../_hooks/useActiveMission";
import { useTelemetry } from "../_hooks/useTelemetry";

function number(value: number | null | undefined, digits = 1, scale = 1) {
  return value == null || !Number.isFinite(value) ? "—" : (value / scale).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatMet(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "T+ --:--:--";
  const sign = seconds < 0 ? "T−" : "T+";
  let remaining = Math.abs(seconds);
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const wholeSeconds = Math.floor(remaining - (minutes * 60));
  return `${sign} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`;
}

const RSS_UT_EPOCH_MS = Date.UTC(1951, 0, 1, 0, 0, 0);

function gameDateTime(utSeconds: number | null | undefined) {
  if (utSeconds == null || !Number.isFinite(utSeconds)) {
    return { display: "---- -- -- --:--:--", iso: undefined };
  }
  const date = new Date(RSS_UT_EPOCH_MS + (utSeconds * 1000));
  if (!Number.isFinite(date.getTime())) {
    return { display: "DATE OUT OF RANGE", iso: undefined };
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return {
    display: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
    iso: date.toISOString(),
  };
}

function flightPhase(situation: string | undefined, altitudeM: number, verticalSpeed: number) {
  const normalized = (situation ?? "").toLowerCase();
  if (normalized.includes("pre_launch")) return { label: "PRE-LAUNCH", index: 0 };
  if (normalized.includes("landed") || normalized.includes("splashed")) return { label: "MISSION COMPLETE", index: 5 };
  if (normalized.includes("orbit")) return { label: "ORBITAL COAST", index: 4 };
  if (normalized.includes("escape")) return { label: "DEPARTURE", index: 5 };
  if (altitudeM >= 100_000) return { label: verticalSpeed < -25 ? "SPACE DESCENT" : "UPPER-STAGE FLIGHT", index: 3 };
  if (altitudeM >= 20_000) return { label: "HIGH-ALTITUDE ASCENT", index: 2 };
  if (altitudeM > 100 || normalized.includes("flying")) return { label: "POWERED ASCENT", index: 1 };
  return { label: "AWAITING TELEMETRY", index: 0 };
}

export function LiveMissionDisplay() {
  const mission = useActiveMission();
  const { snapshot, feedState, updatedAt, streamStats } = useTelemetry(mission?.profile ?? "EARTH_ORBIT", 50);
  const flight = snapshot?.flight;
  const orbit = snapshot?.orbit;
  const staging = snapshot?.staging;
  const altitudeM = flight?.altitude_m ?? 0;
  const verticalSpeed = flight?.vertical_speed_m_s ?? 0;
  const phase = flightPhase(snapshot?.vessel.situation, altitudeM, verticalSpeed);
  const highAltitude = altitudeM >= 100_000;
  const primarySpeed = highAltitude ? flight?.inertial_speed_m_s : flight?.surface_speed_m_s;
  const primarySpeedLabel = highAltitude ? "INERTIAL SPEED" : "SURFACE SPEED";
  const feedLive = feedState === "krpc-ws";
  const gameTime = gameDateTime(snapshot?.sample_ut);
  const poweredStages = mission?.stages.filter((stage) => stage.plannedBurnSeconds > 0) ?? [];
  const firstPoweredStage = poweredStages[0];
  const lastPoweredStage = poweredStages.at(-1);
  const cutoffEvents = snapshot?.events?.filter((event) => event.type === "ENGINE_CUTOFF") ?? [];
  const fairingEvent = snapshot?.events?.findLast((event) => event.type === "FAIRING_JETTISON");
  const phaseSteps = [
    { name: "PRE-LAUNCH", detail: "READY" },
    { name: "LIFTOFF", detail: "ASCENT" },
    { name: "MAX-Q", detail: "PEAK Q" },
    {
      name: firstPoweredStage?.cutoffEvent || "MECO",
      detail: cutoffEvents[0] ? formatMet(cutoffEvents[0].met_s) : firstPoweredStage?.name || "CORE CUTOFF",
    },
    {
      name: mission?.fairing.enabled ? mission.fairing.eventName : "STAGE SEP",
      detail: fairingEvent ? formatMet(fairingEvent.met_s) : mission?.fairing.enabled ? "PLANNED" : "SEPARATION",
    },
    {
      name: lastPoweredStage?.cutoffEvent || "SECO",
      detail: cutoffEvents[1] ? formatMet(cutoffEvents[1].met_s) : lastPoweredStage?.name || "UPPER CUTOFF",
    },
  ];

  return (
    <main className="broadcast-page live-display-page">
      <MissionNav overlay />
      <div className="broadcast-grid" aria-hidden="true" />

      <section className="broadcast-title">
        <p>{mission?.name ?? snapshot?.mission_profile ?? "KRPC FLIGHT"} / PRIMARY DISPLAY</p>
        <h1>{snapshot?.vessel.name ?? "WAITING FOR KRPC"}</h1>
        <span>{snapshot?.vessel.situation.replaceAll("_", " ").toUpperCase() ?? "NO VESSEL DATA"}</span>
      </section>

      <section className="met-display" aria-label="任务经过时间">
        <span>MISSION ELAPSED TIME</span>
        <strong>{formatMet(snapshot?.met_s)}</strong>
        <time dateTime={gameTime.iso}>{gameTime.display}</time>
        <small>UT {snapshot ? snapshot.sample_ut.toFixed(3) : "—"}</small>
      </section>

      <section className="engine-panel display-phase-panel" aria-label="当前发射阶段">
        <div className="engine-heading"><span>FLIGHT PHASE</span><strong>{phase.label}</strong></div>
        <div className="phase-progress"><i style={{ width: `${Math.max(4, (phase.index / 5) * 100)}%` }} /></div>
        <div className="phase-values">
          <span>KSP STAGE <b>{staging?.current_stage ?? "—"}</b></span>
          <span>BURN REMAIN <b>{number(staging?.estimated_burn_time_s, 1)} s</b></span>
          <span>FEED <b className={feedLive ? "phase-feed-live" : "phase-feed-fallback"}>{feedLive ? "LIVE" : "FALLBACK"}</b></span>
        </div>
      </section>

      <section className="broadcast-telemetry" aria-label="核心实时遥测">
        <MetricBlock label={primarySpeedLabel} value={number(primarySpeed, 1)} unit="m/s" detail={highAltitude ? "NON-ROTATING FRAME" : "SURFACE FRAME"} />
        <MetricBlock label="ALTITUDE" value={number(flight?.altitude_m, 3, 1000)} unit="km" detail="MSL" />
        <MetricBlock label="VERTICAL SPEED" value={number(flight?.vertical_speed_m_s, 1)} unit="m/s" detail="SURFACE FRAME" />
        <MetricBlock label="DYNAMIC PRESSURE" value={number(flight?.dynamic_pressure_pa, 2, 1000)} unit="kPa" detail="Q" accent />
        <MetricBlock label="MACH" value={number(flight?.mach, 2)} detail="ATMOSPHERIC" />
        <MetricBlock label="G-FORCE" value={number(flight?.g_force, 2)} unit="g" detail={`AP ${number(orbit?.apoapsis_altitude_m, 1, 1000)} KM`} />
      </section>

      <section className="event-timeline display-phase-timeline" aria-label="飞行阶段时间线">
        <div className="timeline-line" />
        {phaseSteps.map((step, index) => {
          const state = index < phase.index ? "done" : index === phase.index ? "next" : "future";
          const detail = step.name === "MAX-Q"
            ? `PEAK ${number(streamStats.maxDynamicPressurePa, 2, 1000)} kPa`
            : index === phase.index ? "CURRENT" : step.detail;
          return (
            <div className={`timeline-event event-${state}`} key={step.name}>
              <i /><strong>{step.name}</strong><span>{detail}</span>
            </div>
          );
        })}
      </section>

      <footer className="broadcast-footer display-live-footer">
        <span>KRPC <b>{feedLive ? "LIVE" : "SIM FALLBACK"}</b> · {streamStats.rateHz == null ? "—" : `${streamStats.rateHz.toFixed(1)} HZ`}</span>
        <span>LAT / LON <b>{number(flight?.latitude_deg, 3)}° / {number(flight?.longitude_deg, 3)}°</b></span>
        <span>FRAME <b>{snapshot?.quality.frames.toUpperCase() ?? "—"}</b></span>
        <span>DROP <b>{streamStats.dropped}</b></span>
        <span>LAST <b>{updatedAt ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false, fractionalSecondDigits: 3 }) : "—"}</b></span>
      </footer>
    </main>
  );
}
