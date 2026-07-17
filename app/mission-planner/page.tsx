import type { Metadata } from "next";
import { MissionNav } from "../_components/MissionNav";
import { MissionPlanner } from "./MissionPlanner";

export const metadata: Metadata = {
  title: "Mission Planner",
  description: "Profile-driven GEO, TLI and future mission window planning prototype.",
};

export default function MissionPlannerPage() {
  return (
    <main className="app-shell geo-page">
      <MissionNav />
      <MissionPlanner />
    </main>
  );
}
