// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";
import { __resetMcpConfirmStoreForTesting, useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { isMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import {
  resetStoreAccessorsForTesting,
  setWorktreePathIndexAccessor,
} from "@/store/storeAccessors";

const mocks = vi.hoisted(() => ({
  list: vi.fn(() => [] as ActionManifestEntry[]),
  get: vi.fn((_id: string): ActionManifestEntry | null => null),
  dispatch: vi.fn(),
  getContext: vi.fn((): Record<string, unknown> => ({})),
  buildPreview: vi.fn(),
  buildGitPreview: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: mocks.list,
    getDispatchMeta: mocks.get,
    dispatch: mocks.dispatch,
    getContext: mocks.getContext,
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

// Same split for the git preview: mock only the fresh fetch, keep the real
// formatter so the emitted lines are genuinely exercised (#11538).
vi.mock("@/components/Git/gitRemoteOperationPreview", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/Git/gitRemoteOperationPreview")>();
  return { ...actual, buildGitRemoteOperationPreview: mocks.buildGitPreview };
});

import {
  useMcpBridge,
  buildMcpConfirmPreview,
  resolveMcpConfirmPreviewTarget,
  tagMcpSpawnSource,
} from "../useMcpBridge";
import { TerminalSpawnSourceSchema } from "@/services/actions/definitions/schemas";

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
        sessionOrigin?: "help" | "assistant-pane" | "external";
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
    mocks.getContext.mockReturnValue({});
    mocks.buildGitPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
    });
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

  describe("assistant vs external spawn provenance (#11808)", () => {
    it.each([
      ["help", "assistant"],
      ["assistant-pane", "assistant"],
      ["external", "mcp"],
    ] as const)(
      "resolves a %s-origin dispatch to spawnedBy: '%s'",
      async (sessionOrigin, expectedSource) => {
        mocks.get.mockReturnValue(safeManifestEntry({ id: "agent.launch", danger: "safe" }));
        mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-origin" } });

        renderHook(() => useMcpBridge());

        await dispatchHandler?.({
          requestId: `req-${sessionOrigin}`,
          actionId: "agent.launch",
          args: { agentId: "claude" },
          sessionOrigin,
        });

        expect(mocks.dispatch).toHaveBeenCalledWith(
          "agent.launch",
          { agentId: "claude", spawnedBy: expectedSource, focusPolicy: "preserve" },
          { source: "agent", confirmed: undefined }
        );
      }
    );

    it("falls back to 'mcp' when the dispatch carries no origin at all", async () => {
      mocks.get.mockReturnValue(safeManifestEntry({ id: "agent.launch", danger: "safe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-no-origin" } });

      renderHook(() => useMcpBridge());

      // Nothing type-checks the `webContents.send` side of this channel, so an
      // origin-less payload has to resolve somewhere. It resolves away from
      // assistant provenance: under-claiming is recoverable, mislabelling an
      // external client's spawn as the user's own assistant is not.
      await dispatchHandler?.({
        requestId: "req-origin-absent",
        actionId: "agent.launch",
        args: { agentId: "claude" },
      });

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", spawnedBy: "mcp", focusPolicy: "preserve" },
        { source: "agent", confirmed: undefined }
      );
    });

    it("keeps the assistant's provenance across the confirm-gated await", async () => {
      mocks.get.mockReturnValue(confirmManifestEntry({ id: "recipe.run", title: "Run Recipe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-confirm" } });

      renderHook(() => useMcpBridge());

      // A confirm-gated spawn parks on the approval modal for as long as the
      // user takes. Origin is read once, up front, so nothing about that wait
      // can relabel who asked — the risk being a later refactor that re-reads
      // provenance after the await, when the session may be gone.
      const dispatched = dispatchHandler?.({
        requestId: "req-confirm-origin",
        actionId: "recipe.run",
        args: { recipeId: "recipe-1" },
        sessionOrigin: "assistant-pane",
      });

      await Promise.resolve();
      expect(mocks.dispatch).not.toHaveBeenCalled();

      useMcpConfirmStore.getState().resolveCurrent("approved");
      await dispatched;

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "recipe.run",
        { recipeId: "recipe-1", spawnedBy: "assistant", focusPolicy: "preserve" },
        { source: "agent", confirmed: true }
      );
    });

    it("stamps a spawnedBy the real action schema accepts", () => {
      // The bridge writes this field; action argsSchemas validate it. Nothing
      // in the tests above would notice them drifting apart, because they mock
      // `actionService.dispatch` — and the production symptom of a drift is
      // every assistant-launched spawn failing validation before it launches.
      const readSpawnedBy = (args: unknown): unknown =>
        typeof args === "object" && args !== null ? Reflect.get(args, "spawnedBy") : undefined;

      for (const origin of ["help", "assistant-pane", "external"] as const) {
        const spawnedBy = readSpawnedBy(tagMcpSpawnSource("agent.launch", {}, origin));
        expect(TerminalSpawnSourceSchema.safeParse(spawnedBy).success).toBe(true);
      }
    });

    it("leaves non-spawning actions untouched regardless of origin", async () => {
      mocks.get.mockReturnValue(safeManifestEntry({ id: "actions.list", danger: "safe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

      renderHook(() => useMcpBridge());

      await dispatchHandler?.({
        requestId: "req-list-assistant",
        actionId: "actions.list",
        args: { query: "worktree" },
        sessionOrigin: "assistant-pane",
      });

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "actions.list",
        { query: "worktree" },
        { source: "agent", confirmed: undefined }
      );
    });
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

    it("cannot be talked into claiming assistant provenance from an external session", async () => {
      mocks.get.mockReturnValue(safeManifestEntry({ id: "agent.claude", danger: "safe" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { terminalId: "t-spoof" } });

      renderHook(() => useMcpBridge());

      // The session's authenticated origin decides, not the args — otherwise
      // any external client could dress its spawns up as the user's own
      // assistant, which is exactly the confusion #11808 removes.
      await dispatchHandler?.({
        requestId: "req-spoof",
        actionId: "agent.claude",
        args: { spawnedBy: "assistant" },
        sessionOrigin: "external",
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
    // path, so `current` is set (with approval gated) before the preview lands.
    await Promise.resolve();
    expect(useMcpConfirmStore.getState().current?.requestId).toBe("req-preview");
    expect(useMcpConfirmStore.getState().current?.previewPending).toBe(true);

    // The fresh preview patches the pending item in place and re-enables
    // approval once it resolves.
    await vi.waitFor(() => {
      expect(mocks.buildPreview).toHaveBeenCalledWith("wt-1");
      const current = useMcpConfirmStore.getState().current;
      expect(current?.previewPending).toBe(false);
      expect(current?.preview?.[0]).toContain("1 uncommitted tracked file");
      expect(current?.preview).toContain("  M src/app.ts");
    });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
  });

  it("previews the branch and local commits for an MCP git.push (#11538)", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({ id: "git.push", name: "git.push", title: "Push" })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: undefined });
    mocks.buildGitPreview.mockResolvedValue({
      branch: "feature/x",
      destination: { remote: "origin", branch: "feature/x" },
      pullSource: { remote: "origin", branch: "feature/x" },
      commits: [{ hash: "abcdef1234", message: "Fix the thing", author: "Ada" }],
    });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-push",
      actionId: "git.push",
      args: { cwd: "/repo" },
    });

    await Promise.resolve();
    // Approval is gated until the human can actually see what would be pushed.
    expect(useMcpConfirmStore.getState().current?.previewPending).toBe(true);
    // The heading travels with the lines — a commit list is not "working tree
    // changes", which is what the dialog hardcoded before this change.
    expect(useMcpConfirmStore.getState().current?.previewTitle).toBe("Branch and local commits");

    await vi.waitFor(() => {
      const current = useMcpConfirmStore.getState().current;
      expect(current?.previewPending).toBe(false);
      expect(current?.preview?.[0]).toBe("Destination: origin/feature/x");
      expect(current?.preview?.[1]).toBe("Branch: feature/x");
      expect(current?.preview?.[2]).toContain("Fix the thing");
    });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
    expect(mocks.buildGitPreview).toHaveBeenCalledWith("/repo", "push");
  });

  // The preview resolves cwd when the modal opens; ActionService would otherwise
  // re-read live context AFTER the wait. Switching worktrees mid-modal would
  // then push a repository the human never previewed (#8725).
  it("dispatches git.push against the previewed cwd even if live context drifts", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({ id: "git.push", name: "git.push", title: "Push" })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: undefined });
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/previewed" });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-drift",
      actionId: "git.push",
      args: { setUpstream: true },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });

    // The user switches worktrees while the modal is open.
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/somewhere-else" });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "git.push",
      { setUpstream: true, cwd: "/previewed" },
      expect.objectContaining({ source: "agent", confirmed: true })
    );
  });

  // The whole point of #11538 is that nothing can leave a destructive dispatch
  // permanently unapprovable. A failed preview fetch must still clear
  // previewPending and say so, rather than stranding the modal until timeout.
  it("clears previewPending and warns when the git preview fetch fails", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({ id: "git.push", name: "git.push", title: "Push" })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: undefined });
    mocks.buildGitPreview.mockRejectedValue(new Error("git exploded"));

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-fail",
      actionId: "git.push",
      args: { cwd: "/repo" },
    });

    await vi.waitFor(() => {
      const current = useMcpConfirmStore.getState().current;
      expect(current?.previewPending).toBe(false);
      expect(current?.preview?.[0]).toContain("Could not verify");
    });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
    expect(mocks.dispatch).toHaveBeenCalled();
  });

  it("previews and pins git.pullRebase the same way as git.push (#11538)", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({
        id: "git.pullRebase",
        name: "git.pullRebase",
        title: "Pull and rebase",
      })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: undefined });
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/previewed" });
    mocks.buildGitPreview.mockResolvedValue({
      branch: "feature/y",
      destination: { remote: "fork", branch: "feature/y" },
      pullSource: { remote: "origin", branch: "feature/y" },
      commits: [{ hash: "1234567890a", message: "Replay me", author: "Cy" }],
    });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-rebase",
      actionId: "git.pullRebase",
      args: {},
    });

    await Promise.resolve();
    expect(useMcpConfirmStore.getState().current?.previewPending).toBe(true);
    expect(useMcpConfirmStore.getState().current?.previewTitle).toBe("Branch and local commits");

    await vi.waitFor(() => {
      const current = useMcpConfirmStore.getState().current;
      expect(current?.previewPending).toBe(false);
      // The upstream it rebases onto, never the fork it pushes to (#11746).
      expect(current?.preview?.[0]).toBe("Rebases onto: origin/feature/y");
      expect(current?.preview?.[1]).toBe("Branch: feature/y");
      expect(current?.preview?.[2]).toContain("Replay me");
    });

    // Live context drifts while the modal is open.
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/elsewhere" });
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.buildGitPreview).toHaveBeenCalledWith("/previewed", "pull-rebase");
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "git.pullRebase",
      { cwd: "/previewed" },
      expect.objectContaining({ source: "agent", confirmed: true })
    );
  });

  // A supplied-but-unusable cwd must reach validation unchanged (#7880).
  it("passes an invalid cwd through untouched rather than repairing it", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({ id: "git.push", name: "git.push", title: "Push" })
    );
    mocks.dispatch.mockResolvedValue({ ok: false, error: { code: "VALIDATION_ERROR" } });
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/active" });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-badcwd",
      actionId: "git.push",
      args: { cwd: "" },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.requestId).toBe("req-badcwd");
    });
    // No preview was promised, so nothing gates approval on one.
    expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    expect(mocks.buildGitPreview).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "git.push",
      { cwd: "" },
      expect.objectContaining({ source: "agent" })
    );
  });

  // Malformed top-level args must reach validation as-is. Synthesizing `{cwd}`
  // over them would manufacture a valid push out of a request that should have
  // been rejected — the same #7880 hazard as repairing an empty cwd string.
  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "nope"],
  ])("passes %s args through cwd pinning untouched", async (label, args) => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({ id: "git.push", name: "git.push", title: "Push" })
    );
    mocks.dispatch.mockResolvedValue({ ok: false, error: { code: "VALIDATION_ERROR" } });
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/active" });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: `req-malformed-${label}`,
      actionId: "git.push",
      args,
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "git.push",
      args,
      expect.objectContaining({ source: "agent" })
    );
  });

  it("synthesizes only a cwd when args are omitted entirely", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({ id: "git.push", name: "git.push", title: "Push" })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: undefined });
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/previewed" });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({ requestId: "req-noargs", actionId: "git.push" });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/elsewhere" });
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "git.push",
      { cwd: "/previewed" },
      expect.objectContaining({ source: "agent", confirmed: true })
    );
  });

  it("leaves non-git dispatch args untouched by cwd pinning", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-nopin",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "worktree.delete",
      { worktreeId: "wt-1" },
      expect.objectContaining({ source: "agent" })
    );
  });
  it("asks ActionService for the danger of THIS dispatch, not the action's static tier (#11860)", () => {
    // The gate is args-conditional: worktree.createWithRecipe is statically
    // "safe" and only becomes confirm when the args name a recipe. If this call
    // ever reverts to the bare `getDispatchMeta(actionId)`, the bridge reads
    // "safe", skips the modal, dispatches unconfirmed, and ActionService returns
    // CONFIRMATION_REQUIRED with no dialog ever shown — a permanent dead end for
    // every legitimate agent recipe launch.
    mocks.get.mockReturnValue(safeManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    void dispatchHandler?.({
      requestId: "req-meta",
      actionId: "worktree.createWithRecipe",
      args: { branchName: "feat/x", recipeId: "recipe-1" },
    });

    expect(mocks.get).toHaveBeenCalledWith("worktree.createWithRecipe", {
      source: "agent",
      args: { branchName: "feat/x", recipeId: "recipe-1" },
    });
  });

  it("opens the modal for an args-elevated dispatch and only runs it after approval (#11860)", async () => {
    // Mirrors the real resolver: safe on its own, confirm once a recipeId rides along.
    mocks.get.mockImplementation((_id: string, dispatch?: { args?: unknown }) => {
      const args = dispatch?.args as { recipeId?: string } | undefined;
      return args?.recipeId
        ? confirmManifestEntry({
            id: "worktree.createWithRecipe",
            name: "worktree.createWithRecipe",
            title: "Create Worktree with Recipe",
            dangerRationale: "spawns the recipe's terminals",
          })
        : safeManifestEntry({ id: "worktree.createWithRecipe" });
    });
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-elevated",
      actionId: "worktree.createWithRecipe",
      args: { branchName: "feat/x", recipeId: "recipe-1" },
    });

    await Promise.resolve();
    const pending = useMcpConfirmStore.getState().current;
    expect(pending).not.toBeNull();
    expect(pending?.danger).toBe("confirm");
    expect(pending?.dangerRationale).toBe("spawns the recipe's terminals");
    // Nothing has run — the whole point of gating before the composite creates
    // a worktree rather than prompting once the effects have landed.
    expect(mocks.dispatch).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "worktree.createWithRecipe",
      expect.objectContaining({ recipeId: "recipe-1", branchName: "feat/x" }),
      expect.objectContaining({ source: "agent", confirmed: true })
    );
  });

  it("does not raise a modal for the same action when no recipe is named (#11860)", async () => {
    mocks.get.mockImplementation((_id: string, dispatch?: { args?: unknown }) => {
      const args = dispatch?.args as { recipeId?: string } | undefined;
      return args?.recipeId
        ? confirmManifestEntry({ id: "worktree.createWithRecipe" })
        : safeManifestEntry({ id: "worktree.createWithRecipe" });
    });
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-plain",
      actionId: "worktree.createWithRecipe",
      args: { branchName: "feat/x" },
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalled();
  });

  it("pins an approved recipe dispatch to the resolved winner it previewed (#11860)", async () => {
    // getRecipeById follows shadowing, so the id the caller named and the recipe
    // the approver saw can differ. The dispatch must run what was shown.
    const { useRecipeStore } = await import("@/store/recipeStore");
    useRecipeStore.setState({
      recipes: [
        {
          id: "shadowed",
          name: "Work",
          projectId: "p1",
          shadowedBy: "Work",
          terminals: [{ type: "terminal", command: "old" }],
          createdAt: 1,
        },
        {
          id: "winner",
          name: "Work",
          projectId: "p1",
          scope: "inrepo",
          terminals: [{ type: "terminal", command: "new" }],
          createdAt: 1,
        },
      ],
      inRepoRecipes: [
        {
          id: "winner",
          name: "Work",
          projectId: "p1",
          scope: "inrepo",
          terminals: [{ type: "terminal", command: "new" }],
          createdAt: 1,
        },
      ],
    });

    mocks.get.mockReturnValue(confirmManifestEntry({ id: "recipe.run", name: "recipe.run" }));
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-pin",
      actionId: "recipe.run",
      args: { recipeId: "shadowed" },
    });

    await Promise.resolve();
    await Promise.resolve();
    const preview = (useMcpConfirmStore.getState().current?.preview ?? []).join("\n");
    expect(preview).toContain("new");
    expect(preview).not.toContain("old");

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "recipe.run",
      expect.objectContaining({ recipeId: "winner" }),
      expect.objectContaining({ confirmed: true })
    );
    useRecipeStore.getState().reset();
  });
});

describe("resolveMcpConfirmPreviewTarget (#11538)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getContext.mockReturnValue({});
  });

  it("returns undefined for actions with nothing meaningful to preview", () => {
    expect(
      resolveMcpConfirmPreviewTarget("terminal.kill", { terminalId: "t-1" }, undefined)
    ).toBeUndefined();
  });

  it("returns undefined when worktree.delete args carry no worktreeId", () => {
    expect(
      resolveMcpConfirmPreviewTarget("worktree.delete", { force: true }, undefined)
    ).toBeUndefined();
  });

  it("resolves a worktree.delete target from its worktreeId", () => {
    expect(
      resolveMcpConfirmPreviewTarget("worktree.delete", { worktreeId: "wt-1" }, undefined)
    ).toEqual({ kind: "worktreeDelete", worktreeId: "wt-1" });
  });

  it("prefers an explicit cwd arg over any context for git dispatch", () => {
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/live" });
    expect(
      resolveMcpConfirmPreviewTarget(
        "git.push",
        { cwd: "/explicit" },
        { activeWorktreePath: "/bound" }
      )
    ).toEqual({ kind: "gitPush", cwd: "/explicit" });
  });

  it("falls back to the bound context's worktree path when no cwd arg is given", () => {
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/live" });
    expect(
      resolveMcpConfirmPreviewTarget("git.pullRebase", {}, { activeWorktreePath: "/bound" })
    ).toEqual({ kind: "gitPullRebase", cwd: "/bound" });
    expect(mocks.getContext).not.toHaveBeenCalled();
  });

  it("falls back to live context only for unpinned dispatch (no bound context)", () => {
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/live" });
    expect(resolveMcpConfirmPreviewTarget("git.push", undefined, undefined)).toEqual({
      kind: "gitPush",
      cwd: "/live",
    });
  });

  // #7880 no-silent-fallback: a caller that NAMES a cwd but gives an unusable
  // one must not have it quietly swapped for the active worktree. Before this
  // path existed those dispatches failed validation; silently repairing them
  // would turn a rejected request into a real push against a repository the
  // caller never asked for.
  it.each([
    ["empty string", { cwd: "" }],
    ["null", { cwd: null }],
    ["a number", { cwd: 0 }],
  ])("refuses to preview git.push when cwd is supplied as %s", (_label, args) => {
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/active" });
    expect(resolveMcpConfirmPreviewTarget("git.push", args, undefined)).toBeUndefined();
  });

  it("still resolves from context when cwd is explicitly undefined (genuinely omitted)", () => {
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/active" });
    expect(resolveMcpConfirmPreviewTarget("git.push", { cwd: undefined }, undefined)).toEqual({
      kind: "gitPush",
      cwd: "/active",
    });
  });

  // ActionService selects context with a WHOLE-OBJECT `??` (ActionService.ts:349),
  // so a bound context that carries no worktree path does NOT borrow the live
  // one — the action would throw "No active worktree". A per-field fallback here
  // would preview a repository the dispatch never touches.
  it("does not borrow the live worktree path per-field when a bound context lacks one", () => {
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/live" });
    expect(resolveMcpConfirmPreviewTarget("git.push", {}, { projectId: "p-1" })).toBeUndefined();
  });

  // Since #11543 the git actions also accept `worktreeId`/`worktreePath`.
  // Reading only `cwd` would report "omitted" for those, preview the ACTIVE
  // worktree, and then pin a dispatch that `run()` resolves somewhere else —
  // the approver attesting to a repository they never saw, which is the whole
  // point of the preview (#8725) and a D2 no-silent-fallback violation (#7880).
  describe("with the shared location vocabulary (#11543)", () => {
    beforeEach(() => {
      setWorktreePathIndexAccessor(
        () =>
          new Map([
            ["wt-1", "/repo/one"],
            ["wt-2", "/repo/two"],
          ])
      );
    });

    afterEach(() => {
      resetStoreAccessorsForTesting();
    });

    it("previews the worktree a worktreeId names rather than the active one", () => {
      expect(
        resolveMcpConfirmPreviewTarget(
          "git.push",
          { worktreeId: "wt-2" },
          { activeWorktreePath: "/repo/one" }
        )
      ).toEqual({ kind: "gitPush", cwd: "/repo/two" });
    });

    it("previews an explicit worktreePath rather than the active worktree", () => {
      expect(
        resolveMcpConfirmPreviewTarget(
          "git.pullRebase",
          { worktreePath: "/repo/two" },
          { activeWorktreePath: "/repo/one" }
        )
      ).toEqual({ kind: "gitPullRebase", cwd: "/repo/two" });
    });

    it("refuses to preview a worktreeId no open worktree matches", () => {
      expect(
        resolveMcpConfirmPreviewTarget(
          "git.push",
          { worktreeId: "wt-gone" },
          { activeWorktreePath: "/repo/one" }
        )
      ).toBeUndefined();
    });

    it("refuses to preview contradictory path spellings the schema will reject", () => {
      expect(
        resolveMcpConfirmPreviewTarget(
          "git.push",
          { worktreePath: "/repo/one", cwd: "/repo/two" },
          { activeWorktreePath: "/repo/one" }
        )
      ).toBeUndefined();
    });
  });
});

describe("buildMcpConfirmPreview (#11343, #11538)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPreview.mockResolvedValue(null);
    mocks.buildGitPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
    });
  });

  it("returns no lines when the monitor is gone (builder resolves null)", async () => {
    mocks.buildPreview.mockResolvedValue(null);
    await expect(
      buildMcpConfirmPreview({ kind: "worktreeDelete", worktreeId: "wt-1" })
    ).resolves.toEqual([]);
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
    const lines = await buildMcpConfirmPreview({ kind: "worktreeDelete", worktreeId: "wt-1" });
    expect(lines[0]).toContain("1 uncommitted tracked file");
    expect(lines).toContain("  M src/app.ts");
  });

  it("fails closed with a couldn't-verify note when the fresh fetch throws", async () => {
    mocks.buildPreview.mockRejectedValue(new Error("timeout"));
    const lines = await buildMcpConfirmPreview({ kind: "worktreeDelete", worktreeId: "wt-1" });
    expect(lines).toEqual(["⚠ Could not verify current changes — proceed with caution."]);
  });

  it("surfaces the branch and actual commits for a git.push target", async () => {
    mocks.buildGitPreview.mockResolvedValue({
      branch: "feature/x",
      destination: { remote: "origin", branch: "feature/x" },
      pullSource: { remote: "origin", branch: "feature/x" },
      commits: [{ hash: "abcdef1234", message: "Fix the thing", author: "Ada" }],
    });
    const lines = await buildMcpConfirmPreview({ kind: "gitPush", cwd: "/repo" });
    expect(mocks.buildGitPreview).toHaveBeenCalledWith("/repo", "push");
    expect(lines[0]).toBe("Destination: origin/feature/x");
    expect(lines[1]).toBe("Branch: feature/x");
    expect(lines[2]).toContain("Fix the thing");
    expect(lines[2]).toContain("Ada");
  });

  it("distinguishes an empty branch from an unverifiable one for git targets", async () => {
    mocks.buildGitPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "fork", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
    });
    const empty = await buildMcpConfirmPreview({ kind: "gitPullRebase", cwd: "/repo" });
    expect(empty).toEqual([
      "Rebases onto: origin/main",
      "Branch: main",
      "No local commits to replay.",
    ]);

    mocks.buildGitPreview.mockRejectedValue(new Error("git exploded"));
    const failed = await buildMcpConfirmPreview({ kind: "gitPush", cwd: "/repo" });
    expect(failed[0]).toContain("Could not verify");
  });
});
