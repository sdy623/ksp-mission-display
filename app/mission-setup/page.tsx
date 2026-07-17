import type { Metadata } from "next";
import { MissionSetup } from "./MissionSetup";

export const metadata: Metadata = {
  title: "Create Mission",
  description: "Define the KSP mission, launch vehicle stages and flight events.",
};

export default function MissionSetupPage() {
  return <MissionSetup />;
}
