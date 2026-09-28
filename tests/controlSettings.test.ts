import { describe, expect, it } from "vitest";
import {
  CONTROL_ACTIONS,
  DEFAULT_BINDINGS,
  DEFAULT_SETTINGS,
  STEER_SENSITIVITY_MAX,
  STEER_SENSITIVITY_MIN,
  applySteerSettings,
  bindingsAreValid,
  formatKeyCode,
  getBindings,
  getControlSettings,
  normalizeBindings,
  normalizeSettings,
  resetControls,
  setBindings,
  setControlSettings,
  subscribeToControls,
  validateBindings,
  type ControlBindings,
} from "../lib/input/keyBindings";
import {
  defaultControls,
  loadLocalControls,
  saveLocalControls,
  applyControls,
} from "../lib/settings/controlStorage";
import {
  controlSettingsFromRow,
  controlSettingsRow,
  pullControlSettings,
  pushControlSettings,
  syncControlSettings,
  type StoredControlsPayload,
} from "../lib/race/controlSettingsClient";
import type { AccountSession } from "../lib/race/accounts";

const SESSION: AccountSession = {
  userId: "11111111-1111-4111-8111-111111111111",
  accessToken: "jwt-token",
  username: "tester",
  expiresAtMs: Date.now() + 3_600_000,
};

function fakeStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set("lift-and-coast.controls.v1", initial);
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("the defaults are the shipped controls", () => {
  it("every action has a binding and the table is valid", () => {
    for (const action of CONTROL_ACTIONS) {
      expect(DEFAULT_BINDINGS[action].length, action).toBeGreaterThan(0);
    }
    expect(bindingsAreValid(DEFAULT_BINDINGS)).toBe(true);
  });

  it("keeps the specific keys the game has always used", () => {
    // If this changes, every existing player's controls move under them. The
    // whole point of the settings feature is that it changes nothing until
    // they open it.
    expect(DEFAULT_BINDINGS.throttle).toEqual(["KeyW", "ArrowUp"]);
    expect(DEFAULT_BINDINGS.brake).toEqual(["KeyS", "ArrowDown"]);
    expect(DEFAULT_BINDINGS.steerLeft).toEqual(["KeyA", "ArrowLeft"]);
    expect(DEFAULT_BINDINGS.shiftUp).toEqual(["KeyQ"]);
    expect(DEFAULT_BINDINGS.shiftDown).toEqual(["KeyZ"]);
    expect(DEFAULT_BINDINGS.reverse).toEqual(["Digit5"]);
    expect(DEFAULT_BINDINGS.deploy).toEqual(["ShiftLeft", "ShiftRight"]);
  });

  it("sensitivity defaults are neutral", () => {
    expect(DEFAULT_SETTINGS.steerSensitivity).toBe(1);
    expect(DEFAULT_SETTINGS.steerDeadzone).toBe(0);
    expect(DEFAULT_SETTINGS.invertSteering).toBe(false);
    // A neutral steer must pass through completely untouched.
    for (const raw of [-1, -0.4, 0, 0.25, 1]) {
      expect(applySteerSettings(raw, DEFAULT_SETTINGS)).toBeCloseTo(raw, 12);
    }
  });
});

describe("validateBindings", () => {
  it("rejects an action left with no key", () => {
    const broken = { ...DEFAULT_BINDINGS, throttle: [] } as ControlBindings;
    const problems = validateBindings(broken);
    expect(problems).toContainEqual({ kind: "empty", action: "throttle" });
  });

  it("rejects a key claimed by two actions", () => {
    const broken = { ...DEFAULT_BINDINGS, brake: ["KeyW"] } as ControlBindings;
    const problems = validateBindings(broken);
    expect(problems).toContainEqual({
      kind: "duplicate",
      action: "brake",
      key: "KeyW",
      owner: "throttle",
    });
  });

  it("is case-insensitive about the clash", () => {
    // A hand-edited "keyw" must not slip past and bind two actions at once.
    const broken = { ...DEFAULT_BINDINGS, brake: ["keyw"] } as ControlBindings;
    expect(validateBindings(broken)).toHaveLength(1);
  });

  it("reports every problem, not just the first, so a UI can mark them all", () => {
    const broken = {
      ...DEFAULT_BINDINGS,
      throttle: [],
      brake: ["KeyA"],
    } as ControlBindings;
    expect(validateBindings(broken).length).toBe(2);
  });
});

describe("normalizeBindings", () => {
  it("repairs a corrupt table back to something drivable", () => {
    const repaired = normalizeBindings({
      throttle: ["KeyW", "keyw", "", 7, null],
      brake: "not an array",
    });
    // The duplicate lowercase keyw is dropped, the junk entries are dropped.
    expect(repaired.throttle).toEqual(["KeyW"]);
    // brake was not an array, so it falls back to its default rather than
    // becoming unreachable.
    expect(repaired.brake).toEqual(DEFAULT_BINDINGS.brake);
    expect(bindingsAreValid(repaired)).toBe(true);
  });

  it("gives a key to its first claimant, not its last", () => {
    const repaired = normalizeBindings({
      throttle: ["KeyP"],
      brake: ["KeyP"],
    });
    expect(repaired.throttle).toEqual(["KeyP"]);
    expect(repaired.brake).toEqual(DEFAULT_BINDINGS.brake);
  });

  it("returns the defaults for junk input", () => {
    expect(normalizeBindings(null)).toEqual(DEFAULT_BINDINGS);
    expect(normalizeBindings("nope")).toEqual(DEFAULT_BINDINGS);
    expect(normalizeBindings(42)).toEqual(DEFAULT_BINDINGS);
  });

  it("keeps unknown actions out", () => {
    const repaired = normalizeBindings({ nonsense: ["KeyP"] });
    expect(Object.keys(repaired).sort()).toEqual([...CONTROL_ACTIONS].sort());
  });
});

describe("normalizeSettings", () => {
  it("clamps sensitivity into range and drops unknown keys", () => {
    expect(normalizeSettings({ steerSensitivity: 99 }).steerSensitivity).toBe(
      STEER_SENSITIVITY_MAX
    );
    expect(normalizeSettings({ steerSensitivity: -99 }).steerSensitivity).toBe(
      STEER_SENSITIVITY_MIN
    );
    expect(normalizeSettings({ steerDeadzone: 5 }).steerDeadzone).toBe(0.3);
    expect(normalizeSettings({ nonsense: true, invertSteering: true })).toEqual({
      ...DEFAULT_SETTINGS,
      invertSteering: true,
    });
  });

  it("falls back to defaults for junk", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
  });

  it("only accepts the three real compounds", () => {
    expect(normalizeSettings({ defaultCompound: "soft" }).defaultCompound).toBe("soft");
    expect(normalizeSettings({ defaultCompound: "wet" }).defaultCompound).toBe("medium");
  });
});

describe("applySteerSettings", () => {
  it("scales by sensitivity, keeping the sign and the clamp", () => {
    const settings = { ...DEFAULT_SETTINGS, steerSensitivity: 1.5 };
    expect(applySteerSettings(0.5, settings)).toBeCloseTo(0.75, 12);
    expect(applySteerSettings(-0.5, settings)).toBeCloseTo(-0.75, 12);
    // Beyond 1.0 it saturates rather than exceeding full lock.
    expect(applySteerSettings(1, settings)).toBe(1);
  });

  it("treats the deadzone as a SCALE, so full lock is still reachable", () => {
    const settings = { ...DEFAULT_SETTINGS, steerDeadzone: 0.3 };
    // Inside the deadzone: nothing.
    expect(applySteerSettings(0.2, settings)).toBe(0);
    expect(applySteerSettings(-0.2, settings)).toBe(0);
    // Just outside: a small but non-zero steer, not a jump to full lock.
    const just = applySteerSettings(0.35, settings);
    expect(just).toBeGreaterThan(0);
    expect(just).toBeLessThan(0.1);
    // And the extremes are still exactly full lock - the thing a plain
    // threshold would cost you.
    expect(applySteerSettings(1, settings)).toBeCloseTo(1, 12);
    expect(applySteerSettings(-1, settings)).toBeCloseTo(-1, 12);
  });

  it("inverts when asked, and inverts after the deadzone", () => {
    const settings = { ...DEFAULT_SETTINGS, invertSteering: true, steerDeadzone: 0.2 };
    expect(applySteerSettings(1, settings)).toBeCloseTo(-1, 12);
  });

  it("is total for a non-finite input", () => {
    expect(applySteerSettings(Number.NaN, DEFAULT_SETTINGS)).toBe(0);
    expect(applySteerSettings(99, DEFAULT_SETTINGS)).toBe(1);
    expect(applySteerSettings(-99, DEFAULT_SETTINGS)).toBe(-1);
  });
});

describe("the runtime control store", () => {
  it("starts on the defaults and installs a valid rebind", () => {
    resetControls();
    expect(getBindings()).toEqual(DEFAULT_BINDINGS);
    const next = { ...DEFAULT_BINDINGS, throttle: ["Digit7"] } as ControlBindings;
    expect(setBindings(next)).toBe(true);
    expect(getBindings().throttle).toEqual(["Digit7"]);
  });

  it("REFUSES an invalid table and keeps the current one", () => {
    // A half-applied rebind - one action emptied, or a key stolen - would
    // silently change the controls mid-corner, so the whole table is rejected.
    resetControls();
    const good = { ...DEFAULT_BINDINGS, throttle: ["Digit7"] } as ControlBindings;
    setBindings(good);
    const broken = { ...good, brake: ["Digit7"] } as ControlBindings;
    expect(setBindings(broken)).toBe(false);
    expect(getBindings()).toEqual(good);
    resetControls();
  });

  it("notifies subscribers and can be unsubscribed", () => {
    resetControls();
    let calls = 0;
    const off = subscribeToControls(() => {
      calls++;
    });
    setControlSettings({ ...DEFAULT_SETTINGS, steerSensitivity: 1.2 });
    expect(calls).toBe(1);
    off();
    setControlSettings(DEFAULT_SETTINGS);
    expect(calls).toBe(1);
  });

  it("normalizes settings on the way in, so the store is always in range", () => {
    setControlSettings({ ...DEFAULT_SETTINGS, steerSensitivity: 500 });
    expect(getControlSettings().steerSensitivity).toBe(STEER_SENSITIVITY_MAX);
    resetControls();
  });
});

describe("local persistence", () => {
  it("round-trips through storage", () => {
    const storage = fakeStorage();
    const controls = defaultControls();
    expect(saveLocalControls(storage, controls)).toBe(true);
    const loaded = loadLocalControls(storage)!;
    expect(loaded.bindings).toEqual(controls.bindings);
    expect(loaded.settings).toEqual(controls.settings);
  });

  it("returns null with no storage and no stored value", () => {
    expect(loadLocalControls(null)).toBeNull();
    expect(loadLocalControls(fakeStorage())).toBeNull();
  });

  it("treats corrupt JSON as nothing stored rather than throwing", () => {
    expect(loadLocalControls(fakeStorage("{not json"))).toBeNull();
  });

  it("repairs a corrupt stored value instead of loading it raw", () => {
    const storage = fakeStorage(
      JSON.stringify({ bindings: { throttle: "nope" }, settings: { steerDeadzone: 9 } })
    );
    const loaded = loadLocalControls(storage)!;
    expect(loaded.bindings).toEqual(DEFAULT_BINDINGS);
    expect(loaded.settings.steerDeadzone).toBe(0.3);
  });

  it("reports a failed write rather than pretending it saved", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(saveLocalControls(throwing, defaultControls())).toBe(false);
  });

  it("applies a stored set to the live tables", () => {
    resetControls();
    applyControls({
      bindings: { ...DEFAULT_BINDINGS, throttle: ["Digit7"] },
      settings: { ...DEFAULT_SETTINGS, steerSensitivity: 1.4 },
    });
    expect(getBindings().throttle).toEqual(["Digit7"]);
    expect(getControlSettings().steerSensitivity).toBe(1.4);
    resetControls();
  });
});

describe("the account row", () => {
  const controls: StoredControlsPayload = defaultControls();

  it("keys the row to the session's own user id", () => {
    const row = controlSettingsRow(SESSION, controls)!;
    expect(row.user_id).toBe(SESSION.userId);
  });

  it("is null with no session - that is not a failure", () => {
    expect(controlSettingsRow(null, controls)).toBeNull();
  });

  it("normalizes what it stores, so a bad local value cannot be written", () => {
    const row = controlSettingsRow(SESSION, {
      bindings: { ...DEFAULT_BINDINGS, throttle: [] } as ControlBindings,
      settings: { ...DEFAULT_SETTINGS, steerSensitivity: 900 },
    })!;
    expect(row.bindings.throttle).toEqual(DEFAULT_BINDINGS.throttle);
    expect(row.settings.steerSensitivity).toBe(STEER_SENSITIVITY_MAX);
  });

  it("maps a fetched row back, normalizing on the way in", () => {
    const parsed = controlSettingsFromRow({
      bindings: { throttle: ["Digit7"] },
      settings: { steerDeadzone: 99 },
    })!;
    expect(parsed.bindings.throttle).toEqual(["Digit7"]);
    expect(parsed.settings.steerDeadzone).toBe(0.3);
  });

  it("treats a row with nothing in it as nothing stored", () => {
    // The important one: "no settings saved" must not look like "the account
    // has blank settings", or the caller would wipe the player's controls.
    expect(controlSettingsFromRow({})).toBeNull();
    expect(controlSettingsFromRow({ user_id: SESSION.userId })).toBeNull();
    expect(controlSettingsFromRow(null)).toBeNull();
  });
});

describe("syncing with an account", () => {
  const controls = defaultControls();
  const config = { url: "https://x.supabase.co", publishableKey: "anon" };

  function stubFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("pushes with the player's JWT, not the publishable key", async () => {
    const stub = stubFetch(201, null);
    const ok = await pushControlSettings(
      { session: SESSION, config, transport: { fetchImpl: stub.fetchImpl } },
      controls
    );
    expect(ok).toBe(true);
    const headers = stub.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SESSION.accessToken}`);
    expect(headers.apikey).toBe("anon");
    expect(JSON.stringify(headers)).not.toMatch(/service_role|secret/i);
    // UPSERT, so first save and update are one path.
    expect(headers.Prefer).toContain("merge-duplicates");
    const body = JSON.parse(String(stub.calls[0].init.body));
    expect(body.user_id).toBe(SESSION.userId);
  });

  it("pulls scoped to the session's own id", async () => {
    const stub = stubFetch(200, [
      { bindings: { throttle: ["Digit7"] }, settings: { steerDeadzone: 0.1 } },
    ]);
    const pulled = await pullControlSettings({
      session: SESSION,
      config,
      transport: { fetchImpl: stub.fetchImpl },
    });
    expect(pulled!.bindings.throttle).toEqual(["Digit7"]);
    expect(stub.calls[0].url).toContain(`user_id=eq.${SESSION.userId}`);
  });

  it("is a no-op with no session, and never touches the network", async () => {
    const stub = stubFetch(201, null);
    expect(
      await pushControlSettings({ session: null, config, transport: { fetchImpl: stub.fetchImpl } }, controls)
    ).toBe(false);
    expect(await pullControlSettings({ session: null, config, transport: { fetchImpl: stub.fetchImpl } })).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("degrades to false/null on every failure rather than throwing", async () => {
    for (const status of [401, 403, 500]) {
      const stub = stubFetch(status, { message: "nope" });
      expect(
        await pushControlSettings({ session: SESSION, config, transport: { fetchImpl: stub.fetchImpl } }, controls)
      ).toBe(false);
      expect(
        await pullControlSettings({ session: SESSION, config, transport: { fetchImpl: stub.fetchImpl } })
      ).toBeNull();
    }
    const thrower = (() => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(
      await pushControlSettings({ session: SESSION, config, transport: { fetchImpl: thrower } }, controls)
    ).toBe(false);
  });

  it("is a no-op with no configuration", async () => {
    const stub = stubFetch(201, null);
    expect(
      await pushControlSettings({ session: SESSION, config: null, transport: { fetchImpl: stub.fetchImpl } }, controls)
    ).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("pushes then pulls, so a disagreement is visible rather than assumed away", async () => {
    // The read-back is the only way to know the write actually landed - a
    // policy could reject it silently.
    const stub = stubFetch(200, [
      { bindings: DEFAULT_BINDINGS, settings: { steerSensitivity: 1.1 } },
    ]);
    const result = await syncControlSettings(
      { session: SESSION, config, transport: { fetchImpl: stub.fetchImpl } },
      controls
    );
    expect(result.pushed).toBe(true);
    expect(result.pulled!.settings.steerSensitivity).toBe(1.1);
    expect(stub.calls.length).toBe(2);
  });
});

describe("formatKeyCode", () => {
  it("turns codes into something readable on a button", () => {
    expect(formatKeyCode("KeyW")).toBe("W");
    expect(formatKeyCode("Digit5")).toBe("5");
    expect(formatKeyCode("ShiftLeft")).toBe("L Shift");
    expect(formatKeyCode("ArrowUp")).toBe("Up");
    expect(formatKeyCode("Space")).toBe("Space");
    expect(formatKeyCode("Numpad3")).toBe("Num 3");
  });
});
