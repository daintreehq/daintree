import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { AnyActionDefinition } from "../../actionTypes";

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();
const mockGlobalEnvGet = vi.fn();
const mockGlobalEnvSet = vi.fn();
const mockGlobalEnvInvalidate = vi.fn();

vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
  },
  globalEnvClient: {
    get: (...args: unknown[]) => mockGlobalEnvGet(...args),
    set: (...args: unknown[]) => mockGlobalEnvSet(...args),
    invalidate: (...args: unknown[]) => mockGlobalEnvInvalidate(...args),
  },
}));

type ActionFactory = () => AnyActionDefinition;

const stubCtx: ActionContext = {};

describe("env action definitions", () => {
  const registry = new Map<string, ActionFactory>();

  beforeAll(async () => {
    const { registerEnvActions } = await import("../envActions");
    registerEnvActions(registry as never, {} as never);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("env.global.set delegates to globalEnvClient.set (cache-invalidating) with variables", async () => {
    mockGlobalEnvSet.mockResolvedValue(undefined);
    const def = registry.get("env.global.set")!();
    await def.run({ variables: { KEY: "val" } }, stubCtx);
    // Routing through globalEnvClient.set is the regression guard for #7617:
    // a direct window.electron.globalEnv.set call would leave the renderer
    // cache stale until the user opens EnvironmentSettingsTab manually.
    expect(mockGlobalEnvSet).toHaveBeenCalledWith({ KEY: "val" });
  });

  it("env.project.get returns environmentVariables from settings", async () => {
    mockGetSettings.mockResolvedValue({ environmentVariables: { A: "1" } });
    const def = registry.get("env.project.get")!();
    const result = await def.run({ projectId: "p1" }, stubCtx);
    expect(mockGetSettings).toHaveBeenCalledWith("p1");
    expect(result).toEqual({ A: "1" });
  });

  it("env.project.get returns empty object when settings has no environmentVariables", async () => {
    mockGetSettings.mockResolvedValue({});
    const def = registry.get("env.project.get")!();
    const result = await def.run({ projectId: "p1" }, stubCtx);
    expect(result).toEqual({});
  });

  it("env.project.set merges variables into existing environmentVariables", async () => {
    mockGetSettings.mockResolvedValue({
      environmentVariables: { A: "1" },
      runCommands: [],
    });
    mockSaveSettings.mockResolvedValue(undefined);
    const def = registry.get("env.project.set")!();
    await def.run({ projectId: "p1", variables: { B: "2" } }, stubCtx);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    const [savedProjectId, savedSettings] = mockSaveSettings.mock.calls[0]!;
    expect(savedProjectId).toBe("p1");
    expect(savedSettings.environmentVariables).toEqual({ A: "1", B: "2" });
    expect(savedSettings.runCommands).toEqual([]);
  });

  it("worktree.resource.config.get returns resourceEnvironments from settings", async () => {
    mockGetSettings.mockResolvedValue({
      resourceEnvironments: { default: { provision: ["echo"] } },
    });
    const def = registry.get("worktree.resource.config.get")!();
    const result = await def.run({ projectId: "p1" }, stubCtx);
    expect(result).toEqual({ default: { provision: ["echo"] } });
  });

  it("worktree.resource.config.get returns empty object when settings has no resourceEnvironments", async () => {
    mockGetSettings.mockResolvedValue({});
    const def = registry.get("worktree.resource.config.get")!();
    const result = await def.run({ projectId: "p1" }, stubCtx);
    expect(result).toEqual({});
  });

  it("worktree.resource.config.set replaces resourceEnvironments", async () => {
    mockGetSettings.mockResolvedValue({
      resourceEnvironments: { old: {} },
      runCommands: [],
    });
    mockSaveSettings.mockResolvedValue(undefined);
    const def = registry.get("worktree.resource.config.set")!();
    await def.run(
      { projectId: "p1", resourceEnvironments: { new: { provision: ["a"] } } },
      stubCtx
    );
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    const [savedProjectId, savedSettings] = mockSaveSettings.mock.calls[0]!;
    expect(savedProjectId).toBe("p1");
    expect(savedSettings.resourceEnvironments).toEqual({ new: { provision: ["a"] } });
    expect(savedSettings.runCommands).toEqual([]);
  });
});
