import { describe, expect, it } from "vitest";
import {
  PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX,
  PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX,
} from "../../types/plugin.js";
import {
  sameWorktreeCardStatus,
  validatePluginWorktreeCardStatus,
} from "../pluginWorktreeCardStatus.js";

describe("validatePluginWorktreeCardStatus", () => {
  it("accepts a label and a tooltip, trimmed, as a fresh copy", () => {
    const input = { label: "  2 containers ", tooltip: " api, db \n" };
    const result = validatePluginWorktreeCardStatus("/repo/wt", input);
    expect(result).toEqual({
      ok: true,
      worktreeId: "/repo/wt",
      status: { label: "2 containers", tooltip: "api, db" },
    });
    expect(result.ok && result.status).not.toBe(input);
  });

  it("treats null and undefined as a clear", () => {
    expect(validatePluginWorktreeCardStatus("/wt", null)).toEqual({
      ok: true,
      worktreeId: "/wt",
      status: null,
    });
    expect(validatePluginWorktreeCardStatus("/wt", undefined)).toEqual({
      ok: true,
      worktreeId: "/wt",
      status: null,
    });
  });

  it("drops an empty tooltip rather than storing it", () => {
    const result = validatePluginWorktreeCardStatus("/wt", { label: "ok", tooltip: "   " });
    expect(result).toEqual({ ok: true, worktreeId: "/wt", status: { label: "ok" } });
  });

  it("keeps a multi-line tooltip", () => {
    const result = validatePluginWorktreeCardStatus("/wt", { label: "ok", tooltip: "a\nb" });
    expect(result.ok && result.status?.tooltip).toBe("a\nb");
  });

  it.each([
    ["an empty worktree id", "", { label: "x" }, "worktreeId"],
    ["a non-string worktree id", 7, { label: "x" }, "worktreeId"],
    ["a non-object status", "/wt", "busy", "status must be an object"],
    ["an array status", "/wt", ["x"], "status must be an object"],
    ["a missing label", "/wt", {}, "label must be a string"],
    ["a blank label", "/wt", { label: "   " }, "must not be empty"],
    ["a multi-line label", "/wt", { label: "a\nb" }, "single line"],
    ["an unknown field", "/wt", { label: "x", color: "red" }, 'unsupported field "color"'],
    ["a non-string tooltip", "/wt", { label: "x", tooltip: 3 }, "tooltip must be a string"],
  ])("rejects %s", (_name, worktreeId, status, message) => {
    const result = validatePluginWorktreeCardStatus(worktreeId, status);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it("enforces the label and tooltip limits at the boundary", () => {
    const label = "x".repeat(PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX);
    expect(validatePluginWorktreeCardStatus("/wt", { label }).ok).toBe(true);
    expect(validatePluginWorktreeCardStatus("/wt", { label: `${label}x` }).ok).toBe(false);

    const tooltip = "y".repeat(PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX);
    expect(validatePluginWorktreeCardStatus("/wt", { label: "ok", tooltip }).ok).toBe(true);
    expect(validatePluginWorktreeCardStatus("/wt", { label: "ok", tooltip: `${tooltip}y` }).ok).toBe(
      false
    );
  });
});

describe("sameWorktreeCardStatus", () => {
  it("compares label and tooltip", () => {
    expect(sameWorktreeCardStatus({ label: "a" }, { label: "a" })).toBe(true);
    expect(sameWorktreeCardStatus({ label: "a" }, { label: "a", tooltip: "t" })).toBe(false);
    expect(sameWorktreeCardStatus(undefined, { label: "a" })).toBe(false);
  });
});
