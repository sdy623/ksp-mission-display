import type { Metadata } from "next";
import { LiveMissionDisplay } from "./LiveMissionDisplay";

export const metadata: Metadata = {
  title: "Flight Display",
  description: "Live 50 Hz kRPC launch telemetry and flight director OSD.",
};

export default function DisplayPage() {
  return <LiveMissionDisplay />;
}
