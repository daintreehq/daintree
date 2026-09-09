import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionService } from "@/services/ActionService";
import type { ActionRegistry } from "../actionTypes";
import { registerAgentCapabilityActions } from "../definitions/agentCapabilityActions";
import { setPanelStoreAccessor } from "@/store/storeAccessors";

const client = vi.hoisted(() => ({ search: vi.fn(), get: vi.fn() }));
vi.mock("@/clients/agentCapabilitiesClient", () => ({ agentCapabilitiesClient: client }));

let service: ActionService;
const context = { agentId: "codex", worktreePath: "/repo/issue-42" };
const capability = {
  id: "cap_fixture",
  label: "Work issue",
  description: "Implement a ticket",
  scope: "project",
  agentId: "codex",
  kind: "skill",
  insertText: "$work-issue",
  trigger: "$",
  aliases: ["ticket"],
};
const catalog = { context, catalogRevision: "rev_fixture", coverage: "partial", warnings: [] };
beforeEach(() => {
  vi.clearAllMocks();
  setPanelStoreAccessor(() => ({ panelsById: {}, panelIds: [], tabGroups: new Map() }));
  const actions: ActionRegistry = new Map();
  registerAgentCapabilityActions(actions);
  service = new ActionService();
  for (const factory of actions.values()) service.register(factory());
  client.search.mockResolvedValue({ ...catalog, items: [capability], total: 1 });
  client.get.mockResolvedValue({
    ...catalog,
    capability,
    invocation: {
      token: "$work-issue",
      channel: "prompt-reference",
      startupSupport: "unverified",
      argumentHint: "<issue>",
      requiresTask: false,
    },
    sourceRevision: "source_fixture",
    instructions: "Use the issue number",
    truncated: false,
  });
});

describe("agent capability action contract", () => {
  it("preserves dollar syntax, aliases and usage through real action-result validation", async () => {
    const found = await service.dispatch("agentCapabilities.search", {
      ...context,
      query: "ticket",
    });
    expect(found).toEqual({ ok: true, result: { ...catalog, items: [capability], total: 1 } });
    const detail = await service.dispatch("agentCapabilities.get", {
      ...context,
      id: capability.id,
      catalogRevision: catalog.catalogRevision,
    });
    expect(detail).toMatchObject({
      ok: true,
      result: {
        capability: { insertText: "$work-issue", trigger: "$", aliases: ["ticket"] },
        invocation: { token: "$work-issue", argumentHint: "<issue>" },
        instructions: "Use the issue number",
      },
    });
    expect(client.get).toHaveBeenCalledWith({
      ...context,
      id: capability.id,
      catalogRevision: catalog.catalogRevision,
    });
  });

  it.each([
    { query: "work" },
    { agentId: "codex", query: "work" },
    { worktreePath: "/repo", query: "work" },
    { terminalId: "terminal-fixture", agentId: "claude", query: "work" },
    { terminalId: "missing", query: "work" },
    { ...context, worktreeId: "another", query: "work" },
  ])("rejects missing or conflicting targets: %j", async (args) => {
    expect(await service.dispatch("agentCapabilities.search", args)).toMatchObject({ ok: false });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("resolves the existing terminal's current agent and cwd instead of its launch affinity", async () => {
    setPanelStoreAccessor(() => ({
      panelsById: {
        terminal_fixture: {
          id: "terminal_fixture",
          kind: "terminal",
          location: "grid",
          cwd: "/repo/issue-42",
          launchAgentId: "claude",
          runtimeIdentity: { kind: "agent", id: "codex", agentId: "codex", iconId: "codex" },
        },
      } as never,
      panelIds: ["terminal_fixture"],
      tabGroups: new Map(),
    }));
    expect(
      await service.dispatch("agentCapabilities.search", {
        terminalId: "terminal_fixture",
        query: "ticket",
      })
    ).toMatchObject({ ok: true });
    expect(client.search).toHaveBeenCalledWith({ ...context, query: "ticket" });
  });
});

it("keeps the published cross-repository contract in sync with the action schemas", async () => {
  const { readFile } = await import("node:fs/promises");
  const { z } = await import("zod");
  const contract = JSON.parse(await readFile("docs/contracts/agent-capabilities.json", "utf8")) as {
    name: string;
    inputSchema: unknown;
    outputSchema: unknown;
  }[];
  const actions: ActionRegistry = new Map();
  registerAgentCapabilityActions(actions);
  for (const entry of contract) {
    const action = [...actions.values()]
      .map((factory) => factory())
      .find((action) => action.id === entry.name)!;
    expect(z.toJSONSchema(action.argsSchema!)).toEqual(entry.inputSchema);
    expect(z.toJSONSchema(action.resultSchema!)).toEqual(entry.outputSchema);
  }
});
