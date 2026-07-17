import type { MissionProfile } from "./contracts";

export const ACTIVE_MISSION_STORAGE_KEY = "kmd.active-mission.v1";

export type StageRole = "BOOSTER" | "CORE" | "UPPER" | "KICK" | "PAYLOAD";

export type MissionStagePlan = {
  id: string;
  sequence: number;
  name: string;
  role: StageRole;
  activationStage: number;
  decoupleStage: number;
  engineGroup: string;
  estimatedDeltaVMS?: number | null;
  plannedBurnSeconds: number;
  plannedIgnitions: number;
  cutoffEvent: string;
};

export type FairingPlan = {
  enabled: boolean;
  eventName: string;
  activationStage: number;
  minimumAltitudeKm: number;
  maximumDynamicPressureKpa: number;
};

export type ActiveMission = {
  schemaVersion: 1;
  id: string;
  name: string;
  vehicleName: string;
  profile: MissionProfile;
  createdAt: string;
  stages: MissionStagePlan[];
  fairing: FairingPlan;
};

export const defaultMission: ActiveMission = {
  schemaVersion: 1,
  id: "mission-new",
  name: "NEW FLIGHT",
  vehicleName: "ACTIVE KRPC VESSEL",
  profile: "EARTH_ORBIT",
  createdAt: "",
  stages: [
    {
      id: "stage-core",
      sequence: 1,
      name: "CORE STAGE",
      role: "CORE",
      activationStage: 3,
      decoupleStage: 2,
      engineGroup: "MAIN ENGINES",
      estimatedDeltaVMS: null,
      plannedBurnSeconds: 180,
      plannedIgnitions: 1,
      cutoffEvent: "MECO",
    },
    {
      id: "stage-upper",
      sequence: 2,
      name: "UPPER STAGE",
      role: "UPPER",
      activationStage: 1,
      decoupleStage: 0,
      engineGroup: "UPPER ENGINE",
      estimatedDeltaVMS: null,
      plannedBurnSeconds: 480,
      plannedIgnitions: 2,
      cutoffEvent: "SECO",
    },
    {
      id: "stage-payload",
      sequence: 3,
      name: "PAYLOAD",
      role: "PAYLOAD",
      activationStage: 0,
      decoupleStage: -1,
      engineGroup: "NONE",
      estimatedDeltaVMS: null,
      plannedBurnSeconds: 0,
      plannedIgnitions: 0,
      cutoffEvent: "PAYLOAD SEP",
    },
  ],
  fairing: {
    enabled: true,
    eventName: "FAIRING JETTISON",
    activationStage: 2,
    minimumAltitudeKm: 100,
    maximumDynamicPressureKpa: 1,
  },
};

export function newMissionId() {
  return `mission-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function isActiveMission(value: unknown): value is ActiveMission {
  if (typeof value !== "object" || value === null) return false;
  const mission = value as Partial<ActiveMission>;
  if (mission.schemaVersion !== 1 || typeof mission.id !== "string" || typeof mission.name !== "string") return false;
  if (typeof mission.vehicleName !== "string" || !Array.isArray(mission.stages)) return false;
  if (typeof mission.fairing !== "object" || mission.fairing === null) return false;
  return mission.stages.every((stage) => (
    typeof stage === "object"
    && stage !== null
    && typeof stage.id === "string"
    && typeof stage.name === "string"
    && typeof stage.sequence === "number"
    && Number.isSafeInteger(stage.sequence)
  ));
}

export function loadActiveMission(): ActiveMission | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(ACTIVE_MISSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const mission = JSON.parse(raw) as unknown;
    return isActiveMission(mission) ? mission : null;
  } catch {
    return null;
  }
}

export function saveActiveMission(mission: ActiveMission) {
  window.localStorage.setItem(ACTIVE_MISSION_STORAGE_KEY, JSON.stringify(mission));
  window.dispatchEvent(new CustomEvent("kmd:mission-changed", { detail: mission }));
}
