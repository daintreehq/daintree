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

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

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
import {
  setWorktreePathIndexAccessor,
  resetStoreAccessorsForTesting,
} from "@/store/storeAccessors";

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
  // The worktree path index leaks across files otherwise, so a later suite
  // would inherit whichever map the last path-resolution test installed.
  resetStoreAccessorsForTesting();
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
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith(
        "wt-active",
        undefined,
        undefined,
        "unknown"
      );
    });

    it("forwards options when provided", async () => {
      const { run } = setupActions();
      const options = { format: "xml" as const };
      await run("copyTree.generate", { options }, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith(
        "wt-active",
        options,
        undefined,
        "unknown"
      );
    });

    it("forwards the content opt-in so the head is only read when asked for", async () => {
      const { run } = setupActions();
      await run("copyTree.generate", { includeContent: true }, { activeWorktreeId: "wt-active" });
      expect(copyTreeClientMock.generate).toHaveBeenCalledWith(
        "wt-active",
        undefined,
        true,
        "unknown"
      );
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
      expect(copyTreeClientMock.generateAndCopyFile).toHaveBeenCalledWith(
        "wt-active",
        undefined,
        "unknown"
      );
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

    it("resolves an explicit worktreePath to the id its IPC takes", async () => {
      setWorktreePathIndexAccessor(() => new Map([["wt-landscape", "/repo/landscape"]]));
      const { run } = setupActions();
      await run(
        "copyTree.generateAndCopyFile",
        { worktreePath: "/repo/landscape" },
        { dispatchSource: "agent", activeWorktreeId: "wt-active" }
      );
      // An agent dispatch is recorded as an MCP-sourced run (#11732).
      expect(copyTreeClientMock.generateAndCopyFile).toHaveBeenCalledWith(
        "wt-landscape",
        undefined,
        "mcp"
      );
    });

    it("forwards the curated selection to the client untouched", async () => {
      // Without this, swapping the call for `generateAndCopyFile(id, undefined)`
      // leaves every other test here green while external callers silently lose
      // their selection and copy the whole worktree.
      const { getDef, run } = setupActions();
      const options = {
        includePaths: ["src/landscape/generator.ts"],
        filter: ["tests/landscape/*.test.ts"],
        format: "markdown" as const,
      };
      await run(
        "copyTree.generateAndCopyFile",
        { worktreeId: "wt-1", options },
        { dispatchSource: "agent" }
      );
      expect(copyTreeClientMock.generateAndCopyFile).toHaveBeenCalledWith("wt-1", options, "mcp");

      // And the selection SURVIVES the schema transform — `run()` is called
      // directly here, so the transform is otherwise never exercised. Asserting
      // the parsed output rather than `.success`: zod strips unknown keys and
      // still succeeds, so a dropped field would pass a success-only check
      // while real dispatch copied the whole worktree.
      const parsed = getDef("copyTree.generateAndCopyFile").argsSchema?.parse({
        worktreePath: "/repo/landscape",
        options,
      });
      expect(parsed).toEqual({ worktreePath: "/repo/landscape", options });
    });

    it("rejects a blank selection entry instead of widening it to the whole worktree", async () => {
      // An empty selection reads as "everything" downstream, so a blank must be
      // a validation error rather than something quietly dropped.
      const schema = setupActions().getDef("copyTree.generateAndCopyFile").argsSchema;
      // A blank entry and an empty list fail the same way: both leave nothing
      // selected, and nothing selected means everything one layer down.
      for (const options of [
        { includePaths: [""] },
        { includePaths: [] },
        { includePaths: ["src/a.ts", ""] },
        { filter: [""] },
        { filter: [] },
        { filter: "" },
      ]) {
        expect(schema?.safeParse({ options }).success).toBe(false);
      }
      // The valid shapes still pass, so the guard above isn't rejecting everything.
      expect(schema?.safeParse({ options: { includePaths: ["src/a.ts"] } }).success).toBe(true);
      expect(schema?.safeParse({ options: { filter: "src/**" } }).success).toBe(true);
    });

    it("refuses an explicit worktreePath that matches no open worktree", async () => {
      // Must not fall back to the active worktree: the agent named a target,
      // and quietly copying a different one is the failure this guards.
      setWorktreePathIndexAccessor(() => new Map([["wt-known", "/repo/known"]]));
      const { run } = setupActions();
      await expect(
        run(
          "copyTree.generateAndCopyFile",
          { worktreePath: "/repo/gone" },
          { dispatchSource: "agent", activeWorktreeId: "wt-active" }
        )
      ).rejects.toThrow(/no open worktree matches that path/i);
      expect(copyTreeClientMock.generateAndCopyFile).not.toHaveBeenCalled();
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("refuses an agent dispatch that names no worktree, before touching the clipboard", async () => {
      const { run } = setupActions();
      await expect(
        run("copyTree.generateAndCopyFile", undefined, {
          dispatchSource: "agent",
          activeWorktreeId: "wt-active",
        })
      ).rejects.toThrow(/requires an explicit/);
      // The guard has to fire before the copy — a rejected call that already
      // replaced the clipboard is the failure mode this exists to prevent.
      expect(copyTreeClientMock.generateAndCopyFile).not.toHaveBeenCalled();
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("toasts once on a successful agent dispatch", async () => {
      const { run } = setupActions();
      await run(
        "copyTree.generateAndCopyFile",
        { worktreeId: "wt-1", options: { format: "xml" } },
        { dispatchSource: "agent" }
      );
      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "success",
          // The message is computed from the mocked result (3 files, 4 KB, the
          // requested format), so it asserts real composition. The title is
          // pure copy — pinning the wording would force a test edit for a copy
          // tweak, so only require that the toast carries one.
          title: expect.stringMatching(/\S/),
          message: "Copied 3 files (4 KB) as XML to clipboard",
          context: { eventKind: "agent" },
        })
      );
    });

    it("gives the toast a bucket of its own rather than the shared fallback", async () => {
      // notify() derives the bucket from `rateLimitKey ?? correlationId ??
      // context.projectId ?? context.worktreeId ?? type`. With none of those set
      // it lands on `type` — pooling this with every other success toast in the
      // app, where an unrelated burst replaces the one message saying what is
      // now on the clipboard. The invariant is "not the shared bucket", not any
      // particular string.
      const { run } = setupActions();
      await run(
        "copyTree.generateAndCopyFile",
        { worktreeId: "wt-1" },
        { dispatchSource: "agent" }
      );
      const payload = notifyMock.mock.calls[0]?.[0] as { rateLimitKey?: string; type: string };
      expect(payload.rateLimitKey).toBeTruthy();
      expect(payload.rateLimitKey).not.toBe(payload.type);
    });

    it("describes the copy without a format when none was requested", async () => {
      const { run } = setupActions();
      await run(
        "copyTree.generateAndCopyFile",
        { worktreeId: "wt-1" },
        { dispatchSource: "agent" }
      );
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Copied 3 files (4 KB) to clipboard" })
      );
    });

    it("keeps the worktree out of the toast context so notify() cannot suppress it", async () => {
      // notify() routes a high-priority toast to the inbox instead when
      // `context.worktreeId` matches the worktree already on screen. An agent
      // copying the ACTIVE worktree is the common case, so naming it here would
      // silence exactly the signal this toast exists to deliver. A clipboard
      // overwrite is invisible regardless of which worktree is displayed.
      const { run } = setupActions();
      await run(
        "copyTree.generateAndCopyFile",
        { worktreeId: "wt-active" },
        { dispatchSource: "agent", activeWorktreeId: "wt-active" }
      );
      // The nested `context` is a plain object, so it is compared by deep
      // equality rather than partially: an added `worktreeId` fails this.
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ context: { eventKind: "agent" } })
      );
    });

    it("stays silent for a user-driven copy and for a source-less dispatch", async () => {
      const { run } = setupActions();
      await run("copyTree.generateAndCopyFile", undefined, {
        dispatchSource: "user",
        activeWorktreeId: "wt-active",
      });
      await run("copyTree.generateAndCopyFile", undefined, { activeWorktreeId: "wt-active" });
      // The person pressed the button; their clipboard changing is not news.
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("never announces success when the copy failed", async () => {
      const { run } = setupActions();
      copyTreeClientMock.generateAndCopyFile.mockResolvedValueOnce({
        content: "",
        fileCount: 0,
        error: "Failed to copy file to clipboard: EACCES",
      });
      await expect(
        run("copyTree.generateAndCopyFile", { worktreeId: "wt-1" }, { dispatchSource: "agent" })
      ).rejects.toThrow("EACCES");
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("never announces success when no file came back", async () => {
      const { run } = setupActions();
      copyTreeClientMock.generateAndCopyFile.mockResolvedValueOnce({
        content: "",
        fileCount: 3,
        // No filePath: the clipboard write had nothing to point at.
      });
      await expect(
        run("copyTree.generateAndCopyFile", { worktreeId: "wt-1" }, { dispatchSource: "agent" })
      ).rejects.toThrow();
      expect(notifyMock).not.toHaveBeenCalled();
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
        undefined,
        undefined,
        "unknown"
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
        undefined,
        undefined,
        "unknown"
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

  // #11731. An empty bundle used to arrive as `noFilesMatched: true` and nothing
  // else, so a caller that had passed a bare directory could not tell which of
  // its fields to correct. All three actions project the same stats, and all
  // three are the MCP surface a caller hits, so a hint on one of them is a hint
  // two thirds of callers never see.
  describe("empty-result attribution across the copyTree actions", () => {
    const EMPTY_RUN = {
      content: "",
      fileCount: 0,
      filePath: "/tmp/daintree-context/repo-main-x.xml",
      outputBytes: 460,
      stats: {
        totalSize: 0,
        duration: 1800,
        noFilesMatched: true,
        unmatchedSelector: "includePaths" as const,
        // Present on the IPC result, and deliberately NOT forwarded: the
        // per-reason breakdown is the bulk #11528 took off this surface, and
        // `unmatchedSelector` exists so a caller never needs it.
        excluded: { total: 42, byReason: { filterPattern: 42 } },
      },
    };

    const CASES = [
      { id: "copyTree.generate", mock: copyTreeClientMock.generate, args: undefined },
      {
        id: "copyTree.generateAndCopyFile",
        mock: copyTreeClientMock.generateAndCopyFile,
        args: { worktreeId: "wt-active" },
      },
      {
        id: "copyTree.injectToTerminal",
        mock: copyTreeClientMock.injectToTerminal,
        args: { terminalId: "t-1" },
      },
    ];

    it.each(CASES)(
      "$id names the selector that missed and drops the breakdown",
      async ({ id, mock, args }) => {
        const { run, getDef } = setupActions();
        mock.mockResolvedValueOnce({ ...EMPTY_RUN });

        const result = (await run(id, args, { activeWorktreeId: "wt-active" })) as {
          stats?: Record<string, unknown>;
        };

        expect(result.stats).toMatchObject({
          noFilesMatched: true,
          unmatchedSelector: "includePaths",
        });
        expect(result.stats).not.toHaveProperty("excluded");

        // Parsed through the action's own resultSchema, not just inspected:
        // dispatch parses results (#11539), so a field the projection returns but
        // the schema never declared is a field the caller is never sent — and an
        // enum out of step with the shared tuple would fail the call outright.
        const resultSchema = getDef(id).resultSchema;
        expect(resultSchema).toBeDefined();
        expect(resultSchema?.parse(result)).toMatchObject({
          stats: { unmatchedSelector: "includePaths" },
        });
      }
    );

    it("omits the hint entirely when nothing was to blame", async () => {
      const { run } = setupActions();
      copyTreeClientMock.generate.mockResolvedValueOnce({
        ...EMPTY_RUN,
        stats: { totalSize: 0, duration: 1800, noFilesMatched: true },
      });

      const result = (await run("copyTree.generate", undefined, {
        activeWorktreeId: "wt-active",
      })) as { stats?: Record<string, unknown> };

      // Absent rather than null: an empty scope or an empty worktree has no
      // selector at fault, and a present-but-empty field reads as one.
      expect(result.stats).not.toHaveProperty("unmatchedSelector");
      expect(result.stats).toMatchObject({ noFilesMatched: true });
    });
  });
});
