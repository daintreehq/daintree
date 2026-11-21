import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/user-data" } }));
vi.mock("../agentDefaults.js", () => ({ onAgentDefaultsChanged: () => () => {} }));

const mocks = vi.hoisted(() => ({
  spawnHostAssistantLive: vi.fn(async () => true),
  launchableAgents: vi.fn(async () => [
    { id: "claude", byDefault: true },
    { id: "codex", byDefault: true },
  ]),
  meetsVersionFloor: vi.fn(async (_id: string) => true),
}));
vi.mock("../viewless/index.js", () => ({ spawnHostAssistantLive: mocks.spawnHostAssistantLive }));
vi.mock("../assistants/assistantLaunch.js", () => ({
  liveAssistantLaunchDeps: async () => ({
    launchableAgents: mocks.launchableAgents,
    meetsVersionFloor: mocks.meetsVersionFloor,
    launchFlags: async () => [],
  }),
  firstUsableDefault: async (agents: Array<{ id: string }>) => agents[0]?.id,
  spawnAndConfirm: async (_pty: unknown, spawn: () => Promise<boolean>) => spawn(),
}));
vi.mock("../../window/serviceRefs.js", () => ({ getPtyClient: () => null }));

const { liveGlobalAssistantDeps } = await import("../globalAssistant.js");

const spec = {
  terminalId: "terminal-g",
  agentId: "codex",
  cwd: "/user-data/global",
  env: { DAINTREE_MCP_TOKEN: "t" },
};

describe("liveGlobalAssistantDeps (#18140)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.meetsVersionFloor.mockResolvedValue(true);
  });

  it("gives a run started from a hand-off that hand-off as its first turn", async () => {
    await liveGlobalAssistantDeps().spawn({ ...spec, prompt: "Continue from the hand-off" });
    expect(mocks.spawnHostAssistantLive).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "codex", prompt: "Continue from the hand-off" })
    );
  });

  it("starts any other run waiting for its first turn", async () => {
    await liveGlobalAssistantDeps().spawn(spec);
    expect(mocks.spawnHostAssistantLive).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: "" })
    );
  });

  it("runs only an agent a start with no view could, and only one new enough", async () => {
    const deps = liveGlobalAssistantDeps();
    expect(await deps.canRun("codex")).toBe(true);
    expect(await deps.canRun("gemini")).toBe(false);
    mocks.meetsVersionFloor.mockResolvedValue(false);
    expect(await deps.canRun("codex")).toBe(false);
  });
});
