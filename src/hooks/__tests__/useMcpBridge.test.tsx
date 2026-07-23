// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";
import { __resetMcpConfirmStoreForTesting, useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { isMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";

const mocks = vi.hoisted(() => ({
  list: vi.fn(() => [] as ActionManifestEntry[]),
  get: vi.fn((_id: string): ActionManifestEntry | null => null),
  dispatch: vi.fn(),
  buildPreview: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: mocks.list,
    getDispatchMeta: mocks.get,
    dispatch: mocks.dispatch,
  },
}));

// Mock only the fresh-fetch builder; keep the real formatter so the preview
// lines the bridge emits are exercised. Default (set per-test in beforeEach)
// resolves null → no preview, so the confirm-flow tests stay unaffected.
vi.mock("@/components/Worktree/worktreeDeletePreview", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/Worktree/worktreeDeletePreview")>();
  return { ...actual, buildWorktreeDeletePreview: mocks.buildPreview };
});

import { useMcpBridge, buildMcpConfirmPreview } from "../useMcpBridge";

function safeManifestEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
  return {
    id: "actions.list",
    name: "actions.list",
    title: "List Actions",
    description: "Read actions",
    category: "test",
    kind: "query",
    danger: "safe",
    enabled: true,
    requiresArgs: false,
    ...overrides,
  };
}

function confirmManifestEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
  return {
    id: "worktree.delete",
    name: "worktree.delete",
    title: "Delete Worktree",
    description: "Permanently delete a worktree from disk.",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    enabled: true,
    requiresArgs: true,
    ...overrides,
  };
}

describe("useMcpBridge", () => {
  let manifestHandler: ((requestId: string) => void) | undefined;
  let dispatchHandler:
    | ((payload: {
        requestId: string;
        actionId: string;
        args?: unknown;
        confirmed?: boolean;
        context?: Record<string, unknown>;
        callerInfo?: { token4LastChars: string; userAgent: string };
      }) => void | Promise<void>)
    | undefined;
  let cleanupManifest: ReturnType<typeof vi.fn>;
  let cleanupDispatch: ReturnType<typeof vi.fn>;
  let sendGetManifestResponse: ReturnType<typeof vi.fn>;
  let sendDispatchActionResponse: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no fresh preview → the off-critical-path fetch is a no-op, so
    // the confirmation-flow tests are unaffected by the #11343 preview change.
    mocks.buildPreview.mockResolvedValue(null);
    __resetMcpConfirmStoreForTesting();
    manifestHandler = undefined;
    dispatchHandler = undefined;
    cleanupManifest = vi.fn();
    cleanupDispatch = vi.fn();
    sendGetManifestResponse = vi.fn();
    sendDispatchActionResponse = vi.fn();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        mcpBridge: {
          onGetManifestRequest: (callback: (requestId: string) => void) => {
            manifestHandler = callback;
            return cleanupManifest;
          },
          sendGetManifestResponse,
          onDispatchActionRequest: (
            callback: (payload: {
              requestId: string;
              actionId: string;
              args?: unknown;
              confirmed?: boolean;
              context?: Record<string, unknown>;
              callerInfo?: { token4LastChars: string; userAgent: string };
            }) => void | Promise<void>
          ) => {
            dispatchHandler = callback;
            return cleanupDispatch;
          },
          sendDispatchActionResponse,
        },
      },
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    __resetMcpConfirmStoreForTesting();
  });

  it("returns the current action manifest and falls back to an empty manifest on failure", () => {
    mocks.list.mockReturnValueOnce([safeManifestEntry()]);

    renderHook(() => useMcpBridge());

    manifestHandler?.("req-1");
    expect(sendGetManifestResponse).toHaveBeenCalledWith("req-1", [
      expect.objectContaining({ id: "actions.list" }),
    ]);

    mocks.list.mockImplementationOnce(() => {
      throw new Error("manifest exploded");
    });

    manifestHandler?.("req-2");
    expect(sendGetManifestResponse).toHaveBeenCalledWith("req-2", []);
  });

  it("dispatches safe actions immediately without surfacing a confirmation modal", async () => {
    mocks.get.mockReturnValue(safeManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-safe",
      actionId: "actions.list",
      args: { limit: 10 },
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "actions.list",
      { limit: 10 },
      { source: "agent", confirmed: undefined }
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-safe",
      result: { ok: true, result: { ok: true } },
      confirmationDecision: undefined,
    });
  });

  it("forwards the bound provision-time context as contextOverride (#8317)", async () => {
    mocks.get.mockReturnValue(safeManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const boundContext = { focusedWorktreeId: "wt-7", focusedTerminalId: "term-2" };
    await dispatchHandler?.({
      requestId: "req-ctx",
      actionId: "terminal.inject",
      args: { text: "ls" },
      context: boundContext,
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "terminal.inject",
      { text: "ls" },
      { source: "agent", confirmed: undefined, contextOverride: boundContext }
    );
  });

  it("passes contextOverride: undefined for unpinned dispatch — live context preserved (#8317)", async () => {
    mocks.get.mockReturnValue(safeManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-no-ctx",
      actionId: "actions.list",
      args: { limit: 3 },
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "actions.list",
      { limit: 3 },
      { source: "agent", confirmed: undefined, contextOverride: undefined }
    );
  });

  it("suppresses create-time panel focus while an MCP action dispatch is in flight", async () => {
    mocks.get.mockReturnValue(safeManifestEntry());
    mocks.dispatch.mockImplementation(async () => {
      expect(isMcpSpawnFocusSuppressed()).toBe(true);
      return { ok: true, result: { ok: true } };
    });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-focus-scope",
      actionId: "actions.list",
      args: { limit: 5 },
    });

    expect(isMcpSpawnFocusSuppressed()).toBe(false);
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-focus-scope",
      result: { ok: true, result: { ok: true } },
      confirmationDecision: undefined,
    });
  });

  it("queues a confirm-class dispatch and only forwards it after user approval", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-confirm",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });

    await Promise.resolve();
    const pending = useMcpConfirmStore.getState().current;
    expect(pending).not.toBeNull();
    expect(pending?.actionTitle).toBe("Delete Worktree");
    expect(pending?.danger).toBe("confirm");
    expect(pending?.argsSummary).toContain("wt-1");
    // This manifest entry carries no dangerRationale, so the conditional spread
    // must omit the property entirely (not set it to undefined).
    expect(pending).not.toHaveProperty("dangerRationale");
    expect(mocks.dispatch).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "worktree.delete",
      { worktreeId: "wt-1" },
      { source: "agent", confirmed: true }
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-confirm",
      result: { ok: true, result: { ok: true } },
      confirmationDecision: "approved",
    });
  });

  it("threads the action's dangerRationale into the confirm store so the dialog can show it (#11342)", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({
        dangerRationale: "Permanently removes the worktree directory and uncommitted changes.",
      })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-rationale",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });

    await Promise.resolve();
    expect(useMcpConfirmStore.getState().current?.dangerRationale).toBe(
      "Permanently removes the worktree directory and uncommitted changes."
    );

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
  });

  it("forwards the requesting-bearer identity into the confirm store (#9157)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const callerInfo = { token4LastChars: "1234", userAgent: "Claude Code" };
    const dispatched = dispatchHandler?.({
      requestId: "req-caller",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
      callerInfo,
    });

    await Promise.resolve();
    expect(useMcpConfirmStore.getState().current?.callerInfo).toEqual(callerInfo);

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
  });

  it("leaves callerInfo undefined in the store for pinned help-session dispatch (#9157)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-no-caller",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });

    await Promise.resolve();
    expect(useMcpConfirmStore.getState().current?.callerInfo).toBeUndefined();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
  });

  it("preserves the bound context across the confirmation wait (#8317)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const boundContext = { focusedWorktreeId: "wt-confirm" };
    const dispatched = dispatchHandler?.({
      requestId: "req-confirm-ctx",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
      context: boundContext,
    });

    await Promise.resolve();
    expect(mocks.dispatch).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    // contextOverride must be the value captured in the handler closure,
    // not re-read from live state after the modal await resolved.
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "worktree.delete",
      { worktreeId: "wt-1" },
      { source: "agent", confirmed: true, contextOverride: boundContext }
    );
  });

  it("returns USER_REJECTED without ever calling actionService.dispatch when the user cancels", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-reject",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-2" },
    });

    await Promise.resolve();
    useMcpConfirmStore.getState().resolveCurrent("rejected");
    await dispatched;

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-reject",
      result: {
        ok: false,
        error: {
          code: "USER_REJECTED",
          message: expect.stringContaining("rejected"),
        },
      },
      confirmationDecision: "rejected",
    });
  });

  it("returns CONFIRMATION_TIMEOUT when the modal ages out without a decision", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-timeout",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-3" },
    });

    await Promise.resolve();
    useMcpConfirmStore.getState().resolveCurrent("timeout");
    await dispatched;

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-timeout",
      result: {
        ok: false,
        error: {
          code: "CONFIRMATION_TIMEOUT",
          message: expect.stringContaining("timed out"),
        },
      },
      confirmationDecision: "timeout",
    });
  });

  it("skips the modal when the dispatch arrives pre-authorized by a host grant (confirmed=true)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-pre-confirmed",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-4" },
      confirmed: true,
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "worktree.delete",
      { worktreeId: "wt-4" },
      { source: "agent", confirmed: true }
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-pre-confirmed",
      result: { ok: true, result: { ok: true } },
      confirmationDecision: undefined,
    });
  });

  it("wraps bridge dispatch failures as execution errors", async () => {
    mocks.get.mockReturnValue(safeManifestEntry());
    mocks.dispatch.mockRejectedValueOnce(new Error("dispatch exploded"));

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-err",
      actionId: "actions.list",
      args: { search: "test" },
    });

    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-err",
      result: {
        ok: false,
        error: {
          code: "EXECUTION_ERROR",
          message: "dispatch exploded",
        },
      },
      confirmationDecision: undefined,
    });
  });

  it("cleans up bridge listeners on unmount", () => {
    const { unmount } = renderHook(() => useMcpBridge());

    unmount();

    expect(cleanupManifest).toHaveBeenCalledTimes(1);
    expect(cleanupDispatch).toHaveBeenCalledTimes(1);
  });

  describe("MCP spawn source tagging (#6959)", () => {
    it("stamps spawnedBy: 'mcp' onto agent.launch dispatches and preserves caller args", async () => {
      mocks.get.mockReturnValue(safeManifestEntry({ id: "agent.launch", danger: "safe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-1" } });

      renderHook(() => useMcpBridge());

      await dispatchHandler?.({
        requestId: "req-launch",
        actionId: "agent.launch",
        args: { agentId: "claude", location: "grid" },
      });

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", location: "grid", spawnedBy: "mcp", focusPolicy: "preserve" },
        { source: "agent", confirmed: undefined }
      );
    });

    it("stamps panel-spawning workflow actions so indirect agent launches do not steal focus", async () => {
      mocks.get.mockReturnValue(
        safeManifestEntry({ id: "workflow.startWorkOnIssue", danger: "safe" })
      );
      mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-workflow" } });

      renderHook(() => useMcpBridge());

      await dispatchHandler?.({
        requestId: "req-workflow",
        actionId: "workflow.startWorkOnIssue",
        args: { issueNumber: 6959, agentId: "claude" },
      });

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "workflow.startWorkOnIssue",
        { issueNumber: 6959, agentId: "claude", spawnedBy: "mcp", focusPolicy: "preserve" },
        { source: "agent", confirmed: undefined }
      );
    });

    it("stamps recipe and terminal creation actions that can create panels from MCP", async () => {
      mocks.get.mockReturnValue(safeManifestEntry({ danger: "safe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-spawn" } });

      renderHook(() => useMcpBridge());

      await dispatchHandler?.({
        requestId: "req-recipe",
        actionId: "recipe.run",
        args: { recipeId: "recipe-1" },
      });
      await dispatchHandler?.({
        requestId: "req-terminal-new",
        actionId: "terminal.new",
      });

      expect(mocks.dispatch).toHaveBeenNthCalledWith(
        1,
        "recipe.run",
        { recipeId: "recipe-1", spawnedBy: "mcp", focusPolicy: "preserve" },
        { source: "agent", confirmed: undefined }
      );
      expect(mocks.dispatch).toHaveBeenNthCalledWith(
        2,
        "terminal.new",
        { spawnedBy: "mcp", focusPolicy: "preserve" },
        { source: "agent", confirmed: undefined }
      );
    });

    it("overrides any caller-supplied spawnedBy on agent.* dispatches", async () => {
      mocks.get.mockReturnValue(safeManifestEntry({ id: "agent.claude", danger: "safe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-2" } });

      renderHook(() => useMcpBridge());

      // An MCP client might try to claim a different origin — ignore it.
      await dispatchHandler?.({
        requestId: "req-claude",
        actionId: "agent.claude",
        args: { spawnedBy: "quickrun" },
      });

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "agent.claude",
        { spawnedBy: "mcp", focusPolicy: "preserve" },
        { source: "agent", confirmed: undefined }
      );
    });

    it("synthesizes args object when none provided for agent.* dispatches", async () => {
      mocks.get.mockReturnValue(safeManifestEntry({ id: "agent.terminal", danger: "safe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-3" } });

      renderHook(() => useMcpBridge());

      await dispatchHandler?.({
        requestId: "req-terminal",
        actionId: "agent.terminal",
      });

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "agent.terminal",
        { spawnedBy: "mcp", focusPolicy: "preserve" },
        { source: "agent", confirmed: undefined }
      );
    });

    it("does not tag non-agent actions", async () => {
      mocks.get.mockReturnValue(safeManifestEntry({ id: "actions.list", danger: "safe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

      renderHook(() => useMcpBridge());

      await dispatchHandler?.({
        requestId: "req-list",
        actionId: "actions.list",
        args: { limit: 5 },
      });

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "actions.list",
        { limit: 5 },
        { source: "agent", confirmed: undefined }
      );
    });
  });

  it("drops in-flight confirmations from the store on unmount and never sends a late response", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());

    const { unmount } = renderHook(() => useMcpBridge());

    void dispatchHandler?.({
      requestId: "req-late",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-late" },
    });

    await Promise.resolve();
    expect(useMcpConfirmStore.getState().current?.requestId).toBe("req-late");

    unmount();
    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(useMcpConfirmStore.getState().queue).toHaveLength(0);

    // resolveCurrent is now a no-op (nothing visible) and the resolver was
    // dropped, so no response is ever sent — main's 30s dispatch timer
    // handles the orphaned pending entry.
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendDispatchActionResponse).not.toHaveBeenCalled();
  });

  it("surfaces the fresh changed-file preview into the confirm store for worktree.delete (#11343)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 1,
      untrackedFileCount: 0,
      hasTrackedChanges: true,
      hasUntrackedFiles: false,
      changes: [{ path: "src/app.ts", status: "modified", insertions: null, deletions: null }],
    });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-preview",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });

    // Modal is enqueued immediately — the preview fetch runs off the critical
    // path, so `current` is set before the preview lands.
    await Promise.resolve();
    expect(useMcpConfirmStore.getState().current?.requestId).toBe("req-preview");

    // The fresh preview patches the pending item in place once it resolves.
    await vi.waitFor(() => {
      expect(mocks.buildPreview).toHaveBeenCalledWith("wt-1");
      const preview = useMcpConfirmStore.getState().current?.preview;
      expect(preview?.[0]).toContain("1 uncommitted tracked file");
      expect(preview).toContain("  M src/app.ts");
    });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
  });
});

describe("buildMcpConfirmPreview (#11343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPreview.mockResolvedValue(null);
  });

  it("returns undefined for actions that are not worktree.delete", async () => {
    await expect(
      buildMcpConfirmPreview("terminal.kill", { terminalId: "t-1" })
    ).resolves.toBeUndefined();
    expect(mocks.buildPreview).not.toHaveBeenCalled();
  });

  it("returns undefined when worktree.delete args carry no worktreeId", async () => {
    await expect(
      buildMcpConfirmPreview("worktree.delete", { force: true })
    ).resolves.toBeUndefined();
    expect(mocks.buildPreview).not.toHaveBeenCalled();
  });

  it("returns undefined when the monitor is gone (builder resolves null)", async () => {
    mocks.buildPreview.mockResolvedValue(null);
    await expect(
      buildMcpConfirmPreview("worktree.delete", { worktreeId: "wt-1" })
    ).resolves.toBeUndefined();
    expect(mocks.buildPreview).toHaveBeenCalledWith("wt-1");
  });

  it("surfaces the fresh changed-file list for worktree.delete", async () => {
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 1,
      untrackedFileCount: 0,
      hasTrackedChanges: true,
      hasUntrackedFiles: false,
      changes: [{ path: "src/app.ts", status: "modified", insertions: null, deletions: null }],
    });
    const lines = await buildMcpConfirmPreview("worktree.delete", {
      worktreeId: "wt-1",
      force: true,
    });
    expect(lines?.[0]).toContain("1 uncommitted tracked file");
    expect(lines).toContain("  M src/app.ts");
  });

  it("fails closed with a couldn't-verify note when the fresh fetch throws", async () => {
    mocks.buildPreview.mockRejectedValue(new Error("timeout"));
    const lines = await buildMcpConfirmPreview("worktree.delete", { worktreeId: "wt-1" });
    expect(lines).toEqual(["⚠ Could not verify current changes — proceed with caution."]);
  });
});
