"use client";

import Link from "next/link";
import { useTelemetry } from "../_hooks/useTelemetry";

export function MissionNav({ overlay = false }: { overlay?: boolean }) {
  const { feedState } = useTelemetry("EARTH_ORBIT", 2);
  const live = feedState === "krpc-ws";

  return (
    <header className={`mission-nav ${overlay ? "mission-nav-overlay" : ""}`}>
      <Link className="brand-lockup" href="/display" aria-label="KSP Mission Display 主显示屏">
        <span className="brand-mark">K</span>
        <span><b>KSP MISSION DISPLAY</b><small>RSS / RO FLIGHT SYSTEMS</small></span>
      </Link>
      <nav aria-label="主导航">
        <Link href="/mission-setup">MISSION SETUP</Link>
        <Link href="/display">DISPLAY</Link>
        <Link href="/fdo">FDO</Link>
        <Link href="/mission-planner">MISSION PLANNER</Link>
      </nav>
      <div className={`nav-status ${live ? "nav-status-live" : "nav-status-simulation"}`}>
        <i aria-hidden="true" /><span>{live ? "LIVE" : "SIMULATION"}</span>
      </div>
    </header>
  );
}
