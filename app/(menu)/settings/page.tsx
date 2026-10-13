import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsScreen } from "../../SettingsScreen";

export const metadata: Metadata = { title: "Settings · LIFT & COAST" };

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsScreen />
    </Suspense>
  );
}
