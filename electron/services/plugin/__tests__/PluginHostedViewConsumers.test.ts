import { describe, expect, it, vi } from "vitest";
import { PluginHostedViewConsumers } from "../PluginHostedViewConsumers.js";

const OWNERS: Record<string, string> = {
  "plugin-view:acme/prefs": "acme",
  "plugin-view:acme/side": "acme",
  "other.panel": "other",
};
const ownerOf = (viewId: string): string | undefined => OWNERS[viewId];

function watcher() {
  let forget: (() => void) | null = null;
  const unwatch = vi.fn();
  const watch = vi.fn((cb: () => void) => {
    forget = cb;
    return unwatch;
  });
  return { watch, unwatch, gone: () => forget?.() };
}

describe("PluginHostedViewConsumers", () => {
  it("counts a plugin's mounts across renderers, by main's owner and never another plugin's", () => {
    const consumers = new PluginHostedViewConsumers(() => {});
    consumers.record(1, watcher().watch, ["plugin-view:acme/prefs", "other.panel"]);
    consumers.record(2, watcher().watch, ["plugin-view:acme/prefs", "plugin-view:acme/side"]);
    consumers.record(3, watcher().watch, ["plugin-view:unknown/x"]);

    expect(consumers.count("acme", ownerOf)).toBe(3);
    expect(consumers.count("other", ownerOf)).toBe(1);
    expect(consumers.count("unknown", ownerOf)).toBe(0);
  });

  it("counts the same view mounted twice in one renderer twice", () => {
    const consumers = new PluginHostedViewConsumers(() => {});
    const w = watcher();
    consumers.record(1, w.watch, ["plugin-view:acme/prefs", "plugin-view:acme/prefs"]);
    expect(consumers.count("acme", ownerOf)).toBe(2);
    consumers.record(1, w.watch, ["plugin-view:acme/prefs"]);
    expect(consumers.count("acme", ownerOf)).toBe(1);
  });

  it("replaces a renderer's report wholesale and forgets it on an empty one", () => {
    const consumers = new PluginHostedViewConsumers(() => {});
    const w = watcher();
    consumers.record(1, w.watch, ["plugin-view:acme/prefs", "plugin-view:acme/side"]);
    consumers.record(1, w.watch, ["plugin-view:acme/side"]);
    expect(consumers.count("acme", ownerOf)).toBe(1);
    // One watch per report lifetime, not per report.
    expect(w.watch).toHaveBeenCalledTimes(1);

    consumers.record(1, w.watch, []);
    expect(consumers.count("acme", ownerOf)).toBe(0);
    expect(w.unwatch).toHaveBeenCalledTimes(1);
  });

  it("forgets a renderer whose document went away, and says which views that closed", () => {
    const onChanged = vi.fn();
    const consumers = new PluginHostedViewConsumers(onChanged);
    const w = watcher();
    consumers.record(1, w.watch, ["plugin-view:acme/prefs"]);
    onChanged.mockClear();

    w.gone();
    expect(consumers.count("acme", ownerOf)).toBe(0);
    expect(w.unwatch).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(["plugin-view:acme/prefs"]);
  });

  it("names both the closed and the opened views of a replaced report", () => {
    const onChanged = vi.fn();
    const consumers = new PluginHostedViewConsumers(onChanged);
    consumers.record(1, watcher().watch, ["plugin-view:acme/prefs"]);
    consumers.record(1, watcher().watch, ["other.panel"]);
    expect(onChanged).toHaveBeenLastCalledWith(["plugin-view:acme/prefs", "other.panel"]);
  });

  it("stays silent for an empty report from a renderer that had nothing mounted", () => {
    const onChanged = vi.fn();
    const consumers = new PluginHostedViewConsumers(onChanged);
    const w = watcher();
    consumers.record(1, w.watch, []);
    expect(onChanged).not.toHaveBeenCalled();
    expect(w.watch).not.toHaveBeenCalled();
  });

  it("drops malformed and oversized entries rather than the whole report", () => {
    const consumers = new PluginHostedViewConsumers(() => {});
    consumers.record(1, watcher().watch, [
      "plugin-view:acme/prefs",
      42,
      "",
      "x".repeat(513),
      null,
    ] as unknown);
    const resolver = vi.fn(ownerOf);
    expect(consumers.count("acme", resolver)).toBe(1);
    // Only the valid id is held; nothing else ever reaches ownership.
    expect(resolver.mock.calls).toEqual([["plugin-view:acme/prefs"]]);

    const w = watcher();
    consumers.record(2, w.watch, "not-an-array" as unknown);
    expect(w.watch).not.toHaveBeenCalled();
  });

  it("holds at most a thousand mounts from one renderer", () => {
    const consumers = new PluginHostedViewConsumers(() => {});
    consumers.record(1, watcher().watch, Array(1_500).fill("plugin-view:acme/prefs"));
    expect(consumers.count("acme", ownerOf)).toBe(1_000);
  });

  it("releases every watch on dispose", () => {
    const consumers = new PluginHostedViewConsumers(() => {});
    const a = watcher();
    const b = watcher();
    consumers.record(1, a.watch, ["plugin-view:acme/prefs"]);
    consumers.record(2, b.watch, ["other.panel"]);
    consumers.dispose();
    expect(a.unwatch).toHaveBeenCalledTimes(1);
    expect(b.unwatch).toHaveBeenCalledTimes(1);
    expect(consumers.count("acme", ownerOf)).toBe(0);
  });
});
