import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const filesClientMock = vi.hoisted(() => ({
  search: vi.fn(),
}));

const copyTreeClientMock = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  generate: vi.fn(),
  generateAndCopyFile: vi.fn(),
  injectToTerminal: vi.fn(),
  cancel: vi.fn(),
  getFileTree: vi.fn(),
}));

const slashCommandsClientMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const systemClientMock = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openPath: vi.fn(),
  checkCommand: vi.fn(),
  checkDirectory: vi.fn(),
  getHomeDir: vi.fn(),
  getResourceProfileSnapshot: vi.fn(),
}));

const cliAvailabilityClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  refresh: vi.fn(),
}));

const artifactClientMock = vi.hoisted(() => ({
  saveToFile: vi.fn(),
  applyPatch: vi.fn(),
}));

vi.mock("@/clients", () => ({
  filesClient: filesClientMock,
  copyTreeClient: copyTreeClientMock,
  slashCommandsClient: slashCommandsClientMock,
  systemClient: systemClientMock,
  cliAvailabilityClient: cliAvailabilityClientMock,
  artifactClient: artifactClientMock,
  // usePanelStore (pulled in transitively via useContextInjection) constructs
  // panelPersistence with projectClient at module load.
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(null),
  },
}));

import { registerSystemActions } from "../systemActions";

function setupActions(): {
  run: (id: string, args?: unknown, ctx?: Record<string, unknown>) => Promise<unknown>;
  getDef: (id: string) => AnyActionDefinition;
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerSystemActions(actions, callbacks);
  const getDef = (id: string): AnyActionDefinition => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
  };
  return {
    run: async (id, args, ctx) => getDef(id).run(args, (ctx ?? {}) as never),
    getDef,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(filesClientMock)) fn.mockResolvedValue(undefined);
  for (const fn of Object.values(copyTreeClientMock)) fn.mockResolvedValue(undefined);
  for (const fn of Object.values(slashCommandsClientMock)) fn.mockResolvedValue(undefined);
});

describe("systemActions adversarial", () => {
  describe("files.search", () => {
    it("falls back to ctx.activeWorktreePath when cwd is omitted", async () => {
      const { run } = setupActions();
      await run("files.search", { query: "Foo" }, { activeWorktreePath: "/repo" });
      expect(filesClientMock.search).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/repo", query: "Foo" })
      );
    });

    it("prefers explicit cwd over ctx", async () => {
      const { run } = setupActions();
      await run("files.search", { cwd: "/explicit", query: "Foo" }, { activeWorktreePath: "/ctx" });
      expect(filesClientMock.search).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/explicit" })
      );
    });

    it("throws when cwd is omitted and no active worktree", async () => {
      const { run } = setupActions();
      await expect(run("files.search", { query: "Foo" })).rejects.toThrow("No active worktree");
    });
  });

  describe("slashCommands.list", () => {
    it("defaults agentId to 'claude' when omitted", async () => {
      const { run } = setupActions();
      await run("slashCommands.list", undefined);
      expect(slashCommandsClientMock.list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" })
      );
    });

    it("preserves explicit agentId", async () => {
      const { run } = setupActions();
      await run("slashCommands.list", { agentId: "codex" });
      expect(slashCommandsClientMock.list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "codex" })
      );
    });

    it("forwards projectPath unchanged", async () => {
      const { run } = setupActions();
      await run("slashCommands.list", { projectPath: "/repo" });
      expect(slashCommandsClientMock.list).toHaveBeenCalledWith({
        agentId: "claude",
        projectPath: "/repo",
      });
    });
  });

  describe("system.getResourceProfileSnapshot", () => {
    it("returns the client snapshot verbatim", async () => {
      const snapshot = {
        profile: "efficiency" as const,
        thermalState: "serious" as const,
        isOnBattery: true,
        speedLimit: 60,
        lagPressureActive: true,
      };
      systemClientMock.getResourceProfileSnapshot.mockResolvedValue(snapshot);
      const { run } = setupActions();
      const result = await run("system.getResourceProfileSnapshot");
      expect(systemClientMock.getResourceProfileSnapshot).toHaveBeenCalledOnce();
      expect(result).toEqual(snapshot);
    });

    it("is a discoverable read-only MCP tool (kept off the eager tools/list)", () => {
      const { getDef } = setupActions();
      const def = getDef("system.getResourceProfileSnapshot");
      expect(def.kind).toBe("query");
      expect(def.danger).toBe("safe");
      expect(def.mcpVisibility).toBe("discoverable");
    });
  });

  describe("copyTree.generate", () => {
    it("falls back to ctx.activeWorktreeId when worktreeId is omitted", async () => {
      const { run } = setupActions();
      await run("copyTree.generate", undefined, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith("wt-active", undefined);
    });

    it("forwards options when provided", async () => {
      const { run } = setupActions();
      const options = { format: "xml" as const };
      await run("copyTree.generate", { options }, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith("wt-active", options);
    });

    it("throws when worktreeId is omitted and no active worktree", async () => {
      const { run } = setupActions();
      await expect(run("copyTree.generate", undefined)).rejects.toThrow("No active worktree");
    });
  });

  describe("copyTree.generateAndCopyFile", () => {
    it("falls back to ctx.activeWorktreeId when worktreeId is omitted", async () => {
      const { run } = setupActions();
      await run("copyTree.generateAndCopyFile", undefined, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generateAndCopyFile).toHaveBeenCalledWith("wt-active", undefined);
    });
  });

  describe("copyTree.injectToTerminal", () => {
    it("falls back to ctx.activeWorktreeId when worktreeId is omitted", async () => {
      const { run } = setupActions();
      await run(
        "copyTree.injectToTerminal",
        { terminalId: "t-1" },
        { activeWorktreeId: "wt-active" }
      );
      expect(copyTreeClientMock.injectToTerminal).toHaveBeenCalledWith(
        "t-1",
        "wt-active",
        undefined
      );
    });

    it("preserves explicit worktreeId over ctx", async () => {
      const { run } = setupActions();
      await run(
        "copyTree.injectToTerminal",
        { terminalId: "t-1", worktreeId: "wt-explicit" },
        { activeWorktreeId: "wt-ctx" }
      );
      expect(copyTreeClientMock.injectToTerminal).toHaveBeenCalledWith(
        "t-1",
        "wt-explicit",
        undefined
      );
    });

    it("throws when worktreeId is omitted and no active worktree", async () => {
      const { run } = setupActions();
      await expect(run("copyTree.injectToTerminal", { terminalId: "t-1" })).rejects.toThrow(
        "No active worktree"
      );
    });
  });
});
