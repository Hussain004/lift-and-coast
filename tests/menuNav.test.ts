import { describe, expect, it } from "vitest";
import { padDirection, pickNavTarget, shouldRepeat, type NavRect } from "../lib/input/menuNav";

const r = (x: number, y: number, width = 100, height = 40): NavRect => ({ x, y, width, height });

describe("spatial menu navigation", () => {
  // A vertical menu at x=0 and a two-column grid to its right.
  const items = [r(0, 0), r(0, 50), r(0, 100), r(200, 0), r(320, 0), r(200, 50), r(320, 50)];

  it("moves down a column to the next row, not a nearer diagonal", () => {
    expect(pickNavTarget(items[0], items, "down")).toBe(1);
    expect(pickNavTarget(items[1], items, "down")).toBe(2);
    expect(pickNavTarget(items[3], items, "down")).toBe(5);
  });

  it("moves across into the grid and along a row", () => {
    expect(pickNavTarget(items[0], items, "right")).toBe(3);
    expect(pickNavTarget(items[3], items, "right")).toBe(4);
    expect(pickNavTarget(items[5], items, "left")).toBe(1);
  });

  it("returns -1 at an edge", () => {
    expect(pickNavTarget(items[0], items, "up")).toBe(-1);
    expect(pickNavTarget(items[4], items, "right")).toBe(-1);
  });
});

describe("gamepad direction", () => {
  const released = Array.from({ length: 17 }, () => ({ pressed: false }));
  it("reads the D-pad before the stick", () => {
    const b = released.map((x, i) => ({ pressed: i === 13 }));
    expect(padDirection(b, [0.9, 0])).toBe("down");
  });
  it("reads the stick past its threshold, dominant axis wins", () => {
    expect(padDirection(released, [0.2, -0.8])).toBe("up");
    expect(padDirection(released, [-0.9, 0.7])).toBe("left");
    expect(padDirection(released, [0.3, 0.3])).toBeNull();
  });
  it("repeats only after the hold delay, at the repeat rate", () => {
    expect(shouldRepeat(200, 0, 200)).toBe(false);
    expect(shouldRepeat(400, 300, 400)).toBe(false);
    expect(shouldRepeat(500, 300, 430)).toBe(true);
  });
});
