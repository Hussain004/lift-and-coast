import { beforeEach, describe, expect, it } from "vitest";
import {
  GHOST_CHOICE_KEY,
  loadGhostChoice,
  saveGhostChoice,
  type GhostChoiceStorage,
} from "../lib/race/ghostPrefs";
import { ghostChoices } from "../lib/race/ghostSelection";

/** Roadmap 11.9: persisting which ghost you race. */

function memoryStorage(): GhostChoiceStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const choices = ghostChoices({ personalBestSeconds: 88.5, rivalGhost: null, worldRecordGhost: null });
const pb = choices.find((c) => c.id === "personal-best")!;
const rival = choices.find((c) => c.id === "rival")!;

describe("ghost choice persistence", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("round-trips an available choice", () => {
    saveGhostChoice(pb, storage);
    expect(storage.map.get(GHOST_CHOICE_KEY)).toBe("personal-best");
    expect(loadGhostChoice(storage)).toBe("personal-best");
  });

  it("refuses to persist an unavailable choice", () => {
    // The failure this prevents is invisible: an unavailable id in storage
    // resolves to a silent fallback on the next load, so the player would pick
    // "Rival", see it not apply, and have no way to tell whether the app or the
    // storage had lost it.
    saveGhostChoice(rival, storage);
    expect(storage.map.has(GHOST_CHOICE_KEY)).toBe(false);
    expect(loadGhostChoice(storage)).toBeNull();
  });

  it("clears the key when there is no ghost to race", () => {
    saveGhostChoice(pb, storage);
    saveGhostChoice(null, storage);
    expect(storage.map.has(GHOST_CHOICE_KEY)).toBe(false);
    expect(loadGhostChoice(storage)).toBeNull();
  });

  it("treats an unrecognised stored value as no choice", () => {
    // A choice removed in a later version, or junk. Trusting it would hand the
    // resolver an id it cannot match.
    storage.map.set(GHOST_CHOICE_KEY, "somebody-elses-lap");
    expect(loadGhostChoice(storage)).toBeNull();
  });

  it("survives storage that throws", () => {
    // Privacy modes throw on access, and a full quota throws on write. Neither
    // is worth failing a click over.
    const hostile: GhostChoiceStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadGhostChoice(hostile)).toBeNull();
    expect(() => saveGhostChoice(pb, hostile)).not.toThrow();
  });

  it("treats absent storage as no choice rather than throwing", () => {
    expect(loadGhostChoice(null)).toBeNull();
    expect(() => saveGhostChoice(pb, null)).not.toThrow();
  });
});
