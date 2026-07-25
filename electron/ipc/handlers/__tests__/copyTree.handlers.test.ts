import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
  getProjectById: vi.fn<(projectId: string) => { id: string; status: string } | null>(() => null),
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

vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: windowRefMock.getProjectViewManager,
  setProjectViewManager: vi.fn(),
  getWindowRegistry: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setMainWindow: vi.fn(),
}));

import { CHANNELS } from "../../channels.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
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
          testConfig,
        },
      } as never);
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1" as never);
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
          getContextFileTree,
          getFileTree,
        },
      } as never);
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1" as never);
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

      if (options.withSenderWindow !== false) {
        browserWindowMock.fromWebContents.mockReturnValue({
          id: SENDER_WINDOW_ID,
          isDestroyed: () => false,
        });
      }

      projectStoreMock.getProjectById.mockImplementation((projectId) => ({
        id: projectId,
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
          getAllStatesAsync: vi.fn(async () => {
            options.onWorkspaceCall?.();
            return [{ id: "wt-1", path: "/wt-1" }];
          }),
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

      return { testConfig, generateContext, getContextFileTree };
    }

    /**
     * Every handler that merges project settings, with the seam it hands the
     * merged options to and the argument position they land in. All cases run
     * against all of them so a regression in one call site can't hide behind the
     * others — picking the wrong project's settings is this code's recurring bug
     * (#11103, #6015), and for the file tree it would put the picker and the
     * bundle back on different settings (#11439).
     */
    const MERGE_CALL_SITES = [
      {
        channel: CHANNELS.COPYTREE_TEST_CONFIG,
        seam: "testConfig" as const,
        payload: {},
        optionsArgIndex: 1,
      },
      {
        channel: CHANNELS.COPYTREE_GENERATE,
        seam: "generateContext" as const,
        payload: {},
        optionsArgIndex: 1,
      },
      {
        channel: CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE,
        seam: "generateContext" as const,
        payload: {},
        optionsArgIndex: 1,
      },
      {
        channel: CHANNELS.COPYTREE_INJECT,
        seam: "generateContext" as const,
        payload: { terminalId: "term-1" },
        optionsArgIndex: 1,
      },
      {
        channel: CHANNELS.COPYTREE_GET_FILE_TREE,
        seam: "getContextFileTree" as const,
        payload: {},
        optionsArgIndex: 2,
      },
    ];

    async function invoke(channel: string, extraPayload: Record<string, unknown>) {
      const handler = getInvokeHandler(channel);
      await handler(mockEvent, { worktreeId: "wt-1", options: {}, ...extraPayload });
    }

    describe.each(MERGE_CALL_SITES)("$channel", ({ channel, seam, payload, optionsArgIndex }) => {
      it("merges the sender window's project settings, not the globally current project's", async () => {
        aimGlobalSourcesAtGlobalProject();
        const seams = registerWithScope({
          windowScopedPvm: makePvm(SENDER_PROJECT),
          depsPvm: makePvm(GLOBAL_PROJECT),
        });

        await invoke(channel, payload);

        const mergedOptions = seams[seam].mock.calls[0][optionsArgIndex];
        expect(mergedOptions.maxTotalSize).toBe(senderSettings.copyTreeSettings.maxContextSize);
        expect(mergedOptions.maxTotalSize).not.toBe(globalSettings.copyTreeSettings.maxContextSize);
        expect(mergedOptions.always).toEqual(senderSettings.copyTreeSettings.alwaysInclude);
        expect(mergedOptions.exclude).toEqual(senderSettings.excludedPaths);
        expect(mergedOptions.exclude).not.toContain(globalSettings.excludedPaths[0]);
        expect(projectStoreMock.getProjectSettings).toHaveBeenCalledWith(SENDER_PROJECT);
        expect(projectStoreMock.getCurrentProjectId).not.toHaveBeenCalled();
      });

      it("applies no project settings when the sender's view is unbound", async () => {
        aimGlobalSourcesAtGlobalProject();
        const depsPvm = makePvm(GLOBAL_PROJECT);
        const seams = registerWithScope({ windowScopedPvm: makePvm(null), depsPvm });

        await invoke(channel, payload);

        // An unbound view must not inherit the global current project's settings
        // from ANY source, so nothing back-fills the empty runtime options.
        expect(seams[seam]).toHaveBeenCalledTimes(1);
        const mergedOptions = seams[seam].mock.calls[0][optionsArgIndex];
        expect(mergedOptions).toEqual({});
        expect(depsPvm.getProjectIdForWebContents).not.toHaveBeenCalled();
        expect(projectStoreMock.getProjectSettings).not.toHaveBeenCalled();
        expect(projectStoreMock.getCurrentProjectId).not.toHaveBeenCalled();
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

      it("carries scoped folder paths through validation to the service", async () => {
        aimGlobalSourcesAtGlobalProject();
        const seams = registerWithScope({
          windowScopedPvm: makePvm(SENDER_PROJECT),
          depsPvm: makePvm(GLOBAL_PROJECT),
        });

        await invoke(channel, { ...payload, options: { scopePaths: ["src/panels"] } });

        const [, mergedOptions] = seams[seam].mock.calls[0];
        // A field missing from the schema is dropped silently by Zod, so the
        // folder copy would degrade to a whole-worktree copy with no error.
        expect(mergedOptions.scopePaths).toEqual(["src/panels"]);
      });

      it("falls back to the current project when no project-scoped view manager exists", async () => {
        projectStoreMock.getCurrentProjectId.mockReturnValue(GLOBAL_PROJECT);
        const seams = registerWithScope({ withSenderWindow: false });

        await invoke(channel, payload);

        const mergedOptions = seams[seam].mock.calls[0][optionsArgIndex];
        expect(mergedOptions.maxTotalSize).toBe(globalSettings.copyTreeSettings.maxContextSize);
        expect(mergedOptions.always).toEqual(globalSettings.copyTreeSettings.alwaysInclude);
        expect(projectStoreMock.getProjectSettings).toHaveBeenCalledWith(GLOBAL_PROJECT);
      });
    });
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
