import { describe, expect, it } from "vitest";
import { onShutdown, runShutdown } from "../src/lib/shutdown";

describe("shutdown hooks", () => {
  it("captures state before flushing, survives failing hooks, and can be unregistered", async () => {
    const order: string[] = [];
    const offs = [
      onShutdown(async () => void order.push("flush")),
      onShutdown(() => void order.push("capture"), "capture"),
      onShutdown(() => {
        throw new Error("boom");
      }),
      onShutdown(() => void order.push("removed")),
    ];
    offs[3]();
    await runShutdown();
    expect(order).toEqual(["capture", "flush"]);
    offs.forEach((f) => f());
  });

  it("does not wait forever for a stuck hook", async () => {
    const off = onShutdown(() => new Promise(() => {}));
    const t = Date.now();
    await runShutdown(50);
    expect(Date.now() - t).toBeLessThan(1000);
    off();
  });
});
