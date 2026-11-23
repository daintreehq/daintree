import { describe, expect, it } from "vitest";
import {
  UNATTESTED_PLUGIN_ACTION_CONTEXT,
  parsePluginActionContext,
} from "../pluginActionContext.js";

describe("parsePluginActionContext (#16751)", () => {
  it("rebuilds a valid context as a fresh frozen object", () => {
    const sent = { dispatchSource: "agent", origin: "assistant", approval: "person" };
    const parsed = parsePluginActionContext(sent);
    expect(parsed).toEqual(sent);
    expect(parsed).not.toBe(sent);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("keeps the global Assistant's origin apart from the project Assistant's (#18153)", () => {
    const sent = { dispatchSource: "agent", origin: "global-assistant", approval: "person" };
    const parsed = parsePluginActionContext(sent);
    expect(parsed).toEqual(sent);
    expect(parsed).not.toBe(sent);
    expect(Object.isFrozen(parsed)).toBe(true);
    // A standing answer let it through: who asked, and no approval.
    expect(
      parsePluginActionContext({ dispatchSource: "agent", origin: "global-assistant" })
    ).toEqual({ dispatchSource: "agent", origin: "global-assistant" });
  });

  it.each(
    (["user", "keybinding", "menu", "context-menu", "plugin"] as const).flatMap((source) =>
      (["assistant", "global-assistant"] as const).map((origin) => [origin, source] as const)
    )
  )("refuses the %s origin on a %s dispatch", (origin, dispatchSource) => {
    expect(() => parsePluginActionContext({ dispatchSource, origin })).toThrow();
  });

  it("leaves out the optional fields a context doesn't carry", () => {
    expect(Object.keys(parsePluginActionContext({ dispatchSource: "menu" }))).toEqual([
      "dispatchSource",
    ]);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an unknown field", { dispatchSource: "user", hostConfirmed: true }],
    ["an unknown source", { dispatchSource: "assistant" }],
    ["a non-literal origin", { dispatchSource: "agent", origin: "help" }],
    ["a non-literal approval", { dispatchSource: "agent", approval: "skip-preference" }],
    ["an origin off the agent source", { dispatchSource: "context-menu", origin: "assistant" }],
    [
      "a global origin off the agent source",
      { dispatchSource: "plugin", origin: "global-assistant" },
    ],
    ["an approval on a plugin dispatch", { dispatchSource: "plugin", approval: "person" }],
  ])("refuses %s", (_label, raw) => {
    expect(() => parsePluginActionContext(raw)).toThrow();
  });

  it("keeps the unattested context claiming nothing, and passes its own check", () => {
    expect(UNATTESTED_PLUGIN_ACTION_CONTEXT).not.toHaveProperty("origin");
    expect(UNATTESTED_PLUGIN_ACTION_CONTEXT).not.toHaveProperty("approval");
    expect(Object.isFrozen(UNATTESTED_PLUGIN_ACTION_CONTEXT)).toBe(true);
    expect(parsePluginActionContext(UNATTESTED_PLUGIN_ACTION_CONTEXT)).toEqual(
      UNATTESTED_PLUGIN_ACTION_CONTEXT
    );
  });
});
