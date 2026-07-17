import type { Metadata } from "next";
import { LiveMissionDisplay } from "../display/LiveMissionDisplay";

export const metadata: Metadata = {
  title: "Broadcast Display",
  description: "Live kRPC broadcast display and flight OSD.",
};

export default function BroadcastPage() {
  return <LiveMissionDisplay />;
}
