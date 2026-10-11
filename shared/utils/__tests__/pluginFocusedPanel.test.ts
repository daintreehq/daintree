import { describe, expect, expectTypeOf, it } from "vitest";
import { BUILT_IN_PANEL_KINDS, type BuiltInPanelKind } from "../../config/panelKindRegistry.js";
import type { PluginFocusedPanelKind } from "../../types/plugin.js";
import {
  NO_FOCUSED_PANEL,
  pluginFocusedPanelEquals,
  toPluginFocusedPanel,
  toPluginFocusedPanelKind,
} from "../pluginFocusedPanel.js";

describe("PluginFocusedPanelKind", () => {
  it("spells out exactly the built-in panel kinds, plus plugin and portal", () => {
    expectTypeOf<
      Exclude<PluginFocusedPanelKind, "plugin" | "portal">
    >().toEqualTypeOf<BuiltInPanelKind>();
  });
});

describe("toPluginFocusedPanelKind", () => {
  it.each(BUILT_IN_PANEL_KINDS.map((kind) => [kind]))("passes built-in %s through", (kind) => {
    expect(toPluginFocusedPanelKind(kind)).toBe(kind);
  });

  it.each([["acme.timeline"], ["project:abc/acme/timeline"], ["Terminal"]])(
    "collapses %s to plugin",
    (kind) => {
      expect(toPluginFocusedPanelKind(kind)).toBe("plugin");
    }
  );

  it.each([[null], [undefined], [""], [42]])("reads %s as no kind", (kind) => {
    expect(toPluginFocusedPanelKind(kind)).toBeNull();
  });
});

describe("toPluginFocusedPanel", () => {
  it("keeps only the allowlisted fields, frozen", () => {
    const focus = toPluginFocusedPanel({
      kind: "terminal",
      agent: true,
      worktreeId: "wt-1",
      title: "secret",
      cwd: "/home/me",
    });

    expect(focus).toStrictEqual({ kind: "terminal", agent: true, worktreeId: "wt-1" });
    expect(Object.isFrozen(focus)).toBe(true);
  });

  it("only lets a terminal carry the agent flag", () => {
    expect(toPluginFocusedPanel({ kind: "browser", agent: true }).agent).toBe(false);
    expect(toPluginFocusedPanel({ kind: "terminal", agent: "yes" }).agent).toBe(false);
  });

  it("never gives the Portal a worktree", () => {
    expect(toPluginFocusedPanel({ kind: "portal", worktreeId: "wt-1" }).worktreeId).toBeNull();
  });

  it("drops the worktree and agent flag when there is no kind", () => {
    expect(toPluginFocusedPanel({ kind: null, agent: true, worktreeId: "wt" })).toBe(
      NO_FOCUSED_PANEL
    );
    expect(toPluginFocusedPanel("terminal")).toBe(NO_FOCUSED_PANEL);
  });
});

describe("pluginFocusedPanelEquals", () => {
  it("compares every field", () => {
    const a = toPluginFocusedPanel({ kind: "terminal", agent: true, worktreeId: "w" });
    expect(pluginFocusedPanelEquals(a, { ...a })).toBe(true);
    expect(pluginFocusedPanelEquals(a, { ...a, agent: false })).toBe(false);
    expect(pluginFocusedPanelEquals(a, { ...a, worktreeId: "x" })).toBe(false);
    expect(pluginFocusedPanelEquals(a, { ...a, kind: "diff" })).toBe(false);
  });
});
