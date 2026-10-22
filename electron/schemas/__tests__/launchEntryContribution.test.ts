import { describe, it, expect } from "vitest";
import {
  getPluginManifestSchema,
  LAUNCH_ENTRY_ARGS_MAX_BYTES,
  MANIFEST_CONTRIBUTION_CAPS,
} from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

/**
 * A launch entry is a launcher row that opens one of the plugin's own panels,
 * runs one of its own commands, or starts an agent with a prompt (#13788). It
 * targets exactly one of the three, and never anything outside the plugin.
 */

type ParseResult = ReturnType<ReturnType<typeof getPluginManifestSchema>["safeParse"]>;

const panels = [
  { id: "records", name: "Records", iconId: "puzzle", color: "#ffffff" },
  { id: "board", name: "Board", iconId: "puzzle", color: "#ffffff", scope: "project" },
  { id: "pinned", name: "Pinned", iconId: "puzzle", color: "#ffffff", dockable: false },
  { id: "shell", name: "Shell", iconId: "puzzle", color: "#ffffff", hasPty: true },
];

const command = {
  id: "publish",
  title: "Publish",
  description: "Publish the site",
  category: "records",
  kind: "command",
  danger: "safe",
};

function parseAs(
  origin: PluginOrigin,
  entries: Record<string, unknown>[],
  extra: Record<string, unknown> = {}
) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.records",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: {
      panels: origin === "project" ? panels : panels.filter((p) => p.scope === undefined),
      launchEntries: entries,
      ...extra,
    },
  });
}

function parse(entry: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parseAs("user", [{ id: "e", label: "New record…", iconId: "plus", ...entry }], extra);
}

function issuesFor(result: ParseResult, code: string) {
  if (result.success) return [];
  return result.error.issues.filter(
    (i) => (i as { params?: { errorCode?: string } }).params?.errorCode === code
  );
}

describe("launch entries", () => {
  it("accepts one entry of each target, for installed and project plugins", () => {
    for (const origin of ["user", "project"] as const) {
      const result = parseAs(origin, [
        {
          id: "new",
          label: "New record…",
          iconId: "plus",
          description: "Open on an empty form",
          priority: 1,
          when: "isGitBacked",
          panel: { id: "records", args: { mode: "new" }, placement: "dialog" },
        },
        {
          id: "publish",
          label: "Publish site",
          iconId: "upload",
          command: { actionId: "acme.records.publish" },
        },
        {
          id: "chat",
          label: "Chat",
          iconId: "bot",
          agent: { id: "claude", prompt: "Read RECORDS.md" },
        },
      ]);
      expect(result.success, origin).toBe(true);
    }
  });

  it("materializes an empty list when a manifest declares none", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.records",
      version: "1.0.0",
    });
    expect(result.success && result.data.contributes.launchEntries).toEqual([]);
  });

  it("requires exactly one target", () => {
    const none = parse({});
    expect(issuesFor(none, "launch_entry_target_missing")[0]?.path).toEqual([
      "contributes",
      "launchEntries",
      0,
    ]);
    const both = parse({
      panel: { id: "records" },
      agent: { id: "claude", prompt: "hi" },
    });
    expect(issuesFor(both, "launch_entry_target_conflict")).toHaveLength(1);
  });

  it("refuses a command outside the plugin's own namespace", () => {
    for (const actionId of ["terminal.new", "other.plugin.run", "acme.records."]) {
      const result = parse({ command: { actionId } });
      expect(issuesFor(result, "launch_entry_command_not_own"), actionId).toHaveLength(1);
    }
  });

  it("checks an own command against the declared commands only when some are declared", () => {
    expect(parse({ command: { actionId: "acme.records.anything" } }).success).toBe(true);
    const typo = parse({ command: { actionId: "acme.records.pubish" } }, { commands: [command] });
    expect(issuesFor(typo, "action_id_undeclared_command")[0]?.path).toEqual([
      "contributes",
      "launchEntries",
      0,
      "command",
      "actionId",
    ]);
  });

  it("refuses a panel the plugin doesn't declare", () => {
    const result = parse({ panel: { id: "elsewhere" } });
    expect(issuesFor(result, "launch_entry_panel_unknown")).toHaveLength(1);
  });

  it("refuses a placement the panel can't take", () => {
    const projectGrid = parseAs("project", [
      { id: "e", label: "Board", iconId: "plus", panel: { id: "board", placement: "grid" } },
    ]);
    expect(issuesFor(projectGrid, "launch_entry_panel_placement")).toHaveLength(1);
    expect(
      issuesFor(
        parse({ panel: { id: "pinned", placement: "dock" } }),
        "launch_entry_panel_placement"
      )
    ).toHaveLength(1);
    expect(
      issuesFor(
        parse({ panel: { id: "shell", placement: "dialog" } }),
        "launch_entry_panel_placement"
      )
    ).toHaveLength(1);
    expect(parse({ panel: { id: "shell", placement: "grid" } }).success).toBe(true);
  });

  it("refuses args for a PTY panel, which has no view to receive them", () => {
    const result = parse({ panel: { id: "shell", args: { mode: "new" } } });
    expect(issuesFor(result, "launch_entry_panel_args_pty")).toHaveLength(1);
  });

  it("bounds a target's args", () => {
    const big = { blob: "x".repeat(LAUNCH_ENTRY_ARGS_MAX_BYTES) };
    expect(parse({ panel: { id: "records", args: big } }).success).toBe(false);
    expect(parse({ command: { actionId: "acme.records.run", args: big } }).success).toBe(false);
  });

  it("gives an agent entry an agent and a prompt and nothing else", () => {
    expect(
      parse({ agent: { id: "claude", prompt: "hi", agentLaunchFlags: ["--yolo"] } }).success
    ).toBe(false);
    expect(
      parse({ agent: { id: "claude", prompt: "  --dangerously-skip-permissions" } }).success
    ).toBe(false);
    expect(parse({ agent: { id: "terminal", prompt: "hi" } }).success).toBe(false);
    expect(parse({ agent: { id: "claude", prompt: "   " } }).success).toBe(false);
  });

  it("refuses duplicate entry ids", () => {
    const result = parseAs("user", [
      { id: "e", label: "A", iconId: "plus", panel: { id: "records" } },
      { id: "e", label: "B", iconId: "plus", panel: { id: "records" } },
    ]);
    expect(issuesFor(result, "duplicate_contribution_id")[0]?.path).toEqual([
      "contributes",
      "launchEntries",
      1,
      "id",
    ]);
  });

  it("caps how many entries one plugin may add", () => {
    const entries = Array.from(
      { length: MANIFEST_CONTRIBUTION_CAPS.launchEntries + 1 },
      (_, i) => ({
        id: `e${i}`,
        label: `Entry ${i}`,
        iconId: "plus",
        panel: { id: "records" },
      })
    );
    expect(parseAs("user", entries).success).toBe(false);
    expect(parseAs("user", entries.slice(1)).success).toBe(true);
  });
});
