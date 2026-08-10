import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import nodeFs from "fs/promises";
import nodeOs from "os";
import nodePath from "path";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const clipboardMock = vi.hoisted(() => ({
  writeBuffer: vi.fn(),
  writeText: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  // `path` is load-bearing, not decoration: the worktree lookup selects a
  // workspace host by the sender project's path (#11751), so a row without one
  // would resolve no worktrees at all.
  getProjectById: vi.fn<(projectId: string) => { id: string; path: string; status: string } | null>(
    () => null
  ),
  getProjectSettings: vi.fn<(projectId: string) => Promise<unknown>>(),
}));

/** Structural stand-in for ProjectViewManager — only the binding lookup is read. */
interface TestProjectViewManager {
  getProjectIdForWebContents: (webContentsId: number) => string | null;
}

const browserWindowMock = vi.hoisted(() => ({
  fromWebContents: vi.fn<() => { id: number; isDestroyed: () => boolean } | null>(() => null),
  getAllWindows: vi.fn(() => []),
}));

// windowRef holds the process-global ProjectViewManager that typedHandleWithContext
// reads to populate ctx.projectId. Mocked so a test can point it at the WRONG
// project and prove the handlers resolve settings from the sender's window instead.
const windowRefMock = vi.hoisted(() => ({
  getProjectViewManager: vi.fn<() => TestProjectViewManager | null>(() => null),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  clipboard: clipboardMock,
  BrowserWindow: browserWindowMock,
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

// Typed to the production signature so a parameter change fails at compile time
// rather than silently leaving the assertions below asserting the wrong shape.
const copyTreeHistoryMock = vi.hoisted(() => ({
  recordCopyTreeRun:
    vi.fn<
      (
        projectId: string | null,
        input: import("../../../../shared/types/ipc/copyTreeHistory.js").CopyTreeHistoryAppendInput
      ) => Promise<void>
    >(),
}));

vi.mock("../../../services/copyTreeHistoryService.js", () => copyTreeHistoryMock);

vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: windowRefMock.getProjectViewManager,
  setProjectViewManager: vi.fn(),
  getWindowRegistry: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setMainWindow: vi.fn(),
}));

import type { CopyTreeHistoryAppendInput } from "../../../../shared/types/ipc/copyTreeHistory.js";
import { CHANNELS } from "../../channels.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { contextDir, _resetReservedPathsForTests } from "../../../services/copyTreeOutputFile.js";
import {
  registerCopyTreeHandlers,
  mergeCopyTreeOptions,
  buildRemoteComputeBlock,
  escapeXml,
  nextChunkBoundary,
} from "../copyTree.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("copyTree handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but keeps implementations/return values,
    // so restore the no-window / no-PVM baseline each test.
    browserWindowMock.fromWebContents.mockReturnValue(null);
    windowRefMock.getProjectViewManager.mockReturnValue(null);
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
    projectStoreMock.getProjectById.mockReturnValue(null);
    projectStoreMock.getProjectSettings.mockReset();
    registerCopyTreeHandlers({
      mainWindow: {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: vi.fn(),
        },
      },
      ptyClient: {
        hasTerminal: vi.fn(() => false),
        write: vi.fn(),
      },
      worktreeService: undefined,
    } as never);
  });

  const mockEvent = { sender: { id: 1 } } as never;

  it("returns validation errors instead of throwing for invalid generate payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await expect(handler(mockEvent, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/^Invalid payload$/),
      })
    );
  });

  it("returns validation errors instead of throwing for invalid generate-and-copy payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE);

    await expect(handler(mockEvent, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/^Invalid payload$/),
      })
    );
  });

  it("returns validation errors instead of throwing for invalid inject payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_INJECT);

    await expect(handler(mockEvent, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/^Invalid payload$/),
      })
    );
  });

  it("returns validation errors instead of throwing for invalid test-config payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_TEST_CONFIG);

    await expect(handler(mockEvent, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/^Invalid payload$/),
      })
    );
  });

  it("accepts sarif format in generate payload", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await expect(
      handler(mockEvent, {
        worktreeId: "wt-1",
        options: { format: "sarif" },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        error: expect.not.stringContaining("Invalid payload"),
      })
    );
  });

  it("accepts null-cleared fields in test-config payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_TEST_CONFIG);

    // copyTree channels share the "fileOps" rate-limit bucket; advance past the
    // window so earlier handler calls in this suite don't preempt validation.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(11_000);
      await expect(
        handler(mockEvent, {
          worktreeId: "wt-1",
          options: { maxTotalSize: null, charLimit: null, exclude: null, always: null, sort: null },
        })
      ).resolves.toEqual(
        expect.objectContaining({
          error: expect.not.stringMatching(/^Invalid payload$/),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws a sanitized ValidationError without Zod detail for invalid file tree requests", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GET_FILE_TREE);

    // copyTree channels share the "fileOps" rate-limit bucket; earlier handler
    // calls in this suite exhaust the window. Advance past it so the rate
    // limiter doesn't preempt the validation path under test.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(11_000);
      await expect(handler(mockEvent, null as never)).rejects.toThrow(
        `IPC validation failed: ${CHANNELS.COPYTREE_GET_FILE_TREE}`
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("test-config merge integration", () => {
    const projectSettingsFixture = {
      excludedPaths: [],
      copyTreeSettings: { maxContextSize: 9999, alwaysInclude: ["*.md"] },
    };

    function registerWithWorktreeService() {
      const testConfig = vi.fn().mockResolvedValue({
        includedFiles: 1,
        includedSize: 1,
      });
      // Re-register so the channel resolves to a handler whose worktreeService
      // is live; clear ipcMain.handle first so getInvokeHandler finds this one.
      ipcMainMock.handle.mockClear();
      registerCopyTreeHandlers({
        mainWindow: {
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, send: vi.fn() },
        },
        ptyClient: { hasTerminal: vi.fn(() => false), write: vi.fn() },
        worktreeService: {
          getAllStatesAsync: vi.fn().mockResolvedValue([{ id: "wt-1", path: "/wt-1" }]),
          getAllStatesForProjectAsync: vi.fn().mockResolvedValue([{ id: "wt-1", path: "/wt-1" }]),
          testConfig,
        },
      } as never);
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1" as never);
      projectStoreMock.getProjectById.mockReturnValue({
        id: "proj-1",
        path: "/proj-1",
        status: "active",
      });
      projectStoreMock.getProjectSettings.mockResolvedValue(projectSettingsFixture as never);
      return testConfig;
    }

    async function invokeTestConfig(options: unknown) {
      const handler = getInvokeHandler(CHANNELS.COPYTREE_TEST_CONFIG);
      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(11_000);
        await handler(mockEvent, { worktreeId: "wt-1", options });
      } finally {
        vi.useRealTimers();
      }
    }

    it("does not back-fill saved settings over null-cleared fields", async () => {
      const testConfig = registerWithWorktreeService();

      await invokeTestConfig({ maxTotalSize: null, always: null });

      const [, mergedOptions] = testConfig.mock.calls[0];
      expect("maxTotalSize" in mergedOptions).toBe(false);
      expect("always" in mergedOptions).toBe(false);
    });

    it("back-fills saved settings for absent fields", async () => {
      const testConfig = registerWithWorktreeService();

      await invokeTestConfig({});

      const [, mergedOptions] = testConfig.mock.calls[0];
      expect(mergedOptions.maxTotalSize).toBe(
        projectSettingsFixture.copyTreeSettings.maxContextSize
      );
      expect(mergedOptions.always).toEqual(projectSettingsFixture.copyTreeSettings.alwaysInclude);
    });
  });

  describe("get-file-tree merge integration", () => {
    const projectSettingsFixture = {
      excludedPaths: ["vendor/**"],
      copyTreeSettings: { maxContextSize: 4242, alwaysInclude: ["*.md"] },
    };

    function registerWithFileTree() {
      const getContextFileTree = vi.fn().mockResolvedValue([]);
      const getFileTree = vi.fn().mockResolvedValue([]);
      ipcMainMock.handle.mockClear();
      registerCopyTreeHandlers({
        mainWindow: {
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, send: vi.fn() },
        },
        ptyClient: { hasTerminal: vi.fn(() => false), write: vi.fn() },
        worktreeService: {
          getAllStatesAsync: vi.fn().mockResolvedValue([{ id: "wt-1", path: "/wt-1" }]),
          getAllStatesForProjectAsync: vi.fn().mockResolvedValue([{ id: "wt-1", path: "/wt-1" }]),
          getContextFileTree,
          getFileTree,
        },
      } as never);
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1" as never);
      projectStoreMock.getProjectById.mockReturnValue({
        id: "proj-1",
        path: "/proj-1",
        status: "active",
      });
      projectStoreMock.getProjectSettings.mockResolvedValue(projectSettingsFixture as never);
      return { getContextFileTree, getFileTree };
    }

    async function invokeGetFileTree(payload: Record<string, unknown>) {
      const handler = getInvokeHandler(CHANNELS.COPYTREE_GET_FILE_TREE);
      _resetRateLimitQueuesForTest();
      return handler(mockEvent, { worktreeId: "wt-1", ...payload });
    }

    it("answers from the context listing, never the raw one", async () => {
      // The raw listing returns every entry, `.git` and gitignored folders
      // included. Routing the picker there is the leak this channel must not
      // reintroduce (#11439).
      const { getContextFileTree, getFileTree } = registerWithFileTree();

      await invokeGetFileTree({ dirPath: "src" });

      expect(getContextFileTree).toHaveBeenCalledTimes(1);
      expect(getFileTree).not.toHaveBeenCalled();
      expect(getContextFileTree.mock.calls[0][0]).toBe("/wt-1");
      expect(getContextFileTree.mock.calls[0][1]).toBe("src");
    });

    it("applies the project's saved context settings to the listing", async () => {
      // Without this the listing answers for CopyTree's defaults while the
      // bundle is built with the project's exclusions and budgets — the two
      // engines disagreeing again, one layer up.
      const { getContextFileTree } = registerWithFileTree();

      await invokeGetFileTree({});

      const mergedOptions = getContextFileTree.mock.calls[0][2];
      expect(mergedOptions.maxTotalSize).toBe(
        projectSettingsFixture.copyTreeSettings.maxContextSize
      );
      expect(mergedOptions.always).toEqual(projectSettingsFixture.copyTreeSettings.alwaysInclude);
      expect(mergedOptions.exclude).toEqual(projectSettingsFixture.excludedPaths);
    });

    it("forwards the opt-in for excluded entries", async () => {
      const { getContextFileTree } = registerWithFileTree();

      await invokeGetFileTree({ includeExcluded: true });

      expect(getContextFileTree.mock.calls[0][3]).toBe(true);
    });

    it("defaults to omitting excluded entries", async () => {
      const { getContextFileTree } = registerWithFileTree();

      await invokeGetFileTree({});

      expect(getContextFileTree.mock.calls[0][3]).toBeUndefined();
    });

    it("rejects a dirPath that escapes the worktree", async () => {
      const { getContextFileTree } = registerWithFileTree();

      await expect(invokeGetFileTree({ dirPath: "../outside" })).rejects.toThrow(
        "cannot traverse outside worktree root"
      );
      expect(getContextFileTree).not.toHaveBeenCalled();
    });

    it("rejects an absolute dirPath", async () => {
      const { getContextFileTree } = registerWithFileTree();

      await expect(invokeGetFileTree({ dirPath: "/etc" })).rejects.toThrow(
        "dirPath must be a relative path"
      );
      expect(getContextFileTree).not.toHaveBeenCalled();
    });

    it("rejects a traversal segment buried mid-path", async () => {
      const { getContextFileTree } = registerWithFileTree();

      await expect(invokeGetFileTree({ dirPath: "src/../../etc" })).rejects.toThrow(
        "cannot traverse outside worktree root"
      );
      expect(getContextFileTree).not.toHaveBeenCalled();
    });

    it("allows a directory whose name merely begins with dots", async () => {
      // `..cache` is a legal directory name; only a `..` path segment traverses.
      const { getContextFileTree } = registerWithFileTree();

      await invokeGetFileTree({ dirPath: "..cache" });

      expect(getContextFileTree.mock.calls[0][1]).toBe("..cache");
    });
  });

  describe("project-scoped settings resolution", () => {
    const SENDER_WINDOW_ID = 42;
    const SENDER_PROJECT = "proj-sender";
    const GLOBAL_PROJECT = "proj-global";

    const projectPathFor = (projectId: string) => `/repos/${projectId}`;
    /**
     * A worktree only that project owns. Real worktree ids are normalized
     * absolute paths, so they never collide across projects — that uniqueness
     * is what lets a cross-project lookup be caught (#11751).
     */
    const ownWorktreeIdFor = (projectId: string) => `${projectPathFor(projectId)}/own-wt`;

    /**
     * Every project also answers for the shared `wt-1` fixture the merge cases
     * request, at its own path, so those cases keep exercising the merge rather
     * than tripping the worktree guard.
     */
    const worktreesFor = (projectId: string) => [
      { id: "wt-1", path: `${projectPathFor(projectId)}/wt-1` },
      { id: ownWorktreeIdFor(projectId), path: `${projectPathFor(projectId)}/own-wt` },
    ];

    // copyTree channels share one rate-limit bucket, and earlier tests in this
    // file exhaust it. Clear the bucket instead of advancing fake timers: each
    // vi.useFakeTimers() re-seeds from the real clock, so a fixed advance keeps
    // landing every call in the same window rather than moving past it.
    beforeEach(() => {
      _resetRateLimitQueuesForTest();
    });

    const senderSettings = {
      excludedPaths: ["sender-only/**"],
      copyTreeSettings: { maxContextSize: 1111, alwaysInclude: ["SENDER.md"] },
    };
    const globalSettings = {
      excludedPaths: ["global-only/**"],
      copyTreeSettings: { maxContextSize: 2222, alwaysInclude: ["GLOBAL.md"] },
    };

    function makePvm(boundProjectId: string | null): TestProjectViewManager {
      return { getProjectIdForWebContents: vi.fn(() => boundProjectId) };
    }

    // Aim every process-global "current project" source at GLOBAL_PROJECT, so a
    // handler that reads any of them (the #11103 bug, or a naive ctx.projectId
    // fix — ctx.projectId is derived from the windowRef global) resolves the
    // wrong project and fails the assertions.
    function aimGlobalSourcesAtGlobalProject() {
      windowRefMock.getProjectViewManager.mockReturnValue(makePvm(GLOBAL_PROJECT));
      projectStoreMock.getCurrentProjectId.mockReturnValue(GLOBAL_PROJECT);
    }

    function registerWithScope(options: {
      windowScopedPvm?: TestProjectViewManager;
      depsPvm?: TestProjectViewManager;
      withSenderWindow?: boolean;
      /** Runs when the handler awaits the workspace, i.e. mid-request. */
      onWorkspaceCall?: () => void;
    }) {
      const testConfig = vi.fn().mockResolvedValue({
        includedFiles: 1,
        includedSize: 1,
      });
      const generateContext = vi.fn().mockResolvedValue({ content: "", fileCount: 1 });
      const getContextFileTree = vi.fn().mockResolvedValue([]);
      // The window-scoped read answers for whatever project the window shows —
      // GLOBAL_PROJECT throughout this block. Kept mocked, and kept returning a
      // usable list, so a handler that regressed to it would *pass* its lookup
      // and be caught by the explicit "never called" assertions rather than by
      // an incidental crash.
      const getAllStatesAsync = vi.fn(async () => worktreesFor(GLOBAL_PROJECT));
      const getAllStatesForProjectAsync = vi.fn(
        async (projectPath: string, expectedProjectId: string) => {
          options.onWorkspaceCall?.();
          // Mirrors the production guard: the path selects the host, the id
          // authorizes it, and a mismatch resolves nothing.
          return projectPath === projectPathFor(expectedProjectId)
            ? worktreesFor(expectedProjectId)
            : [];
        }
      );

      if (options.withSenderWindow !== false) {
        browserWindowMock.fromWebContents.mockReturnValue({
          id: SENDER_WINDOW_ID,
          isDestroyed: () => false,
        });
      }

      projectStoreMock.getProjectById.mockImplementation((projectId) => ({
        id: projectId,
        path: projectPathFor(projectId),
        status: "active",
      }));
      projectStoreMock.getProjectSettings.mockImplementation(async (projectId) =>
        projectId === SENDER_PROJECT ? senderSettings : globalSettings
      );

      ipcMainMock.handle.mockClear();
      registerCopyTreeHandlers({
        mainWindow: {
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, send: vi.fn() },
        },
        ptyClient: { hasTerminal: vi.fn(() => true), write: vi.fn() },
        worktreeService: {
          // Kept mocked so the assertions can prove it is never consulted: a
          // window-scoped read answers for whatever project the window shows,
          // which is the bug (#11751).
          getAllStatesAsync,
          getAllStatesForProjectAsync,
          testConfig,
          generateContext,
          getContextFileTree,
        },
        windowRegistry: options.windowScopedPvm
          ? {
              getByWindowId: (windowId: number) =>
                windowId === SENDER_WINDOW_ID
                  ? { services: { projectViewManager: options.windowScopedPvm } }
                  : undefined,
            }
          : undefined,
        projectViewManager: options.depsPvm,
      } as never);

      return {
        testConfig,
        generateContext,
        getContextFileTree,
        getAllStatesAsync,
        getAllStatesForProjectAsync,
      };
    }

    /**
     * Every handler that merges project settings, with the seam it hands the
     * merged options to and the argument position they land in. All cases run
     * against all of them so a regression in one call site can't hide behind the
     * others — picking the wrong project's settings is this code's recurring bug
     * (#11103, #6015), and for the file tree it would put the picker and the
     * bundle back on different settings (#11439).
     */
    const SCOPED_CALL_SITES = [
      {
        channel: CHANNELS.COPYTREE_TEST_CONFIG,
        seam: "testConfig" as const,
        payload: {},
        optionsArgIndex: 1,
        acceptsRuntimeOptions: true,
      },
      {
        channel: CHANNELS.COPYTREE_GENERATE,
        seam: "generateContext" as const,
        payload: {},
        optionsArgIndex: 1,
        acceptsRuntimeOptions: true,
      },
      {
        channel: CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE,
        seam: "generateContext" as const,
        payload: {},
        optionsArgIndex: 1,
        acceptsRuntimeOptions: true,
      },
      {
        channel: CHANNELS.COPYTREE_INJECT,
        seam: "generateContext" as const,
        payload: { terminalId: "term-1" },
        optionsArgIndex: 1,
        acceptsRuntimeOptions: true,
      },
      {
        // The listing takes no per-call options: it answers for the project's
        // merged settings alone so its whole-root dry run stays comparable with
        // the bundle it predicts (#11446).
        channel: CHANNELS.COPYTREE_GET_FILE_TREE,
        seam: "getContextFileTree" as const,
        payload: {},
        optionsArgIndex: 2,
        acceptsRuntimeOptions: false,
      },
    ];

    async function invoke(channel: string, extraPayload: Record<string, unknown>) {
      const handler = getInvokeHandler(channel);
      await handler(mockEvent, { worktreeId: "wt-1", options: {}, ...extraPayload });
    }

    /**
     * The message for a refused worktree, whichever shape the channel uses:
     * get-file-tree rejects, the rest resolve with an `error` field. Written to
     * accept either so a channel that changed shape can't quietly pass.
     */
    async function invokeExpectingRefusal(
      channel: string,
      extraPayload: Record<string, unknown>
    ): Promise<string | undefined> {
      const handler = getInvokeHandler(channel);
      try {
        const result = (await handler(mockEvent, {
          worktreeId: "wt-1",
          options: {},
          ...extraPayload,
        })) as { error?: string } | undefined;
        return result?.error;
      } catch (error) {
        return (error as Error).message;
      }
    }

    describe.each(SCOPED_CALL_SITES)(
      "$channel",
      ({ channel, seam, payload, optionsArgIndex, acceptsRuntimeOptions }) => {
        it("merges the sender window's project settings, not the globally current project's", async () => {
          aimGlobalSourcesAtGlobalProject();
          const seams = registerWithScope({
            windowScopedPvm: makePvm(SENDER_PROJECT),
            depsPvm: makePvm(GLOBAL_PROJECT),
          });

          await invoke(channel, payload);

          const mergedOptions = seams[seam].mock.calls[0][optionsArgIndex];
          expect(mergedOptions.maxTotalSize).toBe(senderSettings.copyTreeSettings.maxContextSize);
          expect(mergedOptions.maxTotalSize).not.toBe(
            globalSettings.copyTreeSettings.maxContextSize
          );
          expect(mergedOptions.always).toEqual(senderSettings.copyTreeSettings.alwaysInclude);
          expect(mergedOptions.exclude).toEqual(senderSettings.excludedPaths);
          expect(mergedOptions.exclude).not.toContain(globalSettings.excludedPaths[0]);
          expect(projectStoreMock.getProjectSettings).toHaveBeenCalledWith(SENDER_PROJECT);
          expect(projectStoreMock.getCurrentProjectId).not.toHaveBeenCalled();
        });

        it("refuses the request outright when the sender's view is unbound", async () => {
          aimGlobalSourcesAtGlobalProject();
          const depsPvm = makePvm(GLOBAL_PROJECT);
          const seams = registerWithScope({ windowScopedPvm: makePvm(null), depsPvm });

          const error = await invokeExpectingRefusal(channel, payload);

          // An unbound view names no project, and every copyTree channel makes
          // worktreeId mandatory — so there is nothing to resolve it against.
          // Before #11751 this ran to completion against whichever worktree the
          // *window* was showing, producing a bundle from a project the caller
          // never named and with none of its settings applied.
          expect(error).toBe("Worktree not found: wt-1");
          expect(seams[seam]).not.toHaveBeenCalled();
          expect(seams.getAllStatesAsync).not.toHaveBeenCalled();
          // Still the original guarantee: no global source may be consulted.
          expect(depsPvm.getProjectIdForWebContents).not.toHaveBeenCalled();
          expect(projectStoreMock.getProjectSettings).not.toHaveBeenCalled();
          expect(projectStoreMock.getCurrentProjectId).not.toHaveBeenCalled();
        });

        it("resolves the worktree in the sender's project, not the window's", async () => {
          aimGlobalSourcesAtGlobalProject();
          const seams = registerWithScope({
            windowScopedPvm: makePvm(SENDER_PROJECT),
            depsPvm: makePvm(GLOBAL_PROJECT),
          });

          await invoke(channel, payload);

          expect(seams.getAllStatesForProjectAsync).toHaveBeenCalledWith(
            projectPathFor(SENDER_PROJECT),
            SENDER_PROJECT
          );
          expect(seams.getAllStatesAsync).not.toHaveBeenCalled();
          // The path handed downstream is the sender project's copy of wt-1 —
          // proof the resolved snapshot, not just the lookup, came from A.
          expect(seams[seam].mock.calls[0][0]).toBe(`${projectPathFor(SENDER_PROJECT)}/wt-1`);
        });

        it("refuses a worktree that belongs to the window's project", async () => {
          aimGlobalSourcesAtGlobalProject();
          const seams = registerWithScope({
            windowScopedPvm: makePvm(SENDER_PROJECT),
            depsPvm: makePvm(GLOBAL_PROJECT),
          });

          // Worktree ids are normalized absolute paths, so a renderer can guess
          // a sibling project's. The window is showing GLOBAL_PROJECT, so the
          // pre-#11751 lookup would have found this and bundled its contents.
          const error = await invokeExpectingRefusal(channel, {
            ...payload,
            worktreeId: ownWorktreeIdFor(GLOBAL_PROJECT),
          });

          expect(error).toBe(`Worktree not found: ${ownWorktreeIdFor(GLOBAL_PROJECT)}`);
          expect(seams[seam]).not.toHaveBeenCalled();
          expect(seams.getAllStatesForProjectAsync).toHaveBeenCalledWith(
            projectPathFor(SENDER_PROJECT),
            SENDER_PROJECT
          );
          expect(seams.getAllStatesAsync).not.toHaveBeenCalled();
        });

        it("refuses a scratch sender, which has a workspace but no worktrees", async () => {
          aimGlobalSourcesAtGlobalProject();
          const seams = registerWithScope({
            windowScopedPvm: makePvm("scratch-1"),
            depsPvm: makePvm(GLOBAL_PROJECT),
          });
          // A scratch is a workspace id with no project row (#11484); scratch
          // switching never invokes the worktree service at all.
          projectStoreMock.getProjectById.mockReturnValue(null);

          const error = await invokeExpectingRefusal(channel, payload);

          expect(error).toBe("Worktree not found: wt-1");
          expect(seams[seam]).not.toHaveBeenCalled();
          expect(seams.getAllStatesAsync).not.toHaveBeenCalled();
          expect(seams.getAllStatesForProjectAsync).not.toHaveBeenCalled();
        });

        it("keeps the sender's project settings when the view is evicted mid-request", async () => {
          aimGlobalSourcesAtGlobalProject();
          // The view's binding survives until the handler awaits the workspace,
          // then eviction drops it — the settings must already be pinned by then.
          let boundProject: string | null = SENDER_PROJECT;
          const seams = registerWithScope({
            windowScopedPvm: { getProjectIdForWebContents: vi.fn(() => boundProject) },
            depsPvm: makePvm(GLOBAL_PROJECT),
            onWorkspaceCall: () => {
              boundProject = null;
            },
          });

          await invoke(channel, payload);

          const mergedOptions = seams[seam].mock.calls[0][optionsArgIndex];
          expect(mergedOptions.exclude).toEqual(senderSettings.excludedPaths);
          expect(mergedOptions.maxTotalSize).toBe(senderSettings.copyTreeSettings.maxContextSize);
          expect(projectStoreMock.getProjectSettings).toHaveBeenCalledWith(SENDER_PROJECT);
        });

        it.runIf(acceptsRuntimeOptions)(
          "carries scoped folder paths through validation to the service",
          async () => {
            aimGlobalSourcesAtGlobalProject();
            const seams = registerWithScope({
              windowScopedPvm: makePvm(SENDER_PROJECT),
              depsPvm: makePvm(GLOBAL_PROJECT),
            });

            await invoke(channel, { ...payload, options: { scopePaths: ["src/panels"] } });

            const mergedOptions = seams[seam].mock.calls[0][optionsArgIndex];
            // A field missing from the schema is dropped silently by Zod, so the
            // folder copy would degrade to a whole-worktree copy with no error.
            expect(mergedOptions.scopePaths).toEqual(["src/panels"]);
          }
        );

        it.skipIf(acceptsRuntimeOptions)(
          "never lets a caller scope the listing's dry run",
          async () => {
            aimGlobalSourcesAtGlobalProject();
            const seams = registerWithScope({
              windowScopedPvm: makePvm(SENDER_PROJECT),
              depsPvm: makePvm(GLOBAL_PROJECT),
            });

            await invoke(channel, { ...payload, options: { scopePaths: ["src/panels"] } });

            // The listing's budgets are recomputed over whatever the walk saw, so
            // a scoped listing would answer for a subtree while the bundle is
            // built from the root — the disagreement the channel exists to end.
            const mergedOptions = seams[seam].mock.calls[0][optionsArgIndex];
            expect(mergedOptions.scopePaths).toBeUndefined();
          }
        );

        it("falls back to the current project when no project-scoped view manager exists", async () => {
          projectStoreMock.getCurrentProjectId.mockReturnValue(GLOBAL_PROJECT);
          const seams = registerWithScope({ withSenderWindow: false });

          await invoke(channel, payload);

          const mergedOptions = seams[seam].mock.calls[0][optionsArgIndex];
          expect(mergedOptions.maxTotalSize).toBe(globalSettings.copyTreeSettings.maxContextSize);
          expect(mergedOptions.always).toEqual(globalSettings.copyTreeSettings.alwaysInclude);
          expect(projectStoreMock.getProjectSettings).toHaveBeenCalledWith(GLOBAL_PROJECT);
          // The lenient fallback is deliberate, and it still resolves the
          // worktree through the project it settled on — a senderless call must
          // never reach the unscoped read, which unions every live host.
          expect(seams.getAllStatesForProjectAsync).toHaveBeenCalledWith(
            projectPathFor(GLOBAL_PROJECT),
            GLOBAL_PROJECT
          );
          expect(seams.getAllStatesAsync).not.toHaveBeenCalled();
        });
      }
    );
  });
});

const mockSender = { sender: { id: 1 } } as never;

describe("file-backed generation", () => {
  let tmpRoot: string;
  /** The destination the handler reserved and handed to the workspace host. */
  let lastOutputPath: string | undefined;

  /**
   * Stand in for the workspace host: write the bundle where the handler asked,
   * exactly as the streaming service does, and report only the path back.
   */
  function makeService(body: string, overrides: Record<string, unknown> = {}) {
    const generateContext = vi.fn(
      async (_root: string, _options: unknown, _onProgress: unknown, outputPath?: string) => {
        lastOutputPath = outputPath;
        if (!outputPath) return { content: body, fileCount: 2 };
        await nodeFs.writeFile(outputPath, body, { encoding: "utf8", mode: 0o600 });
        return {
          content: "",
          fileCount: 2,
          filePath: outputPath,
          outputBytes: Buffer.byteLength(body, "utf8"),
          stats: { totalSize: 10, duration: 3 },
          ...overrides,
        };
      }
    );

    browserWindowMock.fromWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });
    ipcMainMock.handle.mockClear();
    registerCopyTreeHandlers({
      mainWindow: {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: vi.fn() },
      },
      ptyClient: { hasTerminal: vi.fn(() => true), write: vi.fn() },
      worktreeService: {
        getAllStatesForProjectAsync: vi.fn(async () => [
          { id: "wt-1", path: "/repos/daintree", branch: "main" },
        ]),
        generateContext,
        testConfig: vi.fn(),
        getContextFileTree: vi.fn(),
      },
    } as never);
    return generateContext;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
    _resetReservedPathsForTests();
    lastOutputPath = undefined;
    tmpRoot = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "daintree-handlers-"));
    // contextDir() reads os.tmpdir() per call, so redirecting the temp vars
    // keeps every bundle this suite writes inside its own scratch directory.
    vi.stubEnv("TMPDIR", tmpRoot);
    vi.stubEnv("TEMP", tmpRoot);
    vi.stubEnv("TMP", tmpRoot);
    // These cases are about the bundle's destination, not project scoping, but
    // the worktree lookup still has to resolve — so give them a project to
    // resolve through. getProjectSettings stays unset, so no settings merge in.
    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-file-backed");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-file-backed",
      path: "/repos/daintree",
      status: "active",
    });
    projectStoreMock.getProjectSettings.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await nodeFs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns a path instead of the bundle, and never asks the host for the string", async () => {
    const body = "<files>a very large bundle</files>";
    const generateContext = makeService(body);
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    const result = (await handler(mockSender, { worktreeId: "wt-1" })) as Record<string, unknown>;

    expect(result.filePath).toBe(lastOutputPath);
    expect(result.content).toBe("");
    expect(result.outputBytes).toBe(Buffer.byteLength(body, "utf8"));
    // The destination reached the host, which is what keeps the bundle off the
    // worker → host → main crossings.
    expect(generateContext.mock.calls[0][3]).toBe(lastOutputPath);
    expect(await nodeFs.readFile(result.filePath as string, "utf8")).toBe(body);
  });

  it("writes the bundle into the shared context directory", async () => {
    makeService("<files/>");
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    const result = (await handler(mockSender, { worktreeId: "wt-1" })) as Record<string, unknown>;

    expect(nodePath.dirname(result.filePath as string)).toBe(contextDir());
    expect(nodePath.basename(result.filePath as string)).toMatch(/^daintree-main-.*\.xml$/);
  });

  it("takes the extension from the merged format", async () => {
    makeService("# context");
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    const result = (await handler(mockSender, {
      worktreeId: "wt-1",
      options: { format: "markdown" },
    })) as Record<string, unknown>;

    expect(result.filePath).toMatch(/\.md$/);
  });

  it("omits content unless it was asked for", async () => {
    makeService("<files>body</files>");
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    const result = (await handler(mockSender, { worktreeId: "wt-1" })) as Record<string, unknown>;

    expect(result.content).toBe("");
    expect(result.contentTruncated).toBeUndefined();
  });

  it("reads a small bundle back whole when content was asked for", async () => {
    makeService("<files>body</files>");
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    const result = (await handler(mockSender, {
      worktreeId: "wt-1",
      includeContent: true,
    })) as Record<string, unknown>;

    expect(result.content).toBe("<files>body</files>");
    expect(result.contentTruncated).toBe(false);
    expect(result.filePath).toBe(lastOutputPath);
  });

  it("keeps an opted-in result inside the tool-result budget for a huge bundle", async () => {
    makeService("<file>".concat("x".repeat(400_000), "</file>"));
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    const result = (await handler(mockSender, {
      worktreeId: "wt-1",
      includeContent: true,
    })) as Record<string, unknown>;

    expect(result.contentTruncated).toBe(true);
    // The transport drops structuredContent and flags isError past 50 KiB, so
    // the opt-in is only useful if the whole serialized result stays under it.
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(50 * 1024);
    // The file still holds everything the head was cut from.
    expect((await nodeFs.stat(result.filePath as string)).size).toBeGreaterThan(400_000);
  });

  it("ignores an output path supplied by the caller", async () => {
    const generateContext = makeService("<files/>");
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);
    const hijack = nodePath.join(tmpRoot, "attacker-owned.xml");

    const result = (await handler(mockSender, {
      worktreeId: "wt-1",
      outputPath: hijack,
      options: { outputPath: hijack, output: hijack },
    })) as Record<string, unknown>;

    // The destination is main's alone. Honouring a caller's would turn a
    // context dump into an arbitrary file write for any MCP consumer.
    expect(generateContext.mock.calls[0][3]).not.toBe(hijack);
    expect(result.filePath).not.toBe(hijack);
    await expect(nodeFs.access(hijack)).rejects.toThrow();
  });

  it("refuses a result that names a file other than the one reserved", async () => {
    makeService("<files/>", { filePath: "/tmp/somewhere-else.xml" });
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    const result = (await handler(mockSender, { worktreeId: "wt-1" })) as Record<string, unknown>;

    expect(result.error).toBe("Failed to generate context");
    expect(result.filePath).toBeUndefined();
  });

  it("puts the host-written file on the clipboard without rewriting it in main", async () => {
    const generateContext = makeService("<files>clipboard me</files>");
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE);

    const result = (await handler(mockSender, { worktreeId: "wt-1" })) as Record<string, unknown>;

    expect(result.filePath).toBe(lastOutputPath);
    expect(result.content).toBe("");
    expect(generateContext.mock.calls[0][3]).toBe(lastOutputPath);

    const onClipboard = clipboardMock.writeText.mock.calls
      .concat(clipboardMock.writeBuffer.mock.calls)
      .flat()
      .map((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : String(value)))
      .join("\n");
    expect(onClipboard).toContain(result.filePath as string);
    expect(await nodeFs.readFile(result.filePath as string, "utf8")).toBe(
      "<files>clipboard me</files>"
    );
  });
});

describe("mergeCopyTreeOptions", () => {
  it("combines project excluded paths when runtime exclude is not provided", () => {
    const result = mergeCopyTreeOptions(
      {
        excludedPaths: ["node_modules", ".cache"],
        copyTreeSettings: {
          alwaysExclude: ["dist"],
        } as never,
      },
      { maxFileSize: 1024 }
    );

    expect(result.exclude).toEqual(["node_modules", ".cache", "dist"]);
    expect(result.maxFileSize).toBe(1024);
  });

  it("does not override runtime exclude with project defaults", () => {
    const result = mergeCopyTreeOptions(
      {
        excludedPaths: ["node_modules"],
        copyTreeSettings: {
          alwaysExclude: ["dist"],
        } as never,
      },
      { exclude: ["runtime-only"] }
    );

    expect(result.exclude).toEqual(["runtime-only"]);
  });

  it("applies project defaults only when runtime values are unset", () => {
    const result = mergeCopyTreeOptions(
      {
        excludedPaths: ["node_modules"],
        copyTreeSettings: {
          maxContextSize: 1000,
          maxFileSize: 2000,
          charLimit: 3000,
          strategy: "modified",
          alwaysInclude: ["README.md"],
        } as never,
      },
      {
        maxTotalSize: 9999,
        sort: "name",
      }
    );

    expect(result.maxTotalSize).toBe(9999);
    expect(result.maxFileSize).toBe(2000);
    expect(result.charLimit).toBe(3000);
    expect(result.sort).toBe("name");
    expect(result.always).toEqual(["README.md"]);
  });

  it("does not back-fill project settings over explicitly cleared (null) fields", () => {
    const projectSettings = {
      excludedPaths: ["node_modules"],
      copyTreeSettings: {
        maxContextSize: 1000,
        maxFileSize: 2000,
        charLimit: 3000,
        strategy: "modified",
        alwaysInclude: ["README.md"],
        alwaysExclude: ["dist"],
      } as never,
    };

    const backfilled = mergeCopyTreeOptions(projectSettings, {});
    const cleared = mergeCopyTreeOptions(projectSettings, {
      exclude: null,
      always: null,
      maxFileSize: null,
      maxTotalSize: null,
      charLimit: null,
      sort: null,
    });

    // The same settings that back-fill absent fields must not survive cleared ones.
    expect(backfilled.maxTotalSize).toBeDefined();
    expect(backfilled.maxFileSize).toBeDefined();
    expect(backfilled.charLimit).toBeDefined();
    expect(backfilled.sort).toBeDefined();
    expect(backfilled.always).toBeDefined();
    expect(backfilled.exclude).toBeDefined();

    expect(cleared).toEqual({});
  });

  it("treats cleared, absent, and set fields independently in one merge", () => {
    const copyTreeSettings = {
      maxContextSize: 1000,
      maxFileSize: 2000,
      charLimit: 3000,
    };
    const result = mergeCopyTreeOptions(
      { excludedPaths: [], copyTreeSettings: copyTreeSettings as never },
      { maxTotalSize: null, charLimit: 50 }
    );

    expect(result.maxTotalSize).toBeUndefined(); // cleared → no back-fill
    expect(result.maxFileSize).toBe(copyTreeSettings.maxFileSize); // absent → back-filled
    expect(result.charLimit).toBe(50); // runtime wins
  });

  it("strips null sentinels so the result only carries values or absent keys", () => {
    const result = mergeCopyTreeOptions(undefined, {
      format: "xml",
      maxTotalSize: null,
      exclude: null,
    });

    expect(result.format).toBe("xml");
    expect("maxTotalSize" in result).toBe(false);
    expect("exclude" in result).toBe(false);
  });
});

describe("buildRemoteComputeBlock", () => {
  it("returns empty string when worktree has no resourceStatus", () => {
    const worktree = { resourceStatus: undefined };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toBe("");
  });

  it("includes full Remote Compute block with endpoint and connect command when status is ready", () => {
    const worktree = {
      resourceStatus: {
        provider: "aws",
        lastStatus: "ready",
        endpoint: "ec2-1-2-3-4.compute.amazonaws.com",
      },
      resourceConnectCommand: "ssh -i key.pem root@ec2-1-2-3-4.compute.amazonaws.com",
    };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toContain("## Remote Compute");
    expect(block).toContain("Provider: aws");
    expect(block).toContain("Status: ready");
    expect(block).toContain("Endpoint: ec2-1-2-3-4.compute.amazonaws.com");
    expect(block).toContain(
      "Run remote commands: ssh -i key.pem root@ec2-1-2-3-4.compute.amazonaws.com"
    );
    expect(block).toContain('daintree-remote "<command>"');
  });

  it("includes informational Remote Compute block without connect command when status is provisioning", () => {
    const worktree = {
      resourceStatus: {
        provider: "gcp",
        lastStatus: "provisioning",
      },
      resourceConnectCommand: undefined,
    };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toContain("## Remote Compute");
    expect(block).toContain("Provider: gcp");
    expect(block).toContain("Status: provisioning");
    expect(block).toContain("Resource is not yet available for remote execution");
    expect(block).not.toContain("Run remote commands:");
    expect(block).not.toContain("daintree-remote");
  });

  it("shows error status without connect command when status is error", () => {
    const worktree = {
      resourceStatus: {
        provider: "azure",
        lastStatus: "error",
      },
      resourceConnectCommand: undefined,
    };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toContain("## Remote Compute");
    expect(block).toContain("Provider: azure");
    expect(block).toContain("Status: error");
    expect(block).toContain("Resource is not yet available for remote execution");
  });

  it("uses unknown provider when provider is undefined", () => {
    const worktree = {
      resourceStatus: {
        lastStatus: "provisioning",
      },
      resourceConnectCommand: undefined,
    };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toContain("Provider: unknown");
  });
});

describe("escapeXml", () => {
  it("escapes ampersands first to avoid double-encoding", () => {
    expect(escapeXml("a & b")).toBe("a &amp; b");
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  it("escapes the five XML special characters", () => {
    expect(escapeXml(`<a href="x">'y'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&apos;y&apos;&lt;/a&gt;"
    );
  });

  it("returns the input unchanged when nothing needs escaping", () => {
    expect(escapeXml("/Users/me/projects/foo/bar.txt")).toBe("/Users/me/projects/foo/bar.txt");
  });

  it("makes adversarial TMPDIR-style paths safe to embed in a plist string", () => {
    const malicious = `/tmp/evil&</string><array><string>/etc/passwd</string></array>`;
    const escaped = escapeXml(malicious);
    expect(escaped).not.toContain("</string>");
    expect(escaped).not.toContain("<array>");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&lt;/string&gt;");
  });
});

describe("nextChunkBoundary", () => {
  const CHUNK = 4096;

  it("returns start + chunkSize when content is well past the chunk boundary", () => {
    const content = "a".repeat(CHUNK * 3);
    expect(nextChunkBoundary(content, 0, CHUNK)).toBe(CHUNK);
    expect(nextChunkBoundary(content, CHUNK, CHUNK)).toBe(CHUNK * 2);
  });

  it("returns content.length when the remaining content is shorter than chunkSize", () => {
    const content = "a".repeat(100);
    expect(nextChunkBoundary(content, 0, CHUNK)).toBe(100);
  });

  it("backs off by one code unit when a high surrogate sits at the boundary", () => {
    // Build a string where position CHUNK-1 is the high surrogate of "𝄞" (U+1D11E).
    // Pad with `CHUNK - 1` ASCII chars, then place the supplementary char at the boundary.
    const padding = "a".repeat(CHUNK - 1);
    const surrogatePair = "𝄞"; // U+1D11E MUSICAL SYMBOL G CLEF
    const content = padding + surrogatePair + "tail";
    // Without the backoff: end = CHUNK, slice(0, CHUNK) ends with a lone high surrogate.
    // With the backoff: end = CHUNK - 1, slice(0, CHUNK - 1) ends with the last `a`.
    const end = nextChunkBoundary(content, 0, CHUNK);
    expect(end).toBe(CHUNK - 1);
    const chunk = content.slice(0, end);
    expect(chunk.charCodeAt(chunk.length - 1)).toBe("a".charCodeAt(0));

    // Next iteration starts at the high surrogate and pulls the full pair plus tail.
    const nextEnd = nextChunkBoundary(content, end, CHUNK);
    expect(nextEnd).toBe(content.length);
    const nextChunk = content.slice(end, nextEnd);
    expect(nextChunk).toBe(surrogatePair + "tail");
  });

  it("does not back off when the boundary lands on a low surrogate (pair already complete in previous chunk)", () => {
    // Previous chunk ended with the high surrogate; this one starts with the low surrogate.
    // We only back off when the LAST unit is a high surrogate, never on low surrogates.
    const surrogatePair = "𝄞";
    const content = surrogatePair + "x".repeat(CHUNK);
    // Slice that ends right after the low surrogate (position 2): no backoff.
    expect(nextChunkBoundary(content, 0, 2)).toBe(2);
  });

  it("does not back off at the very end of content", () => {
    const surrogatePair = "𝄞";
    const content = "a" + surrogatePair;
    // End == content.length, no need to back off because the pair is fully inside.
    expect(nextChunkBoundary(content, 0, CHUNK)).toBe(content.length);
  });

  it("never backs off below start, so the loop always advances even with chunkSize 1", () => {
    // Pathological: chunkSize 1 starting on a high surrogate. Backing off
    // would return start, infinite-looping the caller. The guard must keep
    // end > start by including the lone code unit instead.
    const surrogatePair = "𝄞";
    const content = surrogatePair + "tail";
    const end = nextChunkBoundary(content, 0, 1);
    expect(end).toBeGreaterThan(0);

    // Walk the entire string with chunkSize 1 and assert we terminate.
    let i = 0;
    let iterations = 0;
    while (i < content.length) {
      const next = nextChunkBoundary(content, i, 1);
      expect(next).toBeGreaterThan(i);
      i = next;
      iterations++;
      if (iterations > content.length * 2) {
        throw new Error("nextChunkBoundary failed to advance with chunkSize 1");
      }
    }
    expect(i).toBe(content.length);
  });

  it("makes consecutive calls walk a string of all-surrogate-pair characters without splitting any pair", () => {
    // 1000 supplementary-plane characters → 2000 UTF-16 code units.
    const supplementary = "𝄞";
    const content = supplementary.repeat(1000);

    let i = 0;
    let totalChunks = 0;
    while (i < content.length) {
      const end = nextChunkBoundary(content, i, 17); // odd chunk size to force boundary backoffs
      const chunk = content.slice(i, end);
      // Every chunk must contain whole code points only.
      // High surrogates (0xD800-0xDBFF) must be followed by a low surrogate within the chunk.
      for (let j = 0; j < chunk.length; j++) {
        const u = chunk.charCodeAt(j);
        if (u >= 0xd800 && u <= 0xdbff) {
          expect(j + 1).toBeLessThan(chunk.length);
          const next = chunk.charCodeAt(j + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc00);
          expect(next).toBeLessThanOrEqual(0xdfff);
          j++;
        }
      }
      i = end;
      totalChunks++;
      if (totalChunks > content.length) {
        throw new Error("Loop did not advance — possible infinite loop in nextChunkBoundary");
      }
    }
    expect(i).toBe(content.length);
  });
});

describe("copy-tree run history recording", () => {
  const PROJECT_ID = "a1b2c3d4".repeat(8);
  let tmpRoot: string;

  /**
   * Register the handlers against a workspace host that reports a completed
   * run. `overrides` shapes what the host returns so a test can drive the
   * failure paths.
   */
  function makeService(overrides: Record<string, unknown> = {}, hasTerminal = true) {
    const generateContext = vi.fn(
      async (_root: string, _options: unknown, _onProgress: unknown, outputPath?: string) => {
        const body = "<files/>";
        if (outputPath) {
          await nodeFs.writeFile(outputPath, body, { encoding: "utf8", mode: 0o600 });
        }
        return {
          content: body,
          fileCount: 12,
          ...(outputPath
            ? { filePath: outputPath, outputBytes: Buffer.byteLength(body, "utf8") }
            : {}),
          stats: { totalSize: 345, duration: 67 },
          ...overrides,
        };
      }
    );

    browserWindowMock.fromWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });
    ipcMainMock.handle.mockClear();
    registerCopyTreeHandlers({
      mainWindow: {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: vi.fn() },
      },
      ptyClient: { hasTerminal: vi.fn(() => hasTerminal), write: vi.fn() },
      worktreeService: {
        getAllStatesForProjectAsync: vi.fn(async () => [
          { id: "wt-1", path: "/repos/daintree", branch: "main" },
        ]),
        generateContext,
        testConfig: vi.fn(),
        getContextFileTree: vi.fn(),
      },
    } as never);
    return generateContext;
  }

  function lastRecordedRun(): [string | null, CopyTreeHistoryAppendInput] {
    const calls = copyTreeHistoryMock.recordCopyTreeRun.mock.calls;
    const last = calls[calls.length - 1];
    if (!last) throw new Error("recordCopyTreeRun was never called");
    return last;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
    _resetReservedPathsForTests();
    copyTreeHistoryMock.recordCopyTreeRun.mockReset().mockResolvedValue(undefined);
    tmpRoot = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "daintree-history-"));
    vi.stubEnv("TMPDIR", tmpRoot);
    vi.stubEnv("TEMP", tmpRoot);
    vi.stubEnv("TMP", tmpRoot);
    projectStoreMock.getCurrentProjectId.mockReturnValue(PROJECT_ID);
    // The recorded project id comes from the same resolution the worktree
    // lookup uses, so the row has to resolve for the run to reach the history.
    projectStoreMock.getProjectById.mockReturnValue({
      id: PROJECT_ID,
      path: "/repos/daintree",
      status: "active",
    });
    projectStoreMock.getProjectSettings.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await nodeFs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("records a generate run once, against the resolved project", async () => {
    makeService();
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await handler(mockSender, { worktreeId: "wt-1", source: "toolbar" });

    expect(copyTreeHistoryMock.recordCopyTreeRun).toHaveBeenCalledTimes(1);
    const [projectId, input] = lastRecordedRun();
    expect(projectId).toBe(PROJECT_ID);
    expect(input).toMatchObject({
      source: "toolbar",
      worktreeId: "wt-1",
      stats: { fileCount: 12, totalSize: 345, duration: 67 },
    });
  });

  it("records a clipboard run once", async () => {
    makeService();
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE);

    await handler(mockSender, { worktreeId: "wt-1", source: "worktree-card" });

    expect(copyTreeHistoryMock.recordCopyTreeRun).toHaveBeenCalledTimes(1);
    expect(lastRecordedRun()[1]).toMatchObject({ source: "worktree-card" });
  });

  it("records an injection run — same intent, different delivery", async () => {
    makeService();
    const handler = getInvokeHandler(CHANNELS.COPYTREE_INJECT);

    await handler(mockSender, { terminalId: "t-1", worktreeId: "wt-1", source: "mcp" });

    expect(copyTreeHistoryMock.recordCopyTreeRun).toHaveBeenCalledTimes(1);
    expect(lastRecordedRun()[1]).toMatchObject({ source: "mcp", worktreeId: "wt-1" });
  });

  /**
   * The caller-supplied label reaching history (#11734).
   *
   * Every channel is covered rather than one representative: each validates
   * through its own payload schema, and an ordinary zod object *strips* an
   * undeclared key instead of rejecting it. A channel that was missed would
   * therefore keep passing every other assertion in this file while silently
   * dropping the name — the exact failure this table exists to catch.
   */
  describe.each([
    { channel: CHANNELS.COPYTREE_GENERATE, extra: {} as Record<string, unknown> },
    { channel: CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE, extra: {} as Record<string, unknown> },
    { channel: CHANNELS.COPYTREE_INJECT, extra: { terminalId: "t-1" } },
  ])("$channel run name", ({ channel, extra }) => {
    it("forwards a supplied name to the history append", async () => {
      makeService();
      const handler = getInvokeHandler(channel);

      await handler(mockSender, { worktreeId: "wt-1", name: "Authentication stuff", ...extra });

      expect(lastRecordedRun()[1].name).toBe("Authentication stuff");
    });

    it("forwards the raw value, leaving normalization to the history layer", async () => {
      makeService();
      const handler = getInvokeHandler(channel);

      // Untrimmed on purpose: `applyCopyTreeRun` owns blank-as-absent and
      // truncation, so trimming here too would give the same input two
      // normalizations that can drift apart.
      await handler(mockSender, { worktreeId: "wt-1", name: "  spaced  ", ...extra });

      expect(lastRecordedRun()[1].name).toBe("  spaced  ");
    });

    it("records the run with no name when none was supplied", async () => {
      makeService();
      const handler = getInvokeHandler(channel);

      await handler(mockSender, { worktreeId: "wt-1", ...extra });

      expect(copyTreeHistoryMock.recordCopyTreeRun).toHaveBeenCalledTimes(1);
      expect(lastRecordedRun()[1].name).toBeUndefined();
    });
  });

  it("stores the caller's runtime options, not the settings-merged ones", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      excludedPaths: ["vendor"],
      copyTreeSettings: { maxContextSize: 4242, alwaysInclude: ["*.md"] },
    });
    projectStoreMock.getProjectById.mockReturnValue({
      id: PROJECT_ID,
      path: "/repos/daintree",
      status: "open",
    });
    windowRefMock.getProjectViewManager.mockReturnValue({
      getProjectIdForWebContents: () => PROJECT_ID,
    });
    const generateContext = makeService();
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await handler(mockSender, {
      worktreeId: "wt-1",
      options: { modified: true },
      source: "toolbar",
    });

    // The host really did receive the merged options...
    const mergedOptions = generateContext.mock.calls[0][1] as Record<string, unknown>;
    expect(mergedOptions.maxTotalSize).toBe(4242);
    // ...while the record keeps only what the caller asked for, so a re-run
    // picks up whatever the project settings say at that later time.
    expect(lastRecordedRun()[1].options).toEqual({ modified: true });
  });

  it("records an absent source as unknown rather than guessing a surface", async () => {
    makeService();
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await handler(mockSender, { worktreeId: "wt-1" });

    expect(lastRecordedRun()[1]).toMatchObject({ source: "unknown", options: {} });
  });

  it("records the file count even when the host reported no stats", async () => {
    makeService({ stats: undefined });
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await handler(mockSender, { worktreeId: "wt-1" });

    expect(lastRecordedRun()[1].stats).toEqual({
      fileCount: 12,
      totalSize: undefined,
      duration: undefined,
    });
  });

  it("does not record a failed generation", async () => {
    makeService({ error: "Failed to generate context" });
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await handler(mockSender, { worktreeId: "wt-1" });

    expect(copyTreeHistoryMock.recordCopyTreeRun).not.toHaveBeenCalled();
  });

  it("does not record a run whose worktree could not be found", async () => {
    makeService();
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await handler(mockSender, { worktreeId: "wt-missing" });

    expect(copyTreeHistoryMock.recordCopyTreeRun).not.toHaveBeenCalled();
  });

  it("does not record an injection into a terminal that no longer exists", async () => {
    makeService({}, false);
    const handler = getInvokeHandler(CHANNELS.COPYTREE_INJECT);

    await handler(mockSender, { terminalId: "t-gone", worktreeId: "wt-1" });

    expect(copyTreeHistoryMock.recordCopyTreeRun).not.toHaveBeenCalled();
  });

  it("does not record a rejected payload", async () => {
    makeService();
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await handler(mockSender, { worktreeId: "wt-1", source: "not-a-surface" });

    expect(copyTreeHistoryMock.recordCopyTreeRun).not.toHaveBeenCalled();
  });

  it("still returns the copy result when recording rejects", async () => {
    // recordCopyTreeRun swallows its own failures, but the handler must not
    // depend on that: a rejection here must not turn a delivered copy into an
    // error the user sees.
    copyTreeHistoryMock.recordCopyTreeRun.mockRejectedValue(new Error("disk on fire"));
    makeService();
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    const result = (await handler(mockSender, { worktreeId: "wt-1" })) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(result.fileCount).toBe(12);
  });
});
