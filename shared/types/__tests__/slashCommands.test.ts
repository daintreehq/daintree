import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "../../config/agentIds.js";
import { AGENT_REGISTRY } from "../../config/agentRegistry.js";
import { BUILTIN_SLASH_COMMANDS, getBuiltinSlashCommands } from "../slashCommands.js";

const AGENT_IDS = new Set<string>(BUILT_IN_AGENT_IDS);

/** Agents whose config declares the shared built-in catalog as a `/` source. */
function agentsDeclaringBuiltinCatalog(): BuiltInAgentId[] {
  return BUILT_IN_AGENT_IDS.filter((agentId) =>
    AGENT_REGISTRY[agentId].completionSources?.some(
      (source) => source.discovery.method === "static"
    )
  );
}

describe("BUILTIN_SLASH_COMMANDS registry", () => {
  it("has no duplicate ids", () => {
    const ids = BUILTIN_SLASH_COMMANDS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate labels", () => {
    const labels = BUILTIN_SLASH_COMMANDS.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("derives every label from its id", () => {
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      expect(entry.label).toBe(`/${entry.id}`);
    }
  });

  it("has non-empty, trimmed, period-free copy on every entry", () => {
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
        expect(command).toEqual({
          id: entry?.id,
          label: entry?.label,
          description: entry?.descriptions?.[agentId] ?? entry?.description,
          scope: "built-in",
          agentId,
        });
      }
    }
  });

  it("returns unique ids and labels per agent", () => {
    for (const agentId of BUILT_IN_AGENT_IDS) {
      const commands = getBuiltinSlashCommands(agentId);
      expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
      expect(new Set(commands.map((c) => c.label)).size).toBe(commands.length);
    }
  });
});

describe("catalog / agent-registry consistency", () => {
  it("only declares support for agents that read the built-in catalog", () => {
    const readers = new Set<string>(agentsDeclaringBuiltinCatalog());
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      for (const agentId of entry.supportedAgents) {
        expect(
          readers.has(agentId),
          `/${entry.id} lists ${agentId}, which declares no static built-in completion source`
        ).toBe(true);
      }
    }
  });

  it("gives every agent that reads the catalog a non-empty command list", () => {
    const readers = agentsDeclaringBuiltinCatalog();
    expect(readers.length).toBeGreaterThan(0);
    for (const agentId of readers) {
      expect(
        getBuiltinSlashCommands(agentId).length,
        `${agentId} resolves to no commands`
      ).toBeGreaterThan(0);
    }
  });
});
