import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/lib/ttlCache";

describe("TtlCache", () => {
  it("expires entries after their own TTL", () => {
    let t = 0;
    const c = new TtlCache<string>(10, () => t);
    c.set("a", "A", 100);
    c.set("b", "B", 1000);
    t = 99;
    expect(c.get("a")).toBe("A");
    t = 100;
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe("B");
    expect(c.size).toBe(1);
  });

  it("never holds more than its cap, dropping expired then least recently used entries", () => {
    let t = 0;
    const c = new TtlCache<number>(3, () => t);
    c.set("old", 0, 10);
    c.set("a", 1, 1000);
    c.set("b", 2, 1000);
    t = 20;
    c.set("c", 3, 1000); // "old" has expired: it goes first
    expect(c.size).toBe(3);
    expect(c.get("a")).toBe(1); // a is now the most recently used
    c.set("d", 4, 1000);
    expect(c.get("b")).toBeUndefined();
    expect([c.get("a"), c.get("c"), c.get("d")]).toEqual([1, 3, 4]);
    for (let i = 0; i < 1000; i++) c.set(`k${i}`, i, 1000);
    expect(c.size).toBe(3);
  });

  it("deleteIf leaves a newer value in place", () => {
    const c = new TtlCache<string>(5);
    c.set("k", "first", 1000);
    c.set("k", "second", 1000);
    c.deleteIf("k", "first");
    expect(c.get("k")).toBe("second");
    c.deleteIf("k", "second");
    expect(c.get("k")).toBeUndefined();
  });
});
