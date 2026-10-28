import { describe, expect, it } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

const COMMAND = {
  id: "sync",
  title: "Run first sync",
  description: "Pull projects",
  category: "Acme",
  kind: "command",
  danger: "safe",
};

function parse(setup: unknown, extra: Record<string, unknown> = {}, origin: PluginOrigin = "user") {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.tracker",
    version: "1.0.0",
    capabilities: ["network:fetch"],
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: {
      settings: [{ id: "workspace", label: "Workspace" }],
      account: { kind: "token", label: "Acme API token" },
      commands: [COMMAND],
      setup,
      ...extra,
    },
  });
}

function errorCodes(result: ReturnType<typeof parse>): unknown[] {
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: unknown } }).params?.errorCode
  );
}

const STEPS = [
  { id: "connect", title: "Connect your account", done: { kind: "account" } },
  {
    id: "workspace",
    title: "Choose a workspace",
    description: "Issues are read from it",
    done: { kind: "setting", key: "workspace" },
  },
  {
    id: "sync",
    title: "Run the first sync",
    done: { kind: "context", when: "acme.tracker.synced && !acme.tracker.syncing" },
    action: { kind: "command", actionId: "acme.tracker.sync" },
  },
];

describe("contributes.setup schema (#13824)", () => {
  it("accepts every check and action kind, and defaults to no steps", () => {
    const parsed = parse(STEPS);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.contributes.setup.map((s) => s.id)).toEqual([
      "connect",
      "workspace",
      "sync",
    ]);
    expect(
      parse([
        {
          id: "open",
          title: "Review the defaults",
          done: { kind: "context", when: "acme.tracker.reviewed" },
          action: { kind: "settings" },
        },
      ]).success
    ).toBe(true);

    const bare = getPluginManifestSchema("user").safeParse({ name: "acme.t", version: "1.0.0" });
    expect(bare.success && bare.data.contributes.setup).toEqual([]);
    const noSetup = getPluginManifestSchema("user").safeParse({
      name: "acme.t",
      version: "1.0.0",
      contributes: { commands: [] },
    });
    expect(noSetup.success && noSetup.data.contributes.setup).toEqual([]);
  });

  it("is available to a project plugin", () => {
    expect(parse(STEPS, {}, "project").success).toBe(true);
  });

  it("rejects a setting step or settings action naming an undeclared setting", () => {
    const step = parse([{ id: "a", title: "A", done: { kind: "setting", key: "missing" } }]);
    expect(errorCodes(step)).toContain("setup_setting_unknown");
    const action = parse([
      {
        id: "a",
        title: "A",
        done: { kind: "account" },
        action: { kind: "settings", key: "missing" },
      },
    ]);
    expect(errorCodes(action)).toContain("setup_setting_unknown");
  });

  it("rejects an account step when the plugin declares no account", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.tracker",
      version: "1.0.0",
      contributes: { setup: [{ id: "a", title: "A", done: { kind: "account" } }] },
    });
    expect(errorCodes(result as ReturnType<typeof parse>)).toContain("setup_account_undeclared");
  });

  it("rejects a when clause that doesn't parse", () => {
    const result = parse([
      { id: "a", title: "A", done: { kind: "context", when: "acme.tracker.synced &&" } },
    ]);
    expect(errorCodes(result)).toContain("setup_when_invalid");
  });

  it("runs only the plugin's own commands, and only declared ones when any are declared", () => {
    const step = (actionId: string) => [
      {
        id: "a",
        title: "A",
        done: { kind: "account" },
        action: { kind: "command", actionId },
      },
    ];
    expect(errorCodes(parse(step("terminal.new")))).toContain("setup_command_not_own");
    expect(errorCodes(parse(step("other.plugin.sync")))).toContain("setup_command_not_own");
    expect(errorCodes(parse(step("acme.tracker.")))).toContain("setup_command_not_own");
    expect(errorCodes(parse(step("acme.tracker.typo")))).toContain("action_id_undeclared_command");
    // A plugin that registers its actions imperatively declares none to check against.
    expect(parse(step("acme.tracker.anything"), { commands: [] }).success).toBe(true);
  });

  it("rejects duplicate ids, unknown fields, blank titles and more steps than the cap", () => {
    const one = STEPS[0]!;
    expect(errorCodes(parse([one, { ...one, title: "Again" }]))).toContain(
      "duplicate_contribution_id"
    );
    expect(parse([{ ...one, markDone: true }]).success).toBe(false);
    expect(parse([{ ...one, done: { kind: "account", stored: true } }]).success).toBe(false);
    expect(parse([{ ...one, title: "   " }]).success).toBe(false);
    expect(parse([{ ...one, done: { kind: "manual" } }]).success).toBe(false);
    const tooMany = Array.from({ length: MANIFEST_CONTRIBUTION_CAPS.setup + 1 }, (_, i) => ({
      ...one,
      id: `step-${i}`,
    }));
    expect(parse(tooMany).success).toBe(false);
    const atCap = tooMany.slice(0, MANIFEST_CONTRIBUTION_CAPS.setup);
    expect(parse(atCap).success).toBe(true);
  });
});
