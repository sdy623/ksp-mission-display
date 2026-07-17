"use client";

import { useEffect, useState } from "react";
import type { MissionProfile, TelemetrySnapshot } from "../contracts";

export type FeedState = "connecting" | "krpc-ws" | "simulated-fallback" | "error";

export type StreamStats = {
  rateHz: number | null;
  latencyMs: number | null;
  dropped: number;
  maxDynamicPressurePa: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTelemetrySnapshot(value: unknown): value is TelemetrySnapshot {
  if (!isRecord(value) || value.source !== "krpc" && value.source !== "simulated" && value.source !== "replay") return false;
  if (!isRecord(value.vessel) || typeof value.vessel.id !== "string" || typeof value.vessel.name !== "string") return false;
  if (!isRecord(value.flight) || !isRecord(value.orbit) || !isRecord(value.staging) || !isRecord(value.quality)) return false;
  if (!Array.isArray(value.events)) return false;
  return typeof value.mission_id === "string"
    && typeof value.sample_ut === "number"
    && Number.isFinite(value.sample_ut)
    && typeof value.sample_seq === "number"
    && Number.isSafeInteger(value.sample_seq)
    && typeof value.met_s === "number"
    && Number.isFinite(value.met_s);
}

export function useTelemetry(missionProfile: MissionProfile = "EARTH_ORBIT", hz = 50) {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [feedState, setFeedState] = useState<FeedState>("connecting");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [streamStats, setStreamStats] = useState<StreamStats>({
    rateHz: null,
    latencyMs: null,
    dropped: 0,
    maxDynamicPressurePa: null,
  });

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let lastReceiveMs: number | null = null;
    let smoothedRate: number | null = null;
    let lastSequence: number | null = null;
    let droppedFrames = 0;
    let fallbackLoaded = false;
    let peakMissionKey = "";
    let maxDynamicPressurePa: number | null = null;

    function updateMaxDynamicPressure(message: TelemetrySnapshot) {
      const missionKey = `${message.mission_id}:${message.vessel.id}`;
      const currentQ = message.flight.dynamic_pressure_pa;
      if (peakMissionKey !== missionKey || message.met_s < 0) {
        peakMissionKey = missionKey;
        maxDynamicPressurePa = currentQ;
      } else if (currentQ != null && Number.isFinite(currentQ)) {
        maxDynamicPressurePa = Math.max(maxDynamicPressurePa ?? currentQ, currentQ);
      }
    }

    async function loadFallback() {
      if (fallbackLoaded || !active) return;
      fallbackLoaded = true;
      try {
        const response = await fetch(`/api/telemetry?mission_profile=${encodeURIComponent(missionProfile)}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as unknown;
        if (!isTelemetrySnapshot(data)) throw new Error("Telemetry response failed runtime validation");
        if (!active) return;
        updateMaxDynamicPressure(data);
        setSnapshot(data);
        setFeedState(response.headers.get("x-kmd-telemetry-source") === "krpc"
          ? "krpc-ws"
          : "simulated-fallback");
        setUpdatedAt(Date.now());
        setStreamStats((previous) => ({ ...previous, maxDynamicPressurePa }));
      } catch {
        if (active) setFeedState("error");
      }
    }

    function connect() {
      if (!active) return;
      setFeedState((state) => state === "krpc-ws" ? state : "connecting");
      const configured = process.env.NEXT_PUBLIC_KMD_WS_URL;
      const websocketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const baseUrl = configured
        ?? `${websocketProtocol}//${window.location.hostname}:8021/v1/telemetry/ws`;
      const url = new URL(baseUrl);
      url.searchParams.set("mission_profile", missionProfile);
      url.searchParams.set("hz", String(hz));
      socket = new WebSocket(url);

      socket.onopen = () => {
        reconnectAttempt = 0;
        fallbackLoaded = false;
      };

      socket.onmessage = (event) => {
        if (!active) return;
        let message: unknown;
        try {
          message = JSON.parse(event.data as string) as unknown;
        } catch {
          return;
        }
        if (isRecord(message) && message.type === "telemetry_error") {
          void loadFallback();
          return;
        }
        if (!isTelemetrySnapshot(message) || message.source !== "krpc") {
          void loadFallback();
          return;
        }

        updateMaxDynamicPressure(message);

        const receivedMs = performance.now();
        if (lastReceiveMs != null) {
          const instantaneousRate = 1000 / Math.max(1, receivedMs - lastReceiveMs);
          smoothedRate = smoothedRate == null
            ? instantaneousRate
            : (smoothedRate * 0.82) + (instantaneousRate * 0.18);
        }
        lastReceiveMs = receivedMs;

        if (lastSequence != null && message.sample_seq > lastSequence + 1) {
          droppedFrames += message.sample_seq - lastSequence - 1;
        }
        if (lastSequence == null || message.sample_seq > lastSequence) {
          lastSequence = message.sample_seq;
        }
        const latencyMs = message.gateway_unix_ns > 0
          ? Math.max(0, Date.now() - (message.gateway_unix_ns / 1_000_000))
          : null;

        setSnapshot(message);
        setFeedState("krpc-ws");
        setUpdatedAt(Date.now());
        setStreamStats({
          rateHz: smoothedRate,
          latencyMs,
          dropped: droppedFrames,
          maxDynamicPressurePa,
        });
      };

      socket.onerror = () => {
        if (active) void loadFallback();
      };

      socket.onclose = () => {
        socket = null;
        if (!active) return;
        void loadFallback();
        const delay = Math.min(5_000, 500 * (2 ** reconnectAttempt));
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) socket.close(1000, "Telemetry display unmounted");
    };
  }, [hz, missionProfile]);

  return { snapshot, feedState, updatedAt, streamStats };
}
