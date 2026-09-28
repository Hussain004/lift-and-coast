"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./race.module.css";
import {
  CONTROL_ACTIONS,
  CONTROL_LABELS,
  DEFAULT_SETTINGS,
  formatKeyCode,
  getBindings,
  getControlSettings,
  setBindings,
  setControlSettings,
  subscribeToControls,
  validateBindings,
  type ControlAction,
  type ControlBindings,
  type ControlSettings,
} from "@/lib/input/keyBindings";
import {
  applyControls,
  currentControls,
  defaultStorage,
  loadLocalControls,
  saveLocalControls,
  type StoredControls,
} from "@/lib/settings/controlStorage";
import { pullControlSettings, pushControlSettings } from "@/lib/race/controlSettingsClient";
import { loadAccountSession } from "@/lib/race/authClient";
import type { AccountSession } from "@/lib/race/accounts";

/**
 * Control settings: rebind every action, and set the steering feel.
 *
 * LOCAL FIRST. The panel reads and writes localStorage through
 * controlStorage.ts, so it works with no account and no network, and the
 * change applies to the car on the very next key press - useDriveInput
 * resolves bindings through the live table rather than a captured constant.
 *
 * If a player IS signed in, the same set is also pushed to their account, and
 * pulled back down on mount. That is additive: a failed sync changes nothing
 * locally and is reported in one line rather than a modal, because the game
 * must never be able to fail because a server did.
 *
 * A rebind is applied through setBindings, which REFUSES a table that would
 * leave an action with no key or double-book one. The panel reflects that:
 * while the pending table is invalid nothing is committed and the offending
 * rows are marked, so a player is never left half-way through a change that
 * silently moved a key.
 */

type Capture = { action: ControlAction } | null;

export function ControlSettingsPanel({ inline = false }: { inline?: boolean } = {}) {
  // Seeded from the stored copy on mount, then owned here so a rebind can
  // edit a table that is not yet valid - the live table only ever holds a
  // valid one.
  const [bindings, setPendingBindings] = useState<ControlBindings>(() => {
    const stored = loadLocalControls(defaultStorage());
    return stored?.bindings ?? getBindings();
  });
  const [settings, setPendingSettings] = useState<ControlSettings>(
    () => loadLocalControls(defaultStorage())?.settings ?? getControlSettings()
  );
  const [capture, setCapture] = useState<Capture>(null);
  const [status, setStatus] = useState<string>("");
  // Read once, lazily. loadAccountSession is a pure localStorage read, so it
  // belongs in an initialiser rather than in an effect - an effect that
  // synchronously setState is a cascading render, and the panel is opened
  // fresh each time so it sees the current session anyway.
  const [session] = useState<AccountSession | null>(() => loadAccountSession());

  // Pull the account's copy once, on mount, but ONLY if the player has not
  // already got local settings - someone who has configured this browser
  // should not have it silently replaced by an older account copy.
  useEffect(() => {
    if (session === null) return;
    if (loadLocalControls(defaultStorage()) !== null) return;
    let cancelled = false;
    void pullControlSettings({ session }).then((pulled) => {
      if (cancelled || pulled === null) return;
      applyControls(pulled);
      setPendingBindings(pulled.bindings);
      setPendingSettings(pulled.settings);
      setStatus("Loaded your saved controls from your account.");
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // The live table can be changed from elsewhere (a reset elsewhere, the
  // account pull above); keep the editor in step with it.
  useEffect(() => subscribeToControls(() => {
    setPendingBindings(getBindings());
    setPendingSettings(getControlSettings());
  }), []);

  const problems = validateBindings(bindings);
  const problemActions = new Set(problems.map((p) => p.action));

  /** Commits to the live table, then saves locally, then syncs if signed in. */
  const commit = useCallback(
    (nextBindings: ControlBindings, nextSettings: ControlSettings, note: string) => {
      // setBindings refuses an invalid table and keeps the current one, so a
      // rejected change is reported rather than half-applied.
      if (!setBindings(nextBindings)) {
        setStatus("That change conflicts with another key. Nothing was applied.");
        return;
      }
      setControlSettings(nextSettings);
      const controls: StoredControls = { bindings: nextBindings, settings: nextSettings };
      const savedLocally = saveLocalControls(defaultStorage(), controls);
      setStatus(savedLocally ? note : `${note} (this browser will not remember it)`);
      if (session === null) return;
      void pushControlSettings({ session }, controls).then((synced) => {
        setStatus(
          synced
            ? `${note} Synced to your account.`
            : `${note} Saved here; your account could not be reached.`
        );
      });
    },
    [session]
  );

  // Key capture: the next keydown becomes the binding, and is preventDefault'd
  // so it cannot also fire whatever it was bound to. Escape cancels without
  // binding, so a player who realises mid-press can back out.
  useEffect(() => {
    if (capture === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapture(null);
        return;
      }
      const action = capture.action;
      setCapture(null);
      setPendingBindings((current) => ({ ...current, [action]: [event.code] }));
    };
    // Capture phase, so it wins over the game's own handler on the same event.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capture]);

  const onSensitivity = (key: keyof ControlSettings, value: number | boolean | string) => {
    setPendingSettings((current) => ({ ...current, [key]: value }) as ControlSettings);
  };

  return (
    <div className={`${styles.settingsPanel}${inline ? ` ${styles.settingsInline}` : ""}`} data-testid="control-settings">
      <div className={styles.settingsHeader}>
        <span className={styles.settingsTitle}>CONTROLS</span>
        <span className={styles.settingsHint}>
          {session === null ? "saved to this browser" : `signed in as ${session.username}`}
        </span>
      </div>

      {status.length > 0 && <p className={styles.settingsStatus}>{status}</p>}

      <div className={styles.settingsGroup}>
        <span className={styles.settingsLabel}>KEY BINDINGS</span>
        <div className={styles.settingsKeys}>
          {CONTROL_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              className={problemActions.has(action) ? styles.settingsKeyBad : styles.settingsKey}
              data-capturing={capture?.action === action ? "yes" : "no"}
              onClick={() => setCapture({ action })}
            >
              <span className={styles.settingsKeyName}>{CONTROL_LABELS[action]}</span>
              {/* The PENDING key, not the live one. A row that showed the
                  live table looked like the rebind had been ignored - you
                  press a key, the row does not move, and there is no way to
                  tell whether it took. Showing the pending value also makes
                  the red conflict marking mean something, since a conflicting
                  key is by definition the one you just chose. */}
              <span className={styles.settingsKeyCode}>
                {capture?.action === action
                  ? "press a key"
                  : bindings[action].map(formatKeyCode).join(" / ")}
              </span>
            </button>
          ))}
        </div>
        {problems.length > 0 && (
          <p className={styles.settingsProblem}>
            {problems.length === 1
              ? "One binding is a problem."
              : `${problems.length} bindings are a problem.`}{" "}
            Conflicting keys are not applied.
          </p>
        )}
      </div>

      <div className={styles.settingsGroup}>
        <span className={styles.settingsLabel}>STEERING</span>
        <label className={styles.settingsField}>
          <span>Sensitivity</span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={settings.steerSensitivity}
            onChange={(e) => onSensitivity("steerSensitivity", Number(e.target.value))}
          />
          <b>{settings.steerSensitivity.toFixed(2)}</b>
        </label>
        <label className={styles.settingsField}>
          <span>Deadzone</span>
          <input
            type="range"
            min={0}
            max={0.3}
            step={0.01}
            value={settings.steerDeadzone}
            onChange={(e) => onSensitivity("steerDeadzone", Number(e.target.value))}
          />
          <b>{settings.steerDeadzone.toFixed(2)}</b>
        </label>
        <label className={styles.settingsCheck}>
          <input
            type="checkbox"
            checked={settings.invertSteering}
            onChange={(e) => onSensitivity("invertSteering", e.target.checked)}
          />
          <span>Invert steering</span>
        </label>
      </div>

      <div className={styles.settingsGroup}>
        <span className={styles.settingsLabel}>SESSION DEFAULTS</span>
        <label className={styles.settingsField}>
          <span>Tyre</span>
          <select
            value={settings.defaultCompound}
            onChange={(e) =>
              onSensitivity(
                "defaultCompound",
                e.target.value as ControlSettings["defaultCompound"]
              )
            }
          >
            <option value="soft">Soft</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </label>
        <label className={styles.settingsCheck}>
          <input
            type="checkbox"
            checked={settings.tractionControlDefault}
            onChange={(e) => onSensitivity("tractionControlDefault", e.target.checked)}
          />
          <span>Traction control on</span>
        </label>
        <label className={styles.settingsCheck}>
          <input
            type="checkbox"
            checked={settings.absDefault}
            onChange={(e) => onSensitivity("absDefault", e.target.checked)}
          />
          <span>ABS on</span>
        </label>
      </div>

      <div className={styles.settingsActions}>
        <button
          type="button"
          className={styles.settingsAction}
          onClick={() => commit(bindings, settings, "Controls saved.")}
          disabled={problems.length > 0}
        >
          SAVE
        </button>
        <button
          type="button"
          className={styles.settingsAction}
          onClick={() => {
            const fresh = { ...DEFAULT_SETTINGS };
            setPendingSettings(fresh);
            commit(getBindings(), fresh, "Steering reset to default.");
          }}
        >
          RESET STEERING
        </button>
        <button
          type="button"
          className={styles.settingsAction}
          onClick={() => {
            void import("@/lib/input/keyBindings").then(({ resetControls }) => {
              resetControls();
              setPendingBindings(getBindings());
              setPendingSettings(getControlSettings());
              commit(getBindings(), getControlSettings(), "All controls reset to default.");
            });
          }}
        >
          RESET ALL
        </button>
      </div>
    </div>
  );
}

/** Exposed for the host page, which needs to apply a stored set on load. */
export { currentControls, applyControls };
