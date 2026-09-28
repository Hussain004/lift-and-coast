import { describe, expect, it } from "vitest";
import {
  compactTowerRows,
  createHudSnapshot,
  formatGap,
  formatRaceTime,
  pushHudEvent,
  towerGapLabel,
  tyreWear01,
} from "../lib/race/hud";
import { computeFullMapTransform } from "../lib/tracks/minimap";

describe("hud formatting", () => {
  it("formats gaps and race times", () => {
    expect(formatGap(1.234, 3)).toBe("+1.234");
    expect(formatGap(-0.5, 1)).toBe("-0.5");
    expect(formatGap(null)).toBe("");
    expect(formatRaceTime(83.4567)).toBe("1:23.457");
    expect(formatRaceTime(3725.1)).toBe("1:02:05.100");
    expect(formatRaceTime(null)).toBe("--:--.---");
  });

  it("labels tower gaps like the broadcast", () => {
    expect(towerGapLabel(null, 0)).toBe("LEADER");
    expect(towerGapLabel(3.21, 0)).toBe("+3.2");
    expect(towerGapLabel(95, 1)).toBe("+1 LAP");
    expect(towerGapLabel(200, 2)).toBe("+2 LAPS");
  });

  it("measures tyre wear against the compound's life", () => {
    expect(tyreWear01("soft", 0)).toBe(0);
    expect(tyreWear01("soft", 2 * 5891)).toBeCloseTo(1, 5);
    expect(tyreWear01("hard", 2 * 5891)).toBeCloseTo(0.2, 5);
    expect(tyreWear01("medium", 1e9)).toBe(1);
  });
});

describe("compact tower", () => {
  it("shows everyone in a small field", () => {
    expect(compactTowerRows(4, 2)).toEqual([0, 1, 2, 3]);
  });
  it("keeps the leader and centres on the player", () => {
    expect(compactTowerRows(20, 10)).toEqual([0, 8, 9, 10, 11]);
    expect(compactTowerRows(20, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(compactTowerRows(20, 19)).toEqual([0, 16, 17, 18, 19]);
    expect(compactTowerRows(20, 1)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("hud events", () => {
  it("queues with unique ids and stays bounded", () => {
    const hud = createHudSnapshot();
    for (let i = 0; i < 40; i++) pushHudEvent(hud, "info", `E${i}`);
    expect(hud.events.length).toBe(24);
    expect(hud.events[23].title).toBe("E39");
    expect(new Set(hud.events.map((e) => e.id)).size).toBe(24);
  });
});

describe("full track map", () => {
  it("fits the whole centreline inside the box with its padding", () => {
    const track = { centerline: [[-500, 0, 100], [1500, 0, 100], [1500, 0, 900], [-500, 0, 900]] as [number, number, number][] };
    const { transform, scale } = computeFullMapTransform(track, 200, 10);
    expect(scale).toBeCloseTo(0.09, 6);
    const [, tx, ty] = transform.match(/translate\(([-\d.]+),([-\d.]+)\)/)!.map(Number);
    const project = (x: number, z: number) => [tx + x * scale, ty + z * scale];
    expect(project(-500, 100)[0]).toBeCloseTo(10, 1);
    expect(project(1500, 100)[0]).toBeCloseTo(190, 1);
    // Shorter axis is centred.
    const top = project(0, 100)[1];
    const bottom = project(0, 900)[1];
    expect(top + bottom).toBeCloseTo(200, 1);
  });
});
