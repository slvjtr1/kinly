import { describe, expect, it } from "vitest";
import { closest, isBackKey, navScore, pickNext, type Box } from "../src/lib/spatialNav";

const box = (left: number, top: number, w = 100, h = 150): Box => ({ left, top, right: left + w, bottom: top + h });

// Two rows of posters (100×150, 20px apart), a top bar above them.
const row1 = [0, 120, 240, 360].map((x) => box(x, 200));
const row2 = [0, 120, 240, 360].map((x) => box(x, 400));
const topbar = [box(0, 0, 60, 40), box(300, 0, 60, 40)];
const all = [...row1, ...row2, ...topbar].map((b, i) => ({ box: b, item: i }));
const from = (i: number) => all[i].box;
const others = (i: number) => all.filter((c) => c.item !== i);

describe("spatial navigation", () => {
  it("moves along a row", () => {
    expect(pickNext(from(1), others(1), "right")).toBe(2);
    expect(pickNext(from(1), others(1), "left")).toBe(0);
  });

  it("stops at the end of a row instead of jumping to the next one", () => {
    expect(pickNext(from(3), others(3), "right")).toBeNull();
    expect(pickNext(from(0), others(0), "left")).toBeNull();
  });

  it("moves between rows to the item in line, not the nearest diagonal", () => {
    expect(pickNext(from(2), others(2), "down")).toBe(6);
    expect(pickNext(from(6), others(6), "up")).toBe(2);
  });

  it("goes up from the first row to the top bar, picking the closest in line", () => {
    expect(pickNext(from(0), others(0), "up")).toBe(8);
    expect(pickNext(from(3), others(3), "up")).toBe(9);
  });

  it("returns null when nothing is in that direction", () => {
    expect(pickNext(from(5), others(5), "down")).toBeNull();
    expect(pickNext(box(0, 0), [], "down")).toBeNull();
  });

  it("prefers an overlapping item over a closer one off to the side", () => {
    const start = box(0, 0, 100, 40);
    const inLine = { box: box(0, 300, 100, 40), item: "in line" };
    const aside = { box: box(400, 60, 100, 40), item: "aside" };
    expect(pickNext(start, [aside, inLine], "down")).toBe("in line");
  });

  it("does not treat an element beside it as being below it", () => {
    expect(navScore(box(0, 0), box(120, 10), "down")).toBeNull();
    expect(navScore(box(0, 0), box(120, 10), "right")).not.toBeNull();
  });

  it("handles items wider than the focused one (a full-width button under a row)", () => {
    const wide = { box: box(0, 600, 480, 40), item: 99 };
    expect(pickNext(from(3), [wide, ...others(3)], "down")).toBe(7);
    expect(pickNext(from(7), [wide, ...others(7)], "down")).toBe(99);
  });

  it("finds the element closest to a vanished one", () => {
    expect(closest(box(250, 210), others(-1))).toBe(2);
    expect(closest(box(0, 0), [])).toBeNull();
  });

  it("recognises remote Back keys", () => {
    expect(isBackKey({ key: "Escape", keyCode: 27 })).toBe(true);
    expect(isBackKey({ key: "GoBack", keyCode: 0 })).toBe(true);
    expect(isBackKey({ key: "BrowserBack", keyCode: 166 })).toBe(true);
    expect(isBackKey({ key: "Unidentified", keyCode: 461 })).toBe(true);
    expect(isBackKey({ key: "Enter", keyCode: 13 })).toBe(false);
  });
});
