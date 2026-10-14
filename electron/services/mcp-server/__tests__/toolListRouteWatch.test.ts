import { describe, expect, it, vi } from "vitest";
import { ToolListRouteWatch } from "../toolListRouteWatch.js";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setup() {
  const notify = vi.fn();
  const routes = new Map<string, string>();
  const watch = new ToolListRouteWatch(notify);
  const list = (sessionId: string) =>
    watch.noteListed(sessionId, () => routes.get(sessionId) ?? "none");
  return { notify, routes, watch, list };
}

describe("ToolListRouteWatch", () => {
  it("tells a session whose route moved, and only that session", async () => {
    const { notify, routes, watch, list } = setup();
    routes.set("a", "none");
    routes.set("b", "local:7");
    list("a");
    list("b");

    routes.set("a", "remote:shell-1");
    watch.check();
    await flush();

    expect(notify.mock.calls).toEqual([["a"]]);
  });

  it("tells a session once per listing, however often the route flaps", async () => {
    const { notify, routes, watch, list } = setup();
    routes.set("a", "local:7");
    list("a");

    for (const route of ["remote:shell-1", "local:7", "none"]) {
      routes.set("a", route);
      watch.check();
      await flush();
    }
    expect(notify).toHaveBeenCalledTimes(1);

    // Listing again re-arms it from where it now is.
    list("a");
    routes.set("a", "local:9");
    watch.check();
    await flush();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("reads routes once for a burst of events", async () => {
    const { notify, routes, watch } = setup();
    const describe = vi.fn(() => routes.get("a") ?? "none");
    watch.noteListed("a", describe);
    describe.mockClear();

    routes.set("a", "remote:shell-1");
    watch.check();
    watch.check();
    watch.check();
    await flush();

    expect(describe).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("says nothing to a session that never listed, or was forgotten or cleared", async () => {
    const { notify, routes, watch, list } = setup();
    routes.set("a", "none");
    routes.set("b", "none");
    list("a");
    list("b");
    watch.forget("a");
    watch.clear();

    routes.set("a", "local:1");
    routes.set("b", "local:1");
    routes.set("c", "local:1");
    watch.check();
    await flush();

    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps checking the rest when one route cannot be read", async () => {
    const { notify, routes, watch, list } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let broken = false;
    watch.noteListed("a", () => {
      if (broken) throw new Error("bridge gone");
      return "none";
    });
    routes.set("b", "none");
    list("b");

    broken = true;
    routes.set("b", "local:3");
    watch.check();
    await flush();

    expect(notify.mock.calls).toEqual([["b"]]);
    warn.mockRestore();
  });
});
