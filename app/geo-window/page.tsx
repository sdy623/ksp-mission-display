import type { Metadata } from "next";
import { MissionNav } from "../_components/MissionNav";
import { MissionPlanner } from "../mission-planner/MissionPlanner";

export const metadata: Metadata = {
  title: "GEO Window Planner",
  description: "GEO longitude targeting and node window prototype.",
};

export default function GeoWindowPage() {
  return (
    <main className="app-shell geo-page">
      <MissionNav />
      <MissionPlanner initialProfile="GEO_SLOT" />
    </main>
  );
}
