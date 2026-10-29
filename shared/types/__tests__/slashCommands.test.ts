import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "../../config/agentIds.js";
import { AGENT_REGISTRY } from "../../config/agentRegistry.js";
import type { CompletionSourceConfig } from "../completionSources.js";
import { BUILTIN_SLASH_COMMANDS, getBuiltinSlashCommands } from "../slashCommands.js";

const AGENT_IDS = new Set<string>(BUILT_IN_AGENT_IDS);

/**
 * The command set Codex 0.147.0's own `/` popup lists, captured from the
 * installed CLI (#11843). This is an upstream contract, not a copy of the
 * catalog: it fails whenever the two drift apart in either direction, which is
 * the regression the catalog kept suffering. To refresh after a Codex upgrade,
 * launch `codex`, type `/`, scroll the popup, and diff it against this list —
 * then update the catalog and this fixture together, in that order.
 */
const CODEX_0_147_0_POPUP_COMMANDS = [
  "agent",
  "app",
  "approve",
  "archive",
  "clear",
  "compact",
  "copy",
  "delete",
  "diff",
  "exit",
  "experimental",
  "fast",
  "feedback",
  "fork",
  "goal",
  "hooks",
  "ide",
  "import",
  "init",
  "keymap",
  "logout",
  "mcp",
  "memories",
  "mention",
  "model",
  "new",
  "permissions",
  "personality",
  "pets",
  "plan",
  "plugins",
  "ps",
  "raw",
  "rename",
  "resume",
  "review",
  "side",
  "skills",
  "status",
  "statusline",
  "stop",
  "subagents",
  "theme",
  "title",
  "usage",
  "vim",
] as const;

/**
 * The built-in entries agy 1.4.10's own `/` menu lists (#15243): 44 commands
 * plus the two skills compiled into the binary, with the aliases agy displays
 * beside each command. Captured from a live session, so it fails when the
 * catalog drifts from agy in either direction. To refresh after an agy
 * upgrade, type `/` in agy, scroll the menu, and diff it against this list,
 * ignoring the user's own skills.
 */
const AGY_1_4_10_MENU: Readonly<Record<string, readonly string[]>> = {
  "add-dir": [],
  "agy-customizations": [],
  agents: [],
  "antigravity-guide": [],
  artifact: [],
  boost: [],
  browser: [],
  btw: [],
  changelog: [],
  clear: ["new"],
  codesearch: ["cs"],
  compact: [],
  config: ["settings"],
  context: [],
  copy: [],
  credits: [],
  diff: [],
  effort: [],
  exit: ["quit"],
  feedback: [],
  fork: ["branch"],
  goal: [],
  "grill-me": [],
  help: [],
  hooks: [],
  keybindings: [],
  learn: [],
  logout: [],
  mcp: [],
  model: [],
  open: [],
  permissions: [],
  plan: [],
  plugin: [],
  "remote-control": [],
  rename: [],
  resume: ["switch"],
  rewind: ["undo"],
  schedule: [],
  skills: [],
  statusline: [],
  tasks: [],
  teamwork: [],
  title: [],
  usage: ["quota"],
  voice: ["record"],
};

const AGY_BUNDLED_SKILLS = ["agy-customizations", "antigravity-guide"];

/** The `/` sources whose commands come from the shared built-in catalog. */
function builtinCatalogSources(agentId: BuiltInAgentId): CompletionSourceConfig[] {
  return (AGENT_REGISTRY[agentId].completionSources ?? []).filter(
    (source) =>
      source.discovery.method === "static" && source.discovery.catalog === "builtin-slash-commands"
  );
}

function agentsReadingBuiltinCatalog(): BuiltInAgentId[] {
  return BUILT_IN_AGENT_IDS.filter((agentId) => builtinCatalogSources(agentId).length > 0);
}

describe("BUILTIN_SLASH_COMMANDS registry", () => {
  it("has no duplicate ids", () => {
    const ids = BUILTIN_SLASH_COMMANDS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("derives every label from its id as a single slash token", () => {
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      expect(entry.label).toBe(`/${entry.id}`);
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it("has non-empty, trimmed, period-free text on every entry", () => {
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      for (const value of [
        entry.id,
        entry.description,
        ...Object.values(entry.descriptions ?? {}),
      ]) {
        expect(value).toBe(value.trim());
        expect(value.length).toBeGreaterThan(0);
        expect(value.endsWith(".")).toBe(false);
      }
    }
  });

  it("declares only real, non-duplicated agent ids in supportedAgents", () => {
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      expect(entry.supportedAgents.length).toBeGreaterThan(0);
      expect(new Set(entry.supportedAgents).size).toBe(entry.supportedAgents.length);
      for (const agentId of entry.supportedAgents) {
        expect(AGENT_IDS.has(agentId)).toBe(true);
      }
    }
  });

  it("only declares aliases for agents the entry actually supports", () => {
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      for (const [agentId, aliases] of Object.entries(entry.aliases ?? {})) {
        expect(entry.supportedAgents).toContain(agentId);
        expect(aliases.length).toBeGreaterThan(0);
        for (const alias of aliases) expect(alias).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      }
    }
  });

  it("only overrides descriptions for agents the entry actually supports", () => {
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      for (const agentId of Object.keys(entry.descriptions ?? {})) {
        expect(AGENT_IDS.has(agentId)).toBe(true);
        expect(entry.supportedAgents).toContain(agentId);
      }
    }
  });

  it("never overrides a description with the base text", () => {
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      for (const [agentId, override] of Object.entries(entry.descriptions ?? {})) {
        expect(
          override,
          `/${entry.id} declares a ${agentId} override identical to its base description`
        ).not.toBe(entry.description);
      }
    }
  });

  // Array order is the order the menu renders on a bare `/` (rankSlashCommands
  // returns the list untouched for an empty query), so the grouping the file
  // documents has to hold in the data, not just in the comments.
  it("keeps each support group contiguous and alphabetical", () => {
    const groupOf = (agents: readonly BuiltInAgentId[]) => [...agents].sort().join("+");
    const seen = new Set<string>();
    let current: string | null = null;
    let previousId = "";

    for (const entry of BUILTIN_SLASH_COMMANDS) {
      const group = groupOf(entry.supportedAgents);
      if (group !== current) {
        expect(seen.has(group), `${group} entries are split across the array`).toBe(false);
        seen.add(group);
        current = group;
        previousId = "";
      }
      expect(
        entry.id > previousId,
        `/${entry.id} is out of alphabetical order within the ${group} group`
      ).toBe(true);
      previousId = entry.id;
    }
  });
});

describe("getBuiltinSlashCommands", () => {
  it("returns exactly the entries declaring the agent, in registry order", () => {
    for (const agentId of BUILT_IN_AGENT_IDS) {
      const expected = BUILTIN_SLASH_COMMANDS.filter((e) =>
        e.supportedAgents.includes(agentId)
      ).map((e) => e.id);
      expect(getBuiltinSlashCommands(agentId).map((c) => c.id)).toEqual(expected);
    }
  });

  it("projects each entry to the public SlashCommand shape and nothing else", () => {
    for (const agentId of BUILT_IN_AGENT_IDS) {
      for (const command of getBuiltinSlashCommands(agentId)) {
        const entry = BUILTIN_SLASH_COMMANDS.find((e) => e.id === command.id);
        expect(entry, `${agentId} returned an unknown command id ${command.id}`).toBeDefined();
        if (!entry) continue;
        // toStrictEqual (not toEqual) so an explicitly-undefined `kind`,
        // `aliases`, `sourcePath` or `trigger` still counts as a leaked key.
        const aliases = entry.aliases?.[agentId];
        expect(command).toStrictEqual({
          id: entry.id,
          label: entry.label,
          description: entry.descriptions?.[agentId] ?? entry.description,
          scope: "built-in",
          agentId,
          ...(aliases ? { aliases } : {}),
          ...(entry.kind ? { kind: entry.kind } : {}),
        });
      }
    }
  });
});

describe("catalog / agent-registry consistency", () => {
  it("only declares support for agents that read the built-in catalog", () => {
    const readers = new Set<string>(agentsReadingBuiltinCatalog());
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      for (const agentId of entry.supportedAgents) {
        expect(
          readers.has(agentId),
          `/${entry.id} lists ${agentId}, whose config never declares the built-in catalog`
        ).toBe(true);
      }
    }
  });

  it("gives every agent that reads the catalog a non-empty command list", () => {
    const readers = agentsReadingBuiltinCatalog();
    expect(readers.length).toBeGreaterThan(0);
    for (const agentId of readers) {
      expect(
        getBuiltinSlashCommands(agentId).length,
        `${agentId} resolves to no commands`
      ).toBeGreaterThan(0);
    }
  });

  it("binds the built-in catalog to the slash trigger", () => {
    // A `$`-triggered built-in source would leave every other test green while
    // the slash menu silently dropped the agent's whole command list.
    for (const agentId of agentsReadingBuiltinCatalog()) {
      for (const source of builtinCatalogSources(agentId)) {
        expect(source.trigger, `${agentId} reads the built-in catalog under a non-/ trigger`).toBe(
          "/"
        );
      }
    }
  });
});

describe("Codex upstream conformance", () => {
  it("matches the command set Codex 0.147.0 lists in its own popup", () => {
    const actual = getBuiltinSlashCommands("codex").map((c) => c.id);
    expect([...actual].sort()).toEqual([...CODEX_0_147_0_POPUP_COMMANDS].sort());
  });
});

describe("Antigravity upstream conformance", () => {
  const agy = getBuiltinSlashCommands("antigravity");

  it("matches the built-in entries agy 1.4.10 lists in its own menu", () => {
    expect(agy.map((c) => c.id).sort()).toEqual(Object.keys(AGY_1_4_10_MENU).sort());
  });

  it("carries exactly the aliases agy displays", () => {
    for (const command of agy) {
      expect(command.aliases ?? [], `/${command.id}`).toEqual(AGY_1_4_10_MENU[command.id]);
    }
  });

  it("marks only the binary's bundled skills as skills", () => {
    expect(agy.filter((c) => c.kind === "skill").map((c) => c.id)).toEqual(AGY_BUNDLED_SKILLS);
  });

  it("gives every command agy's own description, not another agent's", () => {
    // Shared ids like /clear, /copy and /diff behave differently in agy, so an
    // entry agy shares must carry its own override.
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      if (!entry.supportedAgents.includes("antigravity") || entry.supportedAgents.length === 1) {
        continue;
      }
      expect(entry.descriptions?.antigravity, `/${entry.id}`).toBeDefined();
    }
  });

  it("keeps agy's aliases away from the agents that share the command", () => {
    for (const agentId of BUILT_IN_AGENT_IDS) {
      if (agentId === "antigravity") continue;
      for (const command of getBuiltinSlashCommands(agentId)) {
        expect(command.aliases, `${agentId} /${command.id}`).toBeUndefined();
      }
    }
  });
});
