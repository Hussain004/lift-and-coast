"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  PAD,
  padDirection,
  pickNavTarget,
  shouldRepeat,
  type NavDirection,
} from "@/lib/input/menuNav";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visibleFocusables(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.closest("[inert], [aria-hidden='true']")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  });
}

function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return type !== "range" && type !== "checkbox" && type !== "radio" && type !== "button";
}

/** Nudges a focused slider by one step, the way React will hear it. */
function stepRange(input: HTMLInputElement, dir: 1 | -1) {
  const step = Number(input.step) || 1;
  const next = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + dir * step));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, String(next));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function move(dir: NavDirection) {
  const active = document.activeElement as HTMLElement | null;
  const all = visibleFocusables();
  if (!active || active === document.body || !all.includes(active)) {
    const first = document.querySelector<HTMLElement>("[data-nav-default]") ?? all[0];
    first?.focus();
    first?.scrollIntoView({ block: "nearest" });
    return;
  }
  const rects = all.map((el) => el.getBoundingClientRect());
  const index = pickNavTarget(active.getBoundingClientRect(), rects, dir);
  if (index >= 0) {
    all[index].focus();
    all[index].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/**
 * Console-style menu control for every menu screen: arrow keys and the
 * gamepad's D-pad/left stick move focus spatially, Enter/A selects, Esc/B
 * goes back to `backHref`. Sliders take Left/Right while focused. Also
 * reports whether a pad is connected so the footer can show pad prompts.
 */
export function MenuNavigator({
  backHref,
  onPadChange,
}: {
  backHref?: string;
  onPadChange?: (connected: boolean) => void;
}) {
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      if (e.key === "Escape") {
        if (backHref && !document.querySelector("[role='dialog']")) {
          e.preventDefault();
          router.push(backHref);
        }
        return;
      }
      const dir: NavDirection | null =
        e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
      if (!dir || isTextField(active)) return;
      // A focused slider keeps Left/Right for its own value.
      if (active instanceof HTMLInputElement && active.type === "range" && (dir === "left" || dir === "right")) return;
      e.preventDefault();
      move(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [backHref, router]);

  useEffect(() => {
    let id = 0;
    let held: NavDirection | null = null;
    let heldSince = 0;
    let lastFire = 0;
    let prevA = false;
    let prevB = false;
    let connected = false;
    const tick = (now: number) => {
      id = requestAnimationFrame(tick);
      const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p && p.connected) ?? null;
      if (!!pad !== connected) {
        connected = !!pad;
        onPadChange?.(connected);
      }
      if (!pad) return;
      const dir = padDirection(pad.buttons, pad.axes);
      if (dir !== held) {
        held = dir;
        heldSince = now;
        lastFire = now;
        if (dir) fire(dir);
      } else if (dir && shouldRepeat(now - heldSince, lastFire, now)) {
        lastFire = now;
        fire(dir);
      }
      const a = !!pad.buttons[PAD.a]?.pressed;
      const b = !!pad.buttons[PAD.b]?.pressed;
      if (a && !prevA) {
        const el = document.activeElement as HTMLElement | null;
        if (el && el !== document.body) el.click();
        else move("down");
      }
      if (b && !prevB && backHref) router.push(backHref);
      prevA = a;
      prevB = b;
    };
    const fire = (dir: NavDirection) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.type === "range" && (dir === "left" || dir === "right")) {
        stepRange(active, dir === "right" ? 1 : -1);
        return;
      }
      move(dir);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [backHref, router, onPadChange]);

  return null;
}
