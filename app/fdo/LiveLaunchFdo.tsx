"use client";

import { useMemo } from "react";
import { MetricBlock } from "../_components/MetricBlock";
import { StatusBadge } from "../_components/StatusBadge";
import { useTelemetry } from "../_hooks/useTelemetry";

function number(value: number | null | undefined, digits = 1, scale = 1) {
  return value == null || !Number.isFinite(value) ? "—" : (value / scale).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatMet(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--:--";
  let remaining = Math.abs(seconds);
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const wholeSeconds = Math.floor(remaining - (minutes * 60));
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`;
}

const logRows = [
  ["LIVE", "KRPC", "Fast-channel telemetry active", "ok"],
  ["LIVE", "FRAME", "Body-fixed position available", "ok"],
  ["LIVE", "GUID", "Mission profile loaded", "info"],
];

export function LiveLaunchFdo() {
  const { snapshot, feedState, updatedAt, streamStats } = useTelemetry("EARTH_ORBIT", 50);

  const flight = snapshot?.flight;
  const vessel = snapshot?.vessel;
  const roll = Number.isFinite(flight?.roll_deg) ? flight?.roll_deg ?? 0 : 0;
  const pitch = Number.isFinite(flight?.pitch_deg) ? flight?.pitch_deg ?? 0 : 0;
  const latitude = Number.isFinite(flight?.latitude_deg) ? flight?.latitude_deg ?? 0 : 0;
  const longitude = Number.isFinite(flight?.longitude_deg) ? flight?.longitude_deg ?? 0 : 0;
  const highAltitude = (flight?.altitude_m ?? 0) >= 100_000;
  const primarySpeed = highAltitude ? flight?.inertial_speed_m_s : flight?.surface_speed_m_s;
  const primarySpeedLabel = highAltitude ? "INERTIAL SPEED" : "SURFACE SPEED";
  const inclinationDeg = snapshot?.orbit.inclination_rad == null
    ? null
    : snapshot.orbit.inclination_rad * (180 / Math.PI);
  const markerPosition = useMemo(() => ({
    left: `${Math.min(96, Math.max(4, ((longitude + 180) % 360) / 3.6))}%`,
    top: `${Math.min(88, Math.max(8, ((90 - latitude) / 180) * 100))}%`,
  }), [latitude, longitude]);

  const launchRows = [
    ["PITCH", `${number(flight?.pitch_deg, 2)}°`, signed(flight?.pitch_deg == null ? null : -0.12)],
    ["HEADING", `${number(flight?.heading_deg, 2)}°`, "+0.03"],
    ["ROLL", `${number(flight?.roll_deg, 2)}°`, "+0.06"],
    ["ANGLE OF ATTACK", "—", "PENDING"],
    ["VERTICAL SPEED", `${number(flight?.vertical_speed_m_s, 1)} m/s`, "LIVE"],
    ["HORIZONTAL SPEED", `${number(flight?.horizontal_speed_m_s, 1)} m/s`, "LIVE"],
  ];
  const orbitRows = [
    ["APOGEE ALT", `${number(snapshot?.orbit.apoapsis_altitude_m, 3, 1000)} km`, "LIVE"],
    ["PERIGEE ALT", `${number(snapshot?.orbit.periapsis_altitude_m, 3, 1000)} km`, "LIVE"],
    ["ECCENTRICITY", number(snapshot?.orbit.eccentricity, 8), "LIVE"],
    ["INCLINATION", `${number(inclinationDeg, 6)}°`, "LIVE"],
    ["PERIOD", `${number(snapshot?.orbit.period_s, 3)} s`, "LIVE"],
    ["ORBIT QUALITY", snapshot?.quality.orbit.toUpperCase() ?? "—", snapshot?.quality.frames.toUpperCase() ?? "—"],
  ];

  return (
    <>
      <header className="console-header">
        <div><p className="kicker">FLIGHT DYNAMICS OFFICER / LAUNCH + TRAJECTORY</p><h1>ASCENT OPERATIONS</h1></div>
        <div className="fdo-header-right">
          <div className="fdo-header-met"><span>MET</span><strong>{formatMet(snapshot?.met_s)}</strong></div>
          <div className="console-statuses">
            <StatusBadge tone={snapshot?.quality.frames === "pass" ? "success" : "warning"}>FRAME {snapshot?.quality.frames.toUpperCase() ?? "—"}</StatusBadge>
            <StatusBadge tone={feedState === "krpc-ws" ? "info" : "warning"}>{feedState === "krpc-ws" ? "LIVE KRPC" : "FALLBACK"}</StatusBadge>
          </div>
        </div>
      </header>

      <section className="live-feed-strip console-panel" aria-live="polite">
        <div>
          <span>TELEMETRY SOURCE</span>
          <StatusBadge tone={feedState === "krpc-ws" ? "success" : feedState === "error" ? "danger" : "warning"}>
            {feedState === "krpc-ws" ? "LIVE KRPC · WS" : feedState === "simulated-fallback" ? "SIM FALLBACK" : feedState.toUpperCase()}
          </StatusBadge>
        </div>
        <div><span>VESSEL</span><strong>{vessel?.name ?? "WAITING FOR FEED"}</strong></div>
        <div><span>UT / MET</span><strong>{snapshot ? `${snapshot.sample_ut.toFixed(3)} / ${snapshot.met_s.toFixed(3)}` : "—"}</strong></div>
        <div><span>WS RATE / LATENCY</span><strong>{streamStats.rateHz == null ? "—" : `${streamStats.rateHz.toFixed(1)} Hz`} / {streamStats.latencyMs == null ? "—" : `${streamStats.latencyMs.toFixed(1)} ms`}</strong></div>
        <div><span>SEQ / DROPPED</span><strong>{snapshot?.sample_seq ?? "—"} / {streamStats.dropped}</strong></div>
        <div><span>LAST SAMPLE</span><strong>{updatedAt ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false, fractionalSecondDigits: 3 }) : "—"}</strong></div>
      </section>

      <section className="fdo-metrics">
        <MetricBlock label="ALTITUDE" value={number(flight?.altitude_m, 3, 1000)} unit="km" />
        <MetricBlock label={primarySpeedLabel} value={number(primarySpeed, 1)} unit="m/s" />
        <MetricBlock label="DYNAMIC PRESSURE" value={number(flight?.dynamic_pressure_pa, 2, 1000)} unit="kPa" accent />
        <MetricBlock label="MACH" value={number(flight?.mach, 2)} detail={feedState === "krpc-ws" ? "50 HZ LAUNCH FAST CHANNEL" : "SIMULATED SAMPLE"} />
      </section>

      <section className="launch-fdo-grid">
        <article className="console-panel attitude-panel">
          <div className="panel-title"><span>01</span><div><p>BODY ATTITUDE / SURFACE FRAME</p><h2>ATTITUDE DIRECTOR</h2></div></div>
          <div className="attitude-instrument" aria-label={`姿态球：俯仰 ${pitch.toFixed(1)} 度，航向 ${number(flight?.heading_deg, 1)} 度，滚转 ${roll.toFixed(1)} 度`}>
            <div className="attitude-ring attitude-ring-outer" />
            <div className="attitude-ball">
              <div className="attitude-horizon" style={{ transform: `translateY(${pitch * 0.7}px) rotate(${-roll}deg)` }}><i /></div>
              <div className="pitch-mark pitch-mark-up">+30</div>
              <div className="pitch-mark pitch-mark-mid">10</div>
              <div className="pitch-mark pitch-mark-down">−10</div>
              <div className="aircraft-symbol"><i /><b /></div>
            </div>
            <div className="heading-tape"><span>090</span><strong>{number(flight?.heading_deg, 1)}</strong><span>100</span></div>
          </div>
          <div className="attitude-readouts"><span>PITCH <b>{number(flight?.pitch_deg, 2)}°</b></span><span>HDG <b>{number(flight?.heading_deg, 2)}°</b></span><span>ROLL <b>{number(flight?.roll_deg, 2)}°</b></span></div>
        </article>

        <article className="console-panel launch-data-panel">
          <div className="panel-title"><span>02</span><div><p>GUIDANCE / AERODYNAMICS</p><h2>LAUNCH VECTOR</h2></div></div>
          <div className="data-table launch-data-table">
            {launchRows.map(([label, value, trend]) => (
              <div className="data-row" key={label}><span>{label}</span><strong>{value}</strong><em>{trend}</em></div>
            ))}
          </div>
          <div className="aero-strip">
            <div><span>DYNAMIC PRESSURE</span><strong>{number(flight?.dynamic_pressure_pa, 2, 1000)} kPa</strong></div>
            <div><span>ACCELERATION</span><strong>{number(flight?.g_force, 2)} g</strong></div>
            <div><span>INERTIAL SPEED</span><strong>{number(flight?.inertial_speed_m_s, 1)} m/s</strong></div>
          </div>
        </article>

        <article className="console-panel groundtrack-panel">
          <div className="panel-title"><span>03</span><div><p>BODY-FIXED POSITION</p><h2>SUB-SATELLITE TRACK</h2></div></div>
          <div className="groundtrack-map" aria-label="星下点地面航迹示意">
            <div className="groundtrack-grid" />
            <div className="map-coast coast-a" /><div className="map-coast coast-b" /><div className="map-coast coast-c" />
            <svg aria-hidden="true" className="groundtrack-bezier" preserveAspectRatio="none" viewBox="0 0 600 267">
              <path className="groundtrack-bezier-glow" d="M 60 148 C 178 159, 345 132, 558 65" pathLength="100" />
              <path className="groundtrack-bezier-line" d="M 60 148 C 178 159, 345 132, 558 65" pathLength="100" />
            </svg>
            <div className="launch-site"><i /><span>LAUNCH</span></div>
            <div className="vehicle-groundpoint" style={markerPosition}><i /><span>{number(latitude, 2)}° / {number(longitude, 2)}°</span></div>
            <div className="groundtrack-label label-equator">EQ</div>
            <div className="groundtrack-label label-date">180°</div>
          </div>
          <div className="groundtrack-footer"><span>LONGITUDE <b>{number(longitude, 3)}°</b></span><span>LATITUDE <b>{number(latitude, 3)}°</b></span><span>FRAME <b>BODY FIXED</b></span></div>
        </article>
      </section>

      <div className="section-divider"><span>ORBITAL OPERATIONS / PROFILE-INDEPENDENT</span></div>

      <section className="fdo-grid">
        <article className="console-panel orbit-elements">
          <div className="panel-title"><span>04</span><div><p>LIVE OSCULATING ELEMENTS</p><h2>CURRENT TRAJECTORY</h2></div></div>
          <div className="data-table">
            {orbitRows.map(([label, value, trend]) => (
              <div className="data-row" key={label}><span>{label}</span><strong>{value}</strong><em>{trend}</em></div>
            ))}
          </div>
        </article>

        <article className="console-panel orbit-visual-panel">
          <div className="panel-title"><span>05</span><div><p>EARTH-CENTERED INERTIAL</p><h2>ORBIT GEOMETRY</h2></div></div>
          <div className="orbit-visual" aria-label="轨道示意图">
            <div className="axis axis-x" /><div className="axis axis-y" />
            <div className="earth-disc"><i /></div>
            <div className="orbit-ring orbit-ring-parking" /><div className="orbit-ring orbit-ring-transfer" />
            <div className="vehicle-dot"><span>SC</span></div>
            <div className="node-dot node-an"><span>AN</span></div>
            <div className="node-dot node-dn"><span>DN</span></div>
            <div className="target-dot"><span>PLANNED TARGET</span></div>
          </div>
          <div className="orbit-legend">
            <span><i className="legend-parking" /> PARKING</span>
            <span><i className="legend-transfer" /> PLANNED TRANSFER</span>
            <span><i className="legend-target" /> TARGET</span>
          </div>
        </article>

        <article className="console-panel event-log-panel">
          <div className="panel-title"><span>06</span><div><p>MISSION EVENT BUS</p><h2>LIVE LOG</h2></div></div>
          <div className="event-log">
            {logRows.map(([time, source, message, tone]) => (
              <div className={`log-row log-${tone}`} key={`${source}-${message}`}><time>{time}</time><b>{source}</b><span>{message}</span></div>
            ))}
          </div>
          <div className="next-action">
            <span>CURRENT VESSEL STATE</span><strong>{snapshot?.vessel.situation.toUpperCase() ?? "WAITING FOR FEED"}</strong><small>{snapshot?.mission_profile ?? "EARTH_ORBIT"} / READ-ONLY TELEMETRY</small>
          </div>
        </article>
      </section>

      <section className="trend-grid">
        <article className="console-panel mini-trend">
          <header><span>DYNAMIC PRESSURE</span><b>{number(flight?.dynamic_pressure_pa, 2, 1000)} kPa</b></header>
          <div className="bar-chart pressure-chart">
            {[12, 22, 48, 72, 94, 76, 42, 18, 4, 1, 1, 1].map((v, i) => <i style={{ height: `${v}%` }} key={i} />)}
          </div>
          <footer><span>LIFTOFF</span><span>MAX-Q</span><span>NOW</span></footer>
        </article>
        <article className="console-panel mini-trend">
          <header><span>APOGEE / PERIGEE</span><b>{number(snapshot?.orbit.apoapsis_altitude_m, 1, 1000)} / {number(snapshot?.orbit.periapsis_altitude_m, 1, 1000)} km</b></header>
          <div className="line-band"><i /><b /></div>
          <footer><span>LIVE</span><span>OSCULATING ORBIT</span><span>NOW</span></footer>
        </article>
        <article className="console-panel mini-trend">
          <header><span>TELEMETRY QUALITY</span><b>{feedState === "krpc-ws" ? "LIVE" : "FALLBACK"}</b></header>
          <div className="fuel-gauge-large"><i style={{ width: feedState === "krpc-ws" ? "100%" : "40%" }} /></div>
          <footer><span>RATE</span><strong>{streamStats.rateHz == null ? "—" : `${streamStats.rateHz.toFixed(1)} Hz`}</strong><span>DROP {streamStats.dropped}</span></footer>
        </article>
      </section>
    </>
  );
}
