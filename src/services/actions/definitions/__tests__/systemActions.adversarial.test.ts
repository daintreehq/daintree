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
}));

import { registerSystemActions } from "../systemActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerSystemActions(actions, callbacks);
  return (id: string) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
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
      const def = setupActions()("files.search");
      await def.run({ query: "Foo" } as never, { activeWorktreePath: "/repo" } as never);
      expect(filesClientMock.search).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/repo", query: "Foo" })
      );
    });

    it("prefers explicit cwd over ctx", async () => {
      const def = setupActions()("files.search");
      await def.run(
        { cwd: "/explicit", query: "Foo" } as never,
        { activeWorktreePath: "/ctx" } as never
      );
      expect(filesClientMock.search).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/explicit" })
      );
    });

    it("throws when cwd is omitted and no active worktree", async () => {
      const def = setupActions()("files.search");
      await expect(def.run({ query: "Foo" } as never, {} as never)).rejects.toThrow(
        "No active worktree"
      );
    });
  });

  describe("slashCommands.list", () => {
    it("defaults agentId to 'claude' when omitted", async () => {
      const def = setupActions()("slashCommands.list");
      await def.run(undefined as never, {} as never);
      expect(slashCommandsClientMock.list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" })
      );
    });

    it("preserves explicit agentId", async () => {
      const def = setupActions()("slashCommands.list");
      await def.run({ agentId: "codex" } as never, {} as never);
      expect(slashCommandsClientMock.list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "codex" })
      );
    });

    it("forwards projectPath unchanged", async () => {
      const def = setupActions()("slashCommands.list");
      await def.run({ projectPath: "/repo" } as never, {} as never);
      expect(slashCommandsClientMock.list).toHaveBeenCalledWith({
        agentId: "claude",
        projectPath: "/repo",
      });
    });
  });

  describe("copyTree.generate", () => {
    it("falls back to ctx.activeWorktreeId when worktreeId is omitted", async () => {
      const def = setupActions()("copyTree.generate");
      await def.run(undefined as never, { activeWorktreeId: "wt-active" } as never);
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith("wt-active", undefined);
    });

    it("forwards options when provided", async () => {
      const def = setupActions()("copyTree.generate");
      const options = { format: "xml" as const };
      await def.run({ options } as never, { activeWorktreeId: "wt-active" } as never);
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith("wt-active", options);
    });

    it("throws when worktreeId is omitted and no active worktree", async () => {
      const def = setupActions()("copyTree.generate");
      await expect(def.run(undefined as never, {} as never)).rejects.toThrow("No active worktree");
    });
  });

  describe("copyTree.generateAndCopyFile", () => {
    it("falls back to ctx.activeWorktreeId when worktreeId is omitted", async () => {
      const def = setupActions()("copyTree.generateAndCopyFile");
      await def.run(undefined as never, { activeWorktreeId: "wt-active" } as never);
      expect(copyTreeClientMock.generateAndCopyFile).toHaveBeenCalledWith("wt-active", undefined);
    });
  });

  describe("copyTree.injectToTerminal", () => {
    it("falls back to ctx.activeWorktreeId when worktreeId is omitted", async () => {
      const def = setupActions()("copyTree.injectToTerminal");
      await def.run({ terminalId: "t-1" } as never, { activeWorktreeId: "wt-active" } as never);
      expect(copyTreeClientMock.injectToTerminal).toHaveBeenCalledWith(
        "t-1",
        "wt-active",
        undefined
      );
    });

    it("preserves explicit worktreeId over ctx", async () => {
      const def = setupActions()("copyTree.injectToTerminal");
      await def.run(
        { terminalId: "t-1", worktreeId: "wt-explicit" } as never,
        { activeWorktreeId: "wt-ctx" } as never
      );
      expect(copyTreeClientMock.injectToTerminal).toHaveBeenCalledWith(
        "t-1",
        "wt-explicit",
        undefined
      );
    });

    it("throws when worktreeId is omitted and no active worktree", async () => {
      const def = setupActions()("copyTree.injectToTerminal");
      await expect(def.run({ terminalId: "t-1" } as never, {} as never)).rejects.toThrow(
        "No active worktree"
      );
    });
  });
});
