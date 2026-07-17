import type { Metadata } from "next";
import { MissionNav } from "../_components/MissionNav";
import { LiveLaunchFdo } from "./LiveLaunchFdo";

export const metadata: Metadata = {
  title: "FDO Console",
  description: "Launch and orbital flight dynamics console prototype.",
};

export default function FdoPage() {
  return (
    <main className="app-shell fdo-page">
      <MissionNav />
      <LiveLaunchFdo />
    </main>
  );
}
