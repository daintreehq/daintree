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

/**
 * A plausible file-backed CopyTreeResult, i.e. what the IPC layer actually
 * answers with. The copyTree actions project their MCP result out of this, so a
 * bare `undefined` mock would only prove they never look at it.
 */
const COPY_TREE_RESULT = {
  content: "",
  fileCount: 3,
  filePath: "/tmp/daintree-context/repo-main-x.xml",
  outputBytes: 2048,
  outputFormatVersion: "copytree-xml@1",
  stats: { totalSize: 4096, duration: 12 },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(filesClientMock)) fn.mockResolvedValue(undefined);
  for (const fn of Object.values(copyTreeClientMock)) fn.mockResolvedValue(undefined);
  for (const fn of Object.values(slashCommandsClientMock)) fn.mockResolvedValue(undefined);
  copyTreeClientMock.generate.mockResolvedValue({ ...COPY_TREE_RESULT });
  copyTreeClientMock.generateAndCopyFile.mockResolvedValue({ ...COPY_TREE_RESULT });
  copyTreeClientMock.injectToTerminal.mockResolvedValue({
    ...COPY_TREE_RESULT,
    filePath: undefined,
  });
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

    it("is a read-only MCP tool listed wherever its tier permits it", () => {
      const { getDef } = setupActions();
      const def = getDef("system.getResourceProfileSnapshot");
      expect(def.kind).toBe("query");
      expect(def.danger).toBe("safe");
      // Was `discoverable`, which withheld it from tools/list on the false
      // premise that the meta-tools could still surface it (#11585).
      expect(def.mcpVisibility).toBeUndefined();
    });
  });

  describe("copyTree.generate", () => {
    it("falls back to ctx.activeWorktreeId when worktreeId is omitted", async () => {
      const { run } = setupActions();
      await run("copyTree.generate", undefined, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith("wt-active", undefined, undefined);
    });

    it("forwards options when provided", async () => {
      const { run } = setupActions();
      const options = { format: "xml" as const };
      await run("copyTree.generate", { options }, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith("wt-active", options, undefined);
    });

    it("forwards the content opt-in so the head is only read when asked for", async () => {
      const { run } = setupActions();
      await run("copyTree.generate", { includeContent: true }, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith("wt-active", undefined, true);
    });

    it("throws when worktreeId is omitted and no active worktree", async () => {
      const { run } = setupActions();
      await expect(run("copyTree.generate", undefined)).rejects.toThrow("No active worktree");
    });

    it("throws on a generation failure instead of returning it as success data", async () => {
      const { run } = setupActions();
      // A returned value is serialized by the MCP bridge as a SUCCESSFUL tool
      // result, so a failure reported in an `error` field is invisible to an
      // agent checking isError — it has to throw (#11543).
      copyTreeClientMock.generate.mockResolvedValueOnce({
        content: "",
        fileCount: 0,
        error: "copytree exited with code 1",
      });
      await expect(
        run("copyTree.generate", undefined, { activeWorktreeId: "wt-active" })
      ).rejects.toThrow("copytree exited with code 1");
    });

    it("returns the file handle and keeps the bundle off the result", async () => {
      const { run } = setupActions();
      // The IPC layer answers with the full CopyTreeResult shape. `content` has
      // to be dropped by this projection, not by the schema: dispatch parses
      // results now (#11539), but a parse REJECTS a value it doesn't like rather
      // than trimming it, so a bundle left in would fail the call, not shrink it.
      // A non-empty sentinel: an empty string would let a projection that
      // forwards `content` unconditionally pass this test anyway.
      copyTreeClientMock.generate.mockResolvedValueOnce({
        content: "LEAKED BUNDLE".repeat(1000),
        fileCount: 3,
        filePath: "/tmp/daintree-context/repo-main-x.xml",
        outputBytes: 31_457_280,
        outputFormatVersion: "copytree-xml@1",
        stats: { totalSize: 4096, duration: 12, estimatedTokens: 7_500_063, truncated: true },
      });

      // The budget scalars DO ride along: they are the only way a caller learns
      // the bundle it is about to read is incomplete, and they cost bytes, not
      // megabytes.
      await expect(
        run("copyTree.generate", undefined, { activeWorktreeId: "wt-active" })
      ).resolves.toEqual({
        filePath: "/tmp/daintree-context/repo-main-x.xml",
        fileCount: 3,
        outputBytes: 31_457_280,
        outputFormatVersion: "copytree-xml@1",
        stats: { totalSize: 4096, duration: 12, estimatedTokens: 7_500_063, truncated: true },
      });
    });

    it("reports a head that was not truncated as such", async () => {
      const { run } = setupActions();
      copyTreeClientMock.generate.mockResolvedValueOnce({
        content: "<files>whole</files>",
        contentTruncated: false,
        fileCount: 1,
        filePath: "/tmp/daintree-context/repo-main-x.xml",
        outputBytes: 20,
      });

      await expect(
        run("copyTree.generate", { includeContent: true }, { activeWorktreeId: "wt-active" })
      ).resolves.toMatchObject({ content: "<files>whole</files>", contentTruncated: false });
    });

    it("carries the head and its truncation flag only when one came back", async () => {
      const { run } = setupActions();
      copyTreeClientMock.generate.mockResolvedValueOnce({
        content: "<files>head</files>",
        contentTruncated: true,
        fileCount: 3,
        filePath: "/tmp/daintree-context/repo-main-x.xml",
        outputBytes: 31_457_280,
      });

      await expect(
        run("copyTree.generate", { includeContent: true }, { activeWorktreeId: "wt-active" })
      ).resolves.toEqual({
        filePath: "/tmp/daintree-context/repo-main-x.xml",
        fileCount: 3,
        outputBytes: 31_457_280,
        content: "<files>head</files>",
        contentTruncated: true,
      });
    });
  });

  describe("copyTree.generateAndCopyFile", () => {
    it("falls back to ctx.activeWorktreeId when worktreeId is omitted", async () => {
      const { run } = setupActions();
      await run("copyTree.generateAndCopyFile", undefined, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generateAndCopyFile).toHaveBeenCalledWith("wt-active", undefined);
    });

    it("returns the file handle without the bundle", async () => {
      const { run } = setupActions();
      await expect(
        run("copyTree.generateAndCopyFile", undefined, { activeWorktreeId: "wt-active" })
      ).resolves.toEqual({
        filePath: "/tmp/daintree-context/repo-main-x.xml",
        fileCount: 3,
        outputBytes: 2048,
        stats: { totalSize: 4096, duration: 12 },
      });
    });

    it("throws on a failure instead of returning it as success data", async () => {
      const { run } = setupActions();
      // Same trap #11543 fixed for `generate`: a returned value is serialized as
      // a SUCCESSFUL tool result, so an agent checking isError never sees an
      // `error` field riding back beside an empty dump.
      copyTreeClientMock.generateAndCopyFile.mockResolvedValueOnce({
        content: "",
        fileCount: 0,
        error: "Failed to copy file to clipboard: EACCES",
      });
      await expect(
        run("copyTree.generateAndCopyFile", undefined, { activeWorktreeId: "wt-active" })
      ).rejects.toThrow("Failed to copy file to clipboard: EACCES");
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

    it("reports only the counts — the context went to the terminal, not the result", async () => {
      const { run } = setupActions();
      await expect(
        run("copyTree.injectToTerminal", { terminalId: "t-1" }, { activeWorktreeId: "wt-active" })
      ).resolves.toEqual({ fileCount: 3, stats: { totalSize: 4096, duration: 12 } });
    });

    it("throws on a failure instead of returning it as success data", async () => {
      const { run } = setupActions();
      copyTreeClientMock.injectToTerminal.mockResolvedValueOnce({
        content: "",
        fileCount: 0,
        error: "Terminal closed during injection",
      });
      await expect(
        run("copyTree.injectToTerminal", { terminalId: "t-1" }, { activeWorktreeId: "wt-active" })
      ).rejects.toThrow("Terminal closed during injection");
    });
  });
});
