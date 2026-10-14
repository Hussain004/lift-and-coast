"use client";

import { useRef } from "react";
import {
  DRILLS,
  createSchool,
  currentDrill,
  saveSchoolDone,
  schoolProgress,
  stepSchool,
} from "@/lib/race/drivingSchool";
import { pushHudEvent, type HudSnapshot } from "@/lib/race/hud";
import { useHudFrame } from "./useHudFrame";
import styles from "./hud.module.css";

/** The driving-school coach card: the drill in hand, and ticks for the ones done. */
export function SchoolCoach({ hudRef }: { hudRef: React.RefObject<HudSnapshot> }) {
  const stateRef = useRef(createSchool());
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLOListElement>(null);
  const shownRef = useRef("");

  useHudFrame(() => {
    const hud = hudRef.current;
    const state = stateRef.current;
    const finished = stepSchool(state, {
      speedKmh: hud.speedKmh,
      brake: hud.brake,
      steer: hud.steer,
      overtakeActive: hud.overtakeActive,
      lap: hud.lap,
      lapInvalid: hud.lapInvalid,
    });
    if (finished) {
      pushHudEvent(hud, "good", "DRILL COMPLETE", finished.title, 2.4);
      if (currentDrill(state) === null) saveSchoolDone();
    }
    const drill = currentDrill(state);
    const { done, total } = schoolProgress(state);
    const key = `${done}`;
    if (key === shownRef.current) return;
    shownRef.current = key;
    if (titleRef.current) titleRef.current.textContent = drill ? `DRIVING SCHOOL ${done + 1}/${total}` : "DRIVING SCHOOL COMPLETE";
    if (textRef.current) {
      textRef.current.textContent = drill ? `${drill.title}: ${drill.instruction}` : "You have the basics. Take it to a Quick Race.";
    }
    if (stepsRef.current) {
      stepsRef.current.innerHTML = DRILLS.map((d) => `<li data-done="${state.done[d.id] ? 1 : 0}"></li>`).join("");
    }
  }, 10);

  return (
    <div className={styles.school} ref={rootRef}>
      <div className={styles.schoolTitle} ref={titleRef}>
        DRIVING SCHOOL 1/{DRILLS.length}
      </div>
      <div className={styles.schoolText} ref={textRef}>
        {DRILLS[0].title}: {DRILLS[0].instruction}
      </div>
      <ol className={styles.schoolSteps} ref={stepsRef} />
    </div>
  );
}
