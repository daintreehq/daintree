import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ActionDefinition, ActionContext } from "@shared/types/actions";

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
  },
}));

const mockGlobalEnvGet = vi.fn();
const mockGlobalEnvSet = vi.fn();

type ActionFactory = () => ActionDefinition;

const ENV_ACTION_IDS = [
  "env.global.get",
  "env.global.set",
  "env.project.get",
  "env.project.set",
  "worktree.resource.config.get",
  "worktree.resource.config.set",
] as const;

const stubCtx: ActionContext = {};

describe("env action definitions", () => {
  const registry = new Map<string, ActionFactory>();

  beforeAll(async () => {
    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          globalEnv: {
            get: (...args: unknown[]) => mockGlobalEnvGet(...args),
            set: (...args: unknown[]) => mockGlobalEnvSet(...args),
          },
        },
      },
      writable: true,
      configurable: true,
    });
    const { registerEnvActions } = await import("../envActions");
    registerEnvActions(registry as never, {} as never);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all 6 env/resource.config action IDs", () => {
    for (const id of ENV_ACTION_IDS) {
      expect(registry.has(id), `missing action: ${id}`).toBe(true);
    }
  });

  it.each([
    ["env.global.get", "query", "safe", "env"],
    ["env.global.set", "command", "confirm", "env"],
    ["env.project.get", "query", "safe", "env"],
    ["env.project.set", "command", "confirm", "env"],
    ["worktree.resource.config.get", "query", "safe", "worktree"],
    ["worktree.resource.config.set", "command", "confirm", "worktree"],
  ] as const)("%s has expected kind/danger/category", (id, kind, danger, category) => {
    const def = registry.get(id)!();
    expect(def.kind).toBe(kind);
    expect(def.danger).toBe(danger);
    expect(def.category).toBe(category);
    expect(def.scope).toBe("renderer");
  });

  it("env.global.get delegates to window.electron.globalEnv.get", async () => {
    mockGlobalEnvGet.mockResolvedValue({ FOO: "bar" });
    const def = registry.get("env.global.get")!();
    const result = await def.run(undefined, stubCtx);
    expect(mockGlobalEnvGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ FOO: "bar" });
  });

  it("env.global.set delegates to window.electron.globalEnv.set with variables", async () => {
    mockGlobalEnvSet.mockResolvedValue(undefined);
    const def = registry.get("env.global.set")!();
    await def.run({ variables: { KEY: "val" } }, stubCtx);
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
