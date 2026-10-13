"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AssistPresets } from "./AssistPresets";
import { AudioMixer } from "./AudioMixer";
import { AudioSetting } from "./AudioSetting";
import { CameraSetting } from "./CameraSetting";
import { DamageSetting } from "./DamageSetting";
import { EngineerSetting } from "./EngineerSetting";
import { GraphicsSetting } from "./GraphicsSetting";
import { HapticsSetting } from "./HapticsSetting";
import { HudSetting } from "./HudSetting";
import { RacingLineSetting } from "./RacingLineSetting";
import { SafetyCarSetting } from "./SafetyCarSetting";
import { SaveTransfer } from "./SaveTransfer";
import { ControlSettingsPanel } from "./race/ControlSettingsPanel";
import styles from "./menu.module.css";
import setupStyles from "./sessionSetup.module.css";

export const SETTINGS_TABS = [
  { id: "controls", label: "Controls" },
  { id: "assists", label: "Assists" },
  { id: "gameplay", label: "Gameplay" },
  { id: "display", label: "Display" },
  { id: "audio", label: "Audio" },
  { id: "data", label: "Data" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

export function parseSettingsTab(raw: string | null): SettingsTab {
  return SETTINGS_TABS.find((t) => t.id === raw)?.id ?? "controls";
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>{title}</h2>
      {note && <p className={styles.cardNote}>{note}</p>}
      {children}
    </section>
  );
}

/**
 * The settings screen: six tabs, one concern each. The tab lives in `?tab=`
 * so the pause menu (or anything else) can deep-link to one, and Q/E (LB/RB)
 * switch tabs through MenuNavigator.
 */
export function SettingsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const tab = parseSettingsTab(useSearchParams().get("tab"));
  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <div className={setupStyles.tabs} role="tablist" data-nav-tabs aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? setupStyles.tabActive : setupStyles.tab}
            onClick={() => router.replace(`${pathname}?tab=${t.id}`, { scroll: false })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={styles.stack} style={{ marginTop: 18 }}>
        {tab === "controls" && (
          <>
            <Card title="KEYS AND STEERING">
              <ControlSettingsPanel inline />
            </Card>
            <Card title="VIBRATION" note="Gamepad rumble on kerbs, slides and impacts (Chromium browsers), and phone vibration on impacts.">
              <HapticsSetting />
            </Card>
          </>
        )}
        {tab === "assists" && (
          <>
            <Card
              title="DRIVING AIDS"
              note="A preset sets traction control, ABS, the racing line and damage together. Gearbox and AI level are chosen per session."
            >
              <AssistPresets />
            </Card>
            <Card title="RACING LINE" note="The full line, or only where you need to lift or brake. L shows or hides it in a race.">
              <RacingLineSetting />
            </Card>
          </>
        )}
        {tab === "gameplay" && (
          <>
            <Card
              title="DAMAGE"
              note="Front wing, rear wing and floor take hits and cost grip and downforce until you pit. Simulation adds punctures."
            >
              <DamageSetting />
            </Card>
            <Card
              title="SAFETY CAR"
              note="How often the safety car and virtual safety car come out in races of three laps or more. Everyone is held to a speed limit and overtaking is off until the green flag; a stopped car can also bring out a VSC. Applies from the next race."
            >
              <SafetyCarSetting />
            </Card>
            <Card
              title="RACE ENGINEER"
              note="Radio calls on gaps, tyres, fuel, damage and the flag. Voice uses your browser's speech and respects mute (M)."
            >
              <EngineerSetting />
            </Card>
          </>
        )}
        {tab === "display" && (
          <>
            <Card title="GRAPHICS">
              <GraphicsSetting />
            </Card>
            <Card title="CAMERA" note="Kerb and high-speed shake. Off by default if your system asks for reduced motion.">
              <CameraSetting />
            </Card>
            <Card title="RACE HUD" note="Size, which panels show, and a palette that does not rely on red and green.">
              <HudSetting />
            </Card>
          </>
        )}
        {tab === "audio" && (
          <>
            <Card title="SOUND" note="Engines, effects and menu sounds. M toggles it during a race.">
              <AudioSetting />
            </Card>
            <Card title="MIXER" note="Levels apply immediately, including in a race.">
              <AudioMixer />
            </Card>
          </>
        )}
        {tab === "data" && (
          <Card
            title="SAVE DATA"
            note="Your garage, bests, ghosts and season live in this browser. Export a backup or move them to another device."
          >
            <SaveTransfer />
          </Card>
        )}
      </div>
    </div>
  );
}
