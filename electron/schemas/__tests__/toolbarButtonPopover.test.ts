import { describe, it, expect } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

/**
 * A toolbar button opens a popover drawn around one of the plugin's own panel
 * views, as an alternative to dispatching an action (#13784). It does exactly
 * one of the two, and the view it names must be one a popover can mount.
 */

type ParseResult = ReturnType<ReturnType<typeof getPluginManifestSchema>["safeParse"]>;

const panel = { id: "inbox", name: "Inbox", iconId: "puzzle", color: "#ffffff" };
const view = { id: "inbox", componentPath: "dist/inbox.js", location: "panel" as const };

function parse(button: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parseAs("user", button, extra);
}

function parseAs(
  origin: PluginOrigin,
  button: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.inbox",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: {
      panels: [panel],
      views: [view],
      toolbarButtons: [{ id: "open", label: "Inbox", iconId: "package", ...button }],
      ...extra,
    },
  });
}

function issuesFor(result: ParseResult, code: string) {
  if (result.success) return [];
  return result.error.issues.filter(
    (i) => (i as { params?: { errorCode?: string } }).params?.errorCode === code
  );
}

describe("toolbar button popover", () => {
  it("accepts a popover naming a declared panel view, for installed and project plugins", () => {
    for (const origin of ["user", "project"] as const) {
      const result = parseAs(origin, { popover: { viewId: "inbox" } });
      expect(result.success, origin).toBe(true);
      if (!result.success) continue;
      expect(result.data.contributes.toolbarButtons[0]).toEqual(
        expect.objectContaining({ popover: { viewId: "inbox" } })
      );
      expect(result.data.contributes.toolbarButtons[0]).not.toHaveProperty("actionId");
    }
  });

  it("still accepts an action button", () => {
    expect(parse({ actionId: "acme.inbox.open" }).success).toBe(true);
  });

  it("rejects a button with neither an action nor a popover", () => {
    const result = parse({});
    expect(result.success).toBe(false);
    const [issue] = issuesFor(result, "toolbar_button_behavior_missing");
    expect(issue?.path).toEqual(["contributes", "toolbarButtons", 0]);
  });

  it("rejects a button with both an action and a popover", () => {
    const result = parse({ actionId: "acme.inbox.open", popover: { viewId: "inbox" } });
    expect(result.success).toBe(false);
    const [issue] = issuesFor(result, "toolbar_button_behavior_conflict");
    expect(issue?.path).toEqual(["contributes", "toolbarButtons", 0, "popover"]);
  });

  it("rejects a popover naming no declared view", () => {
    const result = parse({ popover: { viewId: "missing" } });
    expect(result.success).toBe(false);
    const [issue] = issuesFor(result, "toolbar_popover_view_unknown");
    expect(issue?.path).toEqual(["contributes", "toolbarButtons", 0, "popover", "viewId"]);
  });

  it("rejects a popover naming the settings view", () => {
    const result = parse(
      { popover: { viewId: "prefs" } },
      {
        views: [view, { id: "prefs", componentPath: "dist/prefs.js", location: "settings" }],
      }
    );
    expect(result.success).toBe(false);
    expect(issuesFor(result, "toolbar_popover_view_settings")).toHaveLength(1);
  });

  it("rejects a popover naming a PTY panel, whose view never loads", () => {
    const result = parse(
      { popover: { viewId: "inbox" } },
      { panels: [{ ...panel, hasPty: true }] }
    );
    expect(result.success).toBe(false);
    const [issue] = issuesFor(result, "toolbar_popover_view_pty");
    expect(issue?.message).toContain("hasPty");
  });

  it("rejects unknown keys on the popover and an empty view id", () => {
    expect(parse({ popover: { viewId: "inbox", width: 300 } }).success).toBe(false);
    expect(parse({ popover: { viewId: "" } }).success).toBe(false);
  });

  it("does not run the action-id checks on a popover button", () => {
    const result = parse({ popover: { viewId: "inbox" } });
    expect(result.success).toBe(true);
    expect(issuesFor(result, "action_id_unknown_namespace")).toHaveLength(0);
  });
});
