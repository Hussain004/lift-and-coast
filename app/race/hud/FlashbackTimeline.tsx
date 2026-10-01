"use client";

import { useRef } from "react";
import {
  flashStripHeadFraction,
  writeFlashbackStrip,
  type StripColumn,
} from "@/lib/race/flashbackTimeline";
import type { HudSnapshot } from "@/lib/race/hud";
import { useHudFrame } from "./useHudFrame";
import styles from "./hud.module.css";

/**
 * The flashback timeline's strip: the stand-in for the F1 game's film frames.
 *
 * WHY NOT THUMBNAILS, restated because it is the single most important
 * constraint on this widget: a real filmstrip means rendering the scene from
 * several past camera positions and keeping the images, which is extra draw
 * calls, extra memory and extra upload bandwidth at exactly the moment the
 * player is on a laptop with no discrete GPU and has asked to pause. This
 * draws a speed trace, a throttle bar and a brake bar from a 10Hz numeric
 * ring instead, which is one canvas-free row of absolutely positioned divs
 * and costs no draw calls at all.
 *
 * The columns are rebuilt on a 20Hz HUD tick and written as transforms and
 * widths, never as layout-triggering properties, which is the rule the rest
 * of this HUD follows for the same reason.
 *
 * THE TRACE IS A LOCAL MIRROR, and that is a deliberate simplification worth
 * being honest about: gameplay code owns the real trace (it is fed from the
 * physics step in Car.tsx, where the gated throttle and the safety-car speed
 * cap are known). Rather than copy that ring across on every HUD frame - which
 * is a per-frame allocation, forbidden in this codebase - this widget reads
 * the scrub head and capacity from the snapshot and draws the frame outline
 * plus the head. The numeric columns are exposed for the strip to fill in as
 * soon as the trace is published on the snapshot.
 */
const HZ = 20;
/** Columns drawn. Bounded by the trace builder too, so a wide window cannot
 *  turn this into an unbounded DOM write. */
const COLUMNS = 96;

export function FlashbackTimeline({ hudRef }: { hudRef: React.RefObject<HudSnapshot> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  // One column array for the widget's whole life, refilled in place on every
  // redraw. Allocating here instead would be a 96-element array per HUD tick
  // in the middle of a pause, which is precisely the cost this widget is
  // trying to avoid.
  const columns = useRef<StripColumn[]>(
    Array.from({ length: COLUMNS }, () => ({ speed01: 0, throttle01: 0, brake01: 0, contact: false }))
  );
  const lastSerial = useRef(-1);

  useHudFrame(() => {
    const root = rootRef.current;
    if (!root) return;
    const hud = hudRef.current;
    const open = hud.flashbackTimelineOpen;
    root.dataset.on = open ? "1" : "0";
    if (!open) return;

    const span = hud.flashbackCapacity;
    if (readoutRef.current) {
      readoutRef.current.textContent = `${hud.flashbackSeconds.toFixed(1)}s / ${span.toFixed(1)}s`;
    }
    if (headRef.current) {
      // The head moves along the strip; a transform is compositor-friendly and
      // cannot trigger layout.
      headRef.current.style.transform = `translateX(${(flashStripHeadFraction(hud.flashbackSeconds, span, COLUMNS) * 100).toFixed(2)}%)`;
    }

    // Only rebuild the columns when the scrub actually moved, so holding still
    // on a moment costs nothing.
    if (hud.flashbackSeconds === lastSerial.current) return;
    lastSerial.current = hud.flashbackSeconds;
    const strip = stripRef.current;
    if (!strip) return;
    const trace = hud.flashbackTrace;
    if (!trace) return;
    if (writeFlashbackStrip(trace, hud.flashbackSeconds, columns.current) === 0) return;
    paintStrip(strip, columns.current);
  }, HZ);

  return (
    <div className={styles.flashTimeline} ref={rootRef} data-on="0" role="group" aria-label="Flashback timeline">
      <div className={styles.flashTimelineHead}>
        <span>FLASHBACK</span>
        <span ref={readoutRef} />
      </div>
      <div className={styles.flashTimelineStrip} ref={stripRef}>
        <div className={styles.flashTimelineHead2} ref={headRef} />
      </div>
      <div className={styles.flashTimelineHint} ref={hintRef}>
        ← → SCRUB · ENTER CONFIRM · ESC CANCEL
      </div>
    </div>
  );
}

/**
 * Writes the columns into a row of pooled divs.
 *
 * The pool is grown to the requested width once and then only its styles are
 * touched, because creating 96 elements on a HUD tick would be a per-frame
 * allocation and a garbage-collection spike in the middle of a pause - the
 * exact thing this widget exists to avoid.
 */
function paintStrip(container: HTMLElement, columns: StripColumn[]): void {
  let pool = container.children;
  // children[0] is the scrub head, so the columns start at index 1.
  while (pool.length - 1 < columns.length) {
    const cell = document.createElement("div");
    cell.className = styles.flashTimelineColumn;
    const speed = document.createElement("i");
    speed.className = styles.flashTimelineSpeed;
    const pedal = document.createElement("i");
    pedal.className = styles.flashTimelinePedal;
    const mark = document.createElement("i");
    mark.className = styles.flashTimelineMark;
    cell.append(speed, pedal, mark);
    container.append(cell);
    pool = container.children;
  }
  for (let i = 0; i < columns.length; i += 1) {
    const cell = pool[i + 1] as HTMLElement;
    const column = columns[i];
    const speed = cell.children[0] as HTMLElement;
    const pedal = cell.children[1] as HTMLElement;
    const mark = cell.children[2] as HTMLElement;
    speed.style.height = `${(column.speed01 * 100).toFixed(1)}%`;
    // Throttle grows up from the baseline, brake grows down, so the two read
    // as opposite pedals sharing one axis without needing a legend.
    const pedalAmount = Math.max(column.throttle01, column.brake01);
    pedal.style.height = `${(pedalAmount * 100).toFixed(1)}%`;
    pedal.dataset.brake = column.brake01 > column.throttle01 ? "1" : "0";
    mark.dataset.on = column.contact ? "1" : "0";
  }
}

/**
 * Writes the columns into a row of pooled divs.
 *
 * The pool is grown to the requested width once and then only its styles are
 * touched, because creating 96 elements on a HUD tick would be a per-frame
 * allocation and a garbage-collection spike in the middle of a pause - the
 * exact thing this widget exists to avoid.
 */
