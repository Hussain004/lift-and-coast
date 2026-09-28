"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `draw` on every animation frame (or at `hz` if given) for as long as
 * the widget is mounted. The race HUD's widgets read the mutable
 * HudSnapshot (see lib/race/hud.ts) and write their own DOM here, so the HUD
 * costs no React renders while driving.
 */
export function useHudFrame(draw: (nowMs: number) => void, hz?: number): void {
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  });
  useEffect(() => {
    let id = 0;
    let last = 0;
    const interval = hz ? 1000 / hz : 0;
    const tick = (now: number) => {
      id = requestAnimationFrame(tick);
      if (interval && now - last < interval) return;
      last = now;
      drawRef.current(now);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [hz]);
}

/** Only #rrggbb from roster data reaches a style attribute. */
export function safeHex(color: string | null | undefined): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : "#8a8f99";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
