"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MissionNav } from "../_components/MissionNav";
import { StatusBadge } from "../_components/StatusBadge";
import { useTelemetry } from "../_hooks/useTelemetry";
import {
  defaultMission,
  loadActiveMission,
  newMissionId,
  saveActiveMission,
  type ActiveMission,
  type MissionStagePlan,
  type StageRole,
} from "../mission-config";
import type { MissionProfile, StageManifest } from "../contracts";

const roles: StageRole[] = ["BOOSTER", "CORE", "UPPER", "KICK", "PAYLOAD"];
const profiles: MissionProfile[] = ["EARTH_ORBIT", "GEO_SLOT", "TLI", "SSO", "TMI", "CUSTOM"];

type InferenceState = {
  status: "idle" | "loading" | "success" | "error";
  message: string;
  warnings: string[];
};

function cloneDefault(): ActiveMission {
  return {
    ...defaultMission,
    id: newMissionId(),
    stages: defaultMission.stages.map((stage) => ({ ...stage })),
    fairing: { ...defaultMission.fairing },
  };
}

export function MissionSetup() {
  const router = useRouter();
  const { snapshot, feedState } = useTelemetry("EARTH_ORBIT", 2);
  const [mission, setMission] = useState<ActiveMission>(cloneDefault);
  const [loaded, setLoaded] = useState(false);
  const [inference, setInference] = useState<InferenceState>({
    status: "idle",
    message: "",
    warnings: [],
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = loadActiveMission();
      if (saved) setMission(saved);
      setLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function patchMission(patch: Partial<ActiveMission>) {
    setMission((current) => ({ ...current, ...patch }));
  }

  function patchStage(id: string, patch: Partial<MissionStagePlan>) {
    setMission((current) => ({
      ...current,
      stages: current.stages.map((stage) => stage.id === id ? { ...stage, ...patch } : stage),
    }));
  }

  function addStage() {
    setMission((current) => {
      const sequence = current.stages.length + 1;
      return {
        ...current,
        stages: [
          ...current.stages,
          {
            id: `stage-${crypto.randomUUID()}`,
            sequence,
            name: `STAGE ${sequence}`,
            role: "UPPER",
            activationStage: Math.max(0, 3 - sequence),
            decoupleStage: Math.max(-1, 2 - sequence),
            engineGroup: "ENGINE GROUP",
            estimatedDeltaVMS: null,
            plannedBurnSeconds: 300,
            plannedIgnitions: 1,
            cutoffEvent: `SECO-${Math.max(1, sequence - 1)}`,
          },
        ],
      };
    });
  }

  function removeStage(id: string) {
    setMission((current) => ({
      ...current,
      stages: current.stages
        .filter((stage) => stage.id !== id)
        .map((stage, index) => ({ ...stage, sequence: index + 1 })),
    }));
  }

  function moveStage(id: string, direction: -1 | 1) {
    setMission((current) => {
      const sourceIndex = current.stages.findIndex((stage) => stage.id === id);
      const targetIndex = sourceIndex + direction;
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= current.stages.length) return current;
      const stages = [...current.stages];
      [stages[sourceIndex], stages[targetIndex]] = [stages[targetIndex], stages[sourceIndex]];
      return {
        ...current,
        stages: stages.map((stage, index) => ({ ...stage, sequence: index + 1 })),
      };
    });
  }

  async function inferStagesFromKRPC() {
    setInference({ status: "loading", message: "READING ACTIVE VESSEL PART TOPOLOGY…", warnings: [] });
    try {
      const response = await fetch("/api/vehicle-stages", { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as StageManifest & { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? `Auto-detect failed (${response.status})`);
      if (!Array.isArray(body.stages) || body.stages.length === 0) {
        throw new Error("No propulsion stages were inferred from the active vessel.");
      }

      const stages: MissionStagePlan[] = body.stages.map((stage, index) => ({
        id: `inferred-${stage.activation_stage}-${stage.decouple_stage}-${index}-${Date.now()}`,
        sequence: index + 1,
        name: stage.name,
        role: stage.role,
        activationStage: stage.activation_stage,
        decoupleStage: stage.decouple_stage,
        engineGroup: stage.engine_group,
        estimatedDeltaVMS: stage.estimated_delta_v_m_s === null
          ? null
          : Math.round(stage.estimated_delta_v_m_s),
        plannedBurnSeconds: stage.estimated_burn_time_s === null
          ? 0
          : Math.round(stage.estimated_burn_time_s),
        plannedIgnitions: stage.planned_ignitions,
        cutoffEvent: stage.cutoff_event,
      }));
      const fairing = body.fairings[0];
      setMission((current) => ({
        ...current,
        vehicleName: body.vessel.name,
        stages,
        fairing: {
          ...current.fairing,
          enabled: body.fairings.length > 0,
          activationStage: fairing?.activation_stage ?? current.fairing.activationStage,
        },
      }));
      const deltaV = body.total_estimated_delta_v_m_s;
      setInference({
        status: "success",
        message: `${stages.length} PROPULSION ELEMENTS · ${body.confidence.toUpperCase()} CONFIDENCE${deltaV === null ? "" : ` · STACK ΔV ≈ ${Math.round(deltaV).toLocaleString()} m/s`}`,
        warnings: body.warnings,
      });
    } catch (error) {
      setInference({
        status: "error",
        message: error instanceof Error ? error.message : "Unable to infer stages from kRPC.",
        warnings: [],
      });
    }
  }

  function importActiveVessel() {
    if (snapshot?.vessel.name) patchMission({ vehicleName: snapshot.vessel.name });
  }

  function createMission() {
    const normalized: ActiveMission = {
      ...mission,
      id: mission.id || newMissionId(),
      name: mission.name.trim() || "UNTITLED MISSION",
      vehicleName: mission.vehicleName.trim() || "ACTIVE KRPC VESSEL",
      createdAt: new Date().toISOString(),
      stages: mission.stages.map((stage, index) => ({ ...stage, sequence: index + 1 })),
    };
    saveActiveMission(normalized);
    router.push("/display");
  }

  const live = feedState === "krpc-ws";

  return (
    <main className="app-shell mission-setup-page">
      <MissionNav />
      <header className="setup-header">
        <div>
          <p className="kicker">MISSION DEFINITION / STAGING CONTRACT</p>
          <h1>CREATE FLIGHT MISSION</h1>
          <p>先定义任务、各级与计划事件；kRPC 实时状态将在飞行中匹配 MECO、级间分离、整流罩抛离和 SECO。</p>
        </div>
        <div className="setup-connection">
          <StatusBadge tone={live ? "success" : "warning"}>{live ? "KRPC LIVE" : "SIMULATION"}</StatusBadge>
          <span>VESSEL</span><strong>{snapshot?.vessel.name ?? "NO LIVE VESSEL"}</strong>
          <button disabled={!snapshot?.vessel.name} onClick={importActiveVessel} type="button">USE ACTIVE VESSEL</button>
        </div>
      </header>

      <section className="setup-basics console-panel" aria-label="任务基本信息">
        <label><span>MISSION NAME</span><input maxLength={96} onChange={(event) => patchMission({ name: event.target.value })} value={mission.name} /></label>
        <label><span>VEHICLE NAME</span><input maxLength={128} onChange={(event) => patchMission({ vehicleName: event.target.value })} value={mission.vehicleName} /></label>
        <label><span>MISSION PROFILE</span><select onChange={(event) => patchMission({ profile: event.target.value as MissionProfile })} value={mission.profile}>{profiles.map((profile) => <option key={profile}>{profile}</option>)}</select></label>
        <label><span>MISSION ID</span><input maxLength={96} onChange={(event) => patchMission({ id: event.target.value })} value={mission.id} /></label>
      </section>

      <section className="stage-editor console-panel" aria-label="分级定义">
        <header className="stage-editor-heading">
          <div><span>LAUNCH VEHICLE STACK</span><h2>STAGE & EVENT DEFINITIONS</h2></div>
          <div className="stage-editor-heading-actions">
            <button disabled={inference.status === "loading"} onClick={inferStagesFromKRPC} type="button">{inference.status === "loading" ? "READING KRPC…" : "AUTO-DETECT FROM KRPC"}</button>
            <button onClick={addStage} type="button">+ ADD FLIGHT ELEMENT</button>
          </div>
        </header>
        {inference.status !== "idle" && (
          <div className={`stage-inference-result is-${inference.status}`}>
            <strong>{inference.status === "error" ? "AUTO-DETECT FAILED" : "CRAFT INFERENCE"}</strong>
            <span>{inference.message}</span>
            {inference.warnings.map((warning) => <small key={warning}>{warning}</small>)}
          </div>
        )}
        <div className="stage-editor-table">
          <div className="stage-editor-row stage-editor-labels">
            <span>SEQ / NAME</span><span>ROLE</span><span>KSP ACT.</span><span>DECOUPLE</span><span>ENGINE GROUP</span><span>EST. ΔV</span><span>BURN SEC</span><span>IGN.</span><span>CUTOFF EVENT</span><span>ORDER</span>
          </div>
          {mission.stages.map((stage, index) => (
            <div className="stage-editor-row" key={stage.id}>
              <label><b>{String(stage.sequence).padStart(2, "0")}</b><input aria-label={`第 ${stage.sequence} 级名称`} maxLength={96} onChange={(event) => patchStage(stage.id, { name: event.target.value })} value={stage.name} /></label>
              <select aria-label={`${stage.name} 类型`} onChange={(event) => patchStage(stage.id, { role: event.target.value as StageRole })} value={stage.role}>{roles.map((role) => <option key={role}>{role}</option>)}</select>
              <input aria-label={`${stage.name} KSP activation stage`} min="-1" onChange={(event) => patchStage(stage.id, { activationStage: Number(event.target.value) })} type="number" value={stage.activationStage} />
              <input aria-label={`${stage.name} KSP decouple stage`} min="-1" onChange={(event) => patchStage(stage.id, { decoupleStage: Number(event.target.value) })} type="number" value={stage.decoupleStage} />
              <input aria-label={`${stage.name} 发动机组`} maxLength={96} onChange={(event) => patchStage(stage.id, { engineGroup: event.target.value })} value={stage.engineGroup} />
              <div className="input-with-unit"><input aria-label={`${stage.name} 估算 delta-v`} min="0" onChange={(event) => patchStage(stage.id, { estimatedDeltaVMS: event.target.value === "" ? null : Number(event.target.value) })} type="number" value={stage.estimatedDeltaVMS ?? ""} /><b>m/s</b></div>
              <input aria-label={`${stage.name} 计划燃烧时间`} min="0" onChange={(event) => patchStage(stage.id, { plannedBurnSeconds: Number(event.target.value) })} type="number" value={stage.plannedBurnSeconds} />
              <input aria-label={`${stage.name} 点火次数`} min="0" onChange={(event) => patchStage(stage.id, { plannedIgnitions: Number(event.target.value) })} type="number" value={stage.plannedIgnitions} />
              <input aria-label={`${stage.name} 关机事件`} maxLength={48} onChange={(event) => patchStage(stage.id, { cutoffEvent: event.target.value })} value={stage.cutoffEvent} />
              <div className="stage-row-actions">
                <button aria-label={`上移 ${stage.name}`} disabled={index === 0} onClick={() => moveStage(stage.id, -1)} title="Move up" type="button">↑</button>
                <button aria-label={`下移 ${stage.name}`} disabled={index === mission.stages.length - 1} onClick={() => moveStage(stage.id, 1)} title="Move down" type="button">↓</button>
                <button aria-label={`删除 ${stage.name}`} disabled={mission.stages.length <= 1} onClick={() => removeStage(stage.id)} title="Delete" type="button">×</button>
              </div>
            </div>
          ))}
        </div>
        <p className="stage-number-note">KSP stage 数字按游戏右侧分级栏填写；activation 是部件点火/激活级，decouple 是部件脱离级，未分级填 −1。</p>
      </section>

      <section className="fairing-editor console-panel" aria-label="整流罩计划">
        <label className="fairing-enabled"><input checked={mission.fairing.enabled} onChange={(event) => patchMission({ fairing: { ...mission.fairing, enabled: event.target.checked } })} type="checkbox" /><span>PAYLOAD FAIRING</span><b>{mission.fairing.enabled ? "TRACK" : "NOT FITTED"}</b></label>
        <label><span>EVENT NAME</span><input disabled={!mission.fairing.enabled} maxLength={64} onChange={(event) => patchMission({ fairing: { ...mission.fairing, eventName: event.target.value } })} value={mission.fairing.eventName} /></label>
        <label><span>KSP STAGE</span><input disabled={!mission.fairing.enabled} min="-1" onChange={(event) => patchMission({ fairing: { ...mission.fairing, activationStage: Number(event.target.value) } })} type="number" value={mission.fairing.activationStage} /></label>
        <label><span>MIN ALTITUDE</span><div className="input-with-unit"><input disabled={!mission.fairing.enabled} min="0" onChange={(event) => patchMission({ fairing: { ...mission.fairing, minimumAltitudeKm: Number(event.target.value) } })} type="number" value={mission.fairing.minimumAltitudeKm} /><b>km</b></div></label>
        <label><span>MAX Q AT JETTISON</span><div className="input-with-unit"><input disabled={!mission.fairing.enabled} min="0" onChange={(event) => patchMission({ fairing: { ...mission.fairing, maximumDynamicPressureKpa: Number(event.target.value) } })} step="0.1" type="number" value={mission.fairing.maximumDynamicPressureKpa} /><b>kPa</b></div></label>
      </section>

      <section className="setup-detection-note">
        <strong>EVENT DETECTION</strong>
        <span>MECO / SECO = planned stage mapping + throttle + active engine thrust + fuel state + stage transition</span>
        <span>FAIRING = kRPC fairing.jettisoned edge; altitude/Q are mission constraints, not proof by themselves</span>
      </section>

      <footer className="setup-actions">
        <span>{loaded ? `${mission.stages.length} FLIGHT ELEMENTS / ${mission.fairing.enabled ? "FAIRING TRACKED" : "NO FAIRING"}` : "LOADING MISSION"}</span>
        <button className="primary-action" disabled={!loaded || mission.stages.length === 0} onClick={createMission} type="button">CREATE MISSION & OPEN DISPLAY →</button>
      </footer>
    </main>
  );
}
