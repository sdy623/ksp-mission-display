import type { Metadata } from "next";
import { MissionSetup } from "./mission-setup/MissionSetup";

export const metadata: Metadata = {
  title: "Create Mission",
  description: "Create a KSP flight mission and define its staging sequence.",
};

export default function Home() {
  return <MissionSetup />;
}
