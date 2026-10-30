import { describe, expect, it } from "vitest";
import { nextStack, popStack } from "../src/lib/navStack";

type R = { name: string; ep?: number };
const names = (s: R[]) => s.map((r) => (r.ep ? `${r.name}${r.ep}` : r.name));

describe("view stack", () => {
  it("stacks player, detail and search; other views start over", () => {
    let s: R[] = [{ name: "home" }];
    s = nextStack(s, { name: "detail" });
    s = nextStack(s, { name: "player", ep: 1 });
    expect(names(s)).toEqual(["home", "detail", "player1"]);
    expect(names(nextStack(s, { name: "library" }))).toEqual(["library"]);
  });

  it("autoplayed episodes replace the current one, so Back leaves the player", () => {
    let s: R[] = [{ name: "home" }, { name: "detail" }, { name: "player", ep: 1 }];
    for (const ep of [2, 3, 4]) s = nextStack(s, { name: "player", ep }, true);
    expect(names(s)).toEqual(["home", "detail", "player4"]);
    expect(names(popStack(s))).toEqual(["home", "detail"]);
  });

  it("never pops the last view", () => {
    expect(names(popStack([{ name: "home" }]))).toEqual(["home"]);
  });
});
