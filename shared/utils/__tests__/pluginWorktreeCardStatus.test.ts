import { describe, expect, it } from "vitest";
import {
  PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX,
  PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX,
} from "../../types/plugin.js";
import {
  sameWorktreeCardStatus,
  validatePluginWorktreeCardStatus,
} from "../pluginWorktreeCardStatus.js";

/** An installed plugin, whose instance id is its manifest id. */
function vet(worktreeId: unknown, status: unknown) {
  return validatePluginWorktreeCardStatus(worktreeId, status, "acme.docker", "acme.docker");
}

describe("validatePluginWorktreeCardStatus", () => {
  it("accepts a label and a tooltip, trimmed, as a fresh copy", () => {
    const input = { label: "  2 containers ", tooltip: " api, db \n" };
    const result = vet("/repo/wt", input);
    expect(result).toEqual({
      ok: true,
      worktreeId: "/repo/wt",
      status: { label: "2 containers", tooltip: "api, db" },
    });
    expect(result.ok && result.status).not.toBe(input);
  });

  it("treats null and undefined as a clear", () => {
    expect(vet("/wt", null)).toEqual({
      ok: true,
      worktreeId: "/wt",
      status: null,
    });
    expect(vet("/wt", undefined)).toEqual({
      ok: true,
      worktreeId: "/wt",
      status: null,
    });
  });

  it("drops an empty tooltip rather than storing it", () => {
    const result = vet("/wt", { label: "ok", tooltip: "   " });
    expect(result).toEqual({ ok: true, worktreeId: "/wt", status: { label: "ok" } });
  });

  it("keeps a multi-line tooltip", () => {
    const result = vet("/wt", { label: "ok", tooltip: "a\nb" });
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
    const result = vet(worktreeId, status);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it("enforces the label and tooltip limits at the boundary", () => {
    const label = "x".repeat(PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX);
    expect(vet("/wt", { label }).ok).toBe(true);
    expect(vet("/wt", { label: `${label}x` }).ok).toBe(false);

    const tooltip = "y".repeat(PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX);
    expect(vet("/wt", { label: "ok", tooltip }).ok).toBe(true);
    expect(
      vet("/wt", { label: "ok", tooltip: `${tooltip}y` }).ok
    ).toBe(false);
  });
});

describe("validatePluginWorktreeCardStatus command", () => {
  it("accepts one of the plugin's own actions, in the same copy", () => {
    expect(vet("/wt", { label: "2 up", command: "acme.docker.showContainers" })).toEqual({
      ok: true,
      worktreeId: "/wt",
      status: { label: "2 up", command: "acme.docker.showContainers" },
    });
  });

  it("rewrites the command into a project instance's namespace", () => {
    const result = validatePluginWorktreeCardStatus(
      "/wt",
      { label: "Draft", tooltip: "PR draft", command: "acme.status.open" },
      "acme.status",
      "project__proj-a__acme.status"
    );
    expect(result).toEqual({
      ok: true,
      worktreeId: "/wt",
      status: { label: "Draft", tooltip: "PR draft", command: "project__proj-a__acme.status.open" },
    });
  });

  it("refuses an already-qualified instance id as authored input", () => {
    const result = validatePluginWorktreeCardStatus(
      "/wt",
      { label: "x", command: "project__proj-a__acme.status.open" },
      "acme.status",
      "project__proj-a__acme.status"
    );
    expect(result.ok).toBe(false);
  });

  it("treats a null command as absent", () => {
    expect(vet("/wt", { label: "x", command: null })).toEqual({
      ok: true,
      worktreeId: "/wt",
      status: { label: "x" },
    });
  });

  it.each([
    ["another plugin's action", "acme.other.open"],
    ["a built-in action", "worktree.delete"],
    ["the bare namespace", "acme.docker."],
    ["a near-miss prefix", "acme.dockerx.open"],
    ["an id with spaces", "acme.docker.open now"],
    ["an empty string", ""],
    ["a number", 7],
  ])("refuses %s", (_name, command) => {
    const result = vet("/wt", { label: "x", command });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("status.command");
    expect(!result.ok && result.error).toContain('written "acme.docker.<id>"');
  });

  it("refuses a command whose own namespace spells a built-in", () => {
    const result = validatePluginWorktreeCardStatus(
      "/wt",
      { label: "x", command: "worktree.delete" },
      "worktree",
      "worktree"
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("is a built-in action");
  });
});

describe("sameWorktreeCardStatus", () => {
  it("compares label, tooltip and command", () => {
    expect(sameWorktreeCardStatus({ label: "a" }, { label: "a" })).toBe(true);
    expect(sameWorktreeCardStatus({ label: "a" }, { label: "a", tooltip: "t" })).toBe(false);
    expect(sameWorktreeCardStatus({ label: "a" }, { label: "a", command: "p.x" })).toBe(false);
    expect(
      sameWorktreeCardStatus({ label: "a", command: "p.x" }, { label: "a", command: "p.y" })
    ).toBe(false);
    expect(sameWorktreeCardStatus(undefined, { label: "a" })).toBe(false);
  });
});
