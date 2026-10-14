import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";

const serviceMock = vi.hoisted(() => ({
  readAgentDefaults: vi.fn(() => ({ assistantAgentId: "codex" })),
  setAgentDefaults: vi.fn(() => true),
  migrateLegacyAgentDefaults: vi.fn(() => ({ assistantAgentId: "claude" })),
}));

vi.mock("../../../services/agentDefaults.js", () => serviceMock);

import { agentDefaultsNamespace } from "../agentDefaults.js";

function ctx(client: "local" | "remote", endpoint: "local-view" | "remote-view"): IpcContext {
  return {
    client: { kind: client },
    endpoint: { kind: endpoint },
  } as unknown as IpcContext;
}

type MigrateHandler = (
  context: IpcContext,
  candidates: Record<string, unknown>
) => Promise<Record<string, unknown>>;

const migrate = agentDefaultsNamespace.ops.migrateLegacy.handler as unknown as MigrateHandler;

describe("agentDefaults IPC namespace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("migrates a local window's legacy values", async () => {
    const result = await migrate(ctx("local", "local-view"), { assistantAgentId: "claude" });

    expect(serviceMock.migrateLegacyAgentDefaults).toHaveBeenCalledWith({
      assistantAgentId: "claude",
    });
    expect(result).toEqual({ assistantAgentId: "claude" });
  });

  it.each([
    ["a remote Shell", ctx("remote", "remote-view")],
    ["a remote view of a local client", ctx("local", "remote-view")],
    ["a remote client on a local endpoint", ctx("remote", "local-view")],
  ])("never seeds the host from %s's localStorage", async (_label, context) => {
    const result = await migrate(context, { assistantAgentId: "claude", defaultAgent: "codex" });

    expect(serviceMock.migrateLegacyAgentDefaults).not.toHaveBeenCalled();
    expect(result).toEqual({ assistantAgentId: "codex" });
  });

  it("answers a set with the host's snapshot after the write", async () => {
    const set = agentDefaultsNamespace.ops.set.handler as unknown as (
      patch: Record<string, unknown>
    ) => Promise<unknown>;

    await expect(set({ defaultAgent: null })).resolves.toEqual({ assistantAgentId: "codex" });
    expect(serviceMock.setAgentDefaults).toHaveBeenCalledWith({ defaultAgent: null });
  });
});
