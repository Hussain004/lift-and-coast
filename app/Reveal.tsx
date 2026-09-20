"use client";

import { useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import styles from "./page.module.css";

// Scroll reveal: content is visible by default (no-JS safe); only once this
// client component mounts does it arm the hidden state and watch for the
// section entering the viewport, so a slow or blocked script can never
// blank the page. Honors prefers-reduced-motion by never arming. With
// `spotlight`, the pointer position is published as --mx/--my CSS vars for
// the panels underneath (see .championship in page.module.css).
export function Reveal({
  children,
  delay = 0,
  spotlight = false,
}: {
  children: ReactNode;
  /** Extra transition delay in ms, for a staggered cascade. */
  delay?: number;
  spotlight?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !("IntersectionObserver" in window)
    ) {
      return;
    }
    el.classList.add(styles.revealArmed);
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add(styles.revealVisible);
            io.disconnect();
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -48px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const onPointerMove = spotlight
    ? (e: PointerEvent<HTMLDivElement>) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - rect.left}px`);
        el.style.setProperty("--my", `${e.clientY - rect.top}px`);
      }
    : undefined;

  return (
    <div
      ref={ref}
      className={styles.reveal}
      style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}
      onPointerMove={onPointerMove}
    >
      {children}
    </div>
  );
}
