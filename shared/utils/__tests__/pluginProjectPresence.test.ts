import { describe, expect, it } from "vitest";
import { toPluginProjectPresence } from "../pluginProjectPresence.js";

describe("toPluginProjectPresence", () => {
  it("rebuilds a cloned presence frozen, keeping only its two fields", () => {
    const presence = toPluginProjectPresence({
      projectId: "p",
      state: "background",
      path: "/Users/someone/secret",
    });

    expect(presence).toStrictEqual({ projectId: "p", state: "background" });
    expect(Object.isFrozen(presence)).toBe(true);
  });

  it.each([
    null,
    "foreground",
    { projectId: "", state: "foreground" },
    { projectId: 7, state: "foreground" },
    { projectId: "p", state: "hidden" },
    { projectId: "p" },
  ])("refuses %j", (value) => {
    expect(toPluginProjectPresence(value)).toBeNull();
  });
});
