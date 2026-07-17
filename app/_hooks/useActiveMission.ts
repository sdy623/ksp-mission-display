"use client";

import { useMemo, useSyncExternalStore } from "react";
import { ACTIVE_MISSION_STORAGE_KEY, isActiveMission } from "../mission-config";

function subscribe(listener: () => void) {
  const notify = () => listener();
  window.addEventListener("storage", notify);
  window.addEventListener("kmd:mission-changed", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("kmd:mission-changed", notify);
  };
}

function getSnapshot() {
  return window.localStorage.getItem(ACTIVE_MISSION_STORAGE_KEY);
}

function getServerSnapshot() {
  return null;
}

export function useActiveMission() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(() => {
    if (!raw) return null;
    try {
      const mission = JSON.parse(raw) as unknown;
      return isActiveMission(mission) ? mission : null;
    } catch {
      return null;
    }
  }, [raw]);
}
