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
  // The renderer's own worktree records — the ONLY source of the typed-name
  // gate's identity half (#12115). Empty by default so `resolveMcpConfirmSubject`
  // keeps answering undefined exactly as it did before this store was mocked.
  worktrees: new Map<string, unknown>(),
  viewStoreThrows: false,
  // The renderer's panel roster, read synchronously when a batch kill's
  // checklist is frozen (#12123). Empty by default so nothing else changes.
  panelsById: {} as Record<string, unknown>,
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

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById: mocks.panelsById }) },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => {
    // The real one THROWS when no worktree view store is mounted, and both
    // `resolveMcpConfirmSubject` and the typed-name gate depend on failing
    // sanely there — so the mock has to be able to throw too.
    if (mocks.viewStoreThrows) throw new Error("no worktree view store mounted");
    return { getState: () => ({ worktrees: mocks.worktrees }) };
  },
}));

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
  buildTerminalKillBatchTargets,
  resolveMcpConfirmPreviewTarget,
  resolveMcpConfirmSubject,
  resolveWorktreeDeleteGate,
  tagMcpSpawnSource,
  worktreeDeleteGateRefusal,
} from "../useMcpBridge";
import type { WorktreeDeletePreviewOutcome } from "@/components/Worktree/worktreeDeletePreview";
import { TerminalSpawnSourceSchema } from "@/services/actions/definitions/schemas";
import { hasCautionLine } from "@/lib/mcpPreviewLines";
import type { SubmoduleDeleteRisk } from "@shared/types/submodule";
import { MAX_KILL_BATCH_TERMINALS } from "@shared/types/terminalKillBatch";

/** A completed submodule inventory that found nothing — the ordinary case. */
function emptySubmoduleRisk(over: Partial<SubmoduleDeleteRisk> = {}): SubmoduleDeleteRisk {
  return {
    entries: [],
    dirtyFiles: [],
    untrackedFiles: [],
    atRiskCommits: [],
    requiresMechanicalForce: false,
    incomplete: false,
    ...over,
  };
}

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
    mocks.worktrees.clear();
    mocks.viewStoreThrows = false;
    mocks.panelsById = {};
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

  // #12118: the two forge writes that publish something nobody can retract now
  // raise the confirm — and the only surface an agent's approver sees is this
  // modal, so the body has to reach it as content rather than as the redacted
  // `<string: N chars>` the arguments disclosure shows.
  it("previews the authored issue content and pins the worktree it resolved (#12118)", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({
        id: "forge.createIssue",
        name: "forge.createIssue",
        title: "Create Issue",
        category: "forge",
      })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/repo/active" });

    renderHook(() => useMcpBridge());

    const body = `The reporter said:\n${"z".repeat(120)}`;
    const dispatched = dispatchHandler?.({
      requestId: "req-create-issue",
      actionId: "forge.createIssue",
      args: { title: "Crash on startup", body, labels: ["bug"] },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.preview).toBeDefined();
    });
    const current = useMcpConfirmStore.getState().current;
    expect(current?.previewTitle).toBe("Issue to be filed");
    const previewText = (current?.preview ?? []).join("\n");
    expect(previewText).toContain("Worktree: /repo/active");
    expect(previewText).toContain("Crash on startup");
    expect(previewText).toContain(body.split("\n")[1]);
    // The disclosure the approver would otherwise have relied on hides exactly
    // the part the preview now shows.
    expect(current?.argsSummary).not.toContain("zzz");

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    // The approved dispatch is pinned to the worktree the card named, so a
    // worktree switch during the modal cannot redirect the filing.
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "forge.createIssue",
      expect.objectContaining({ title: "Crash on startup", cwd: "/repo/active" }),
      expect.objectContaining({ source: "agent", confirmed: true })
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
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
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

  it("puts the D3 typed-name gate on an agent's force delete of a dirty worktree (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "feature-x",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
    });
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 1,
      untrackedFileCount: 0,
      hasTrackedChanges: true,
      hasUntrackedFiles: false,
      changes: [{ path: "src/app.ts", status: "modified", insertions: null, deletions: null }],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-gate",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1", force: true },
    });

    await vi.waitFor(() => {
      const current = useMcpConfirmStore.getState().current;
      expect(current?.previewPending).toBe(false);
      // The name is the worktree's own, from the renderer's store — nothing in
      // `args` named it, and nothing in `args` could have.
      expect(current?.typedNameTarget).toBe("feature/x");
    });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-force MCP delete ungated and re-checks nothing (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "feature-x",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
    });
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 5,
      untrackedFileCount: 0,
      hasTrackedChanges: true,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-plain",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    expect(useMcpConfirmStore.getState().current?.typedNameTarget).toBeUndefined();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
    // One fetch for the preview, and no second one: a plain delete cannot
    // destroy anything the host does not first refuse, so paying for a
    // pre-dispatch re-check on every one of them buys nothing.
    expect(mocks.buildPreview).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("refuses a force delete whose worktree turned dirty behind the approval (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "feature-x",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
    });
    const clean = {
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    };
    // Clean when previewed — so the modal shows no typed-name gate — then an
    // agent writes tracked files while the human is still reading it.
    mocks.buildPreview
      .mockResolvedValueOnce(clean)
      .mockResolvedValue({ ...clean, trackedChangeCount: 2, hasTrackedChanges: true });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-drift",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1", force: true },
    });

    await vi.waitFor(() => {
      const current = useMcpConfirmStore.getState().current;
      expect(current?.previewPending).toBe(false);
      expect(current?.typedNameTarget).toBeUndefined();
    });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    // The approval was for a D2 delete; the delete on offer is now D3.
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-drift",
      result: {
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: expect.stringContaining("feature/x"),
        },
      },
      confirmationDecision: "approved",
    });
  });

  it("still dispatches when the pre-dispatch re-check comes back cleaner (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "feature-x",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
    });
    const clean = {
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    };
    // Gated as D3 at preview time, committed clean before the click. An
    // approval gated on MORE than the tier now requires is still consent.
    mocks.buildPreview
      .mockResolvedValueOnce({ ...clean, trackedChangeCount: 2, hasTrackedChanges: true })
      .mockResolvedValue(clean);

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-downgrade",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1", force: true },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.typedNameTarget).toBe("feature/x");
    });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("re-reads the worktree identity at dispatch time, not the one it previewed (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "wt-1",
      branch: "renderer/alpha",
      isCurrent: false,
      isMainWorktree: false,
    });
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 1,
      untrackedFileCount: 0,
      hasTrackedChanges: true,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-rename",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1", force: true },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.typedNameTarget).toBe("renderer/alpha");
    });

    // The branch is renamed while the human is still reading the modal. Typing
    // the old name attested to a worktree that no longer answers to it.
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "wt-1",
      branch: "renderer/beta",
      isCurrent: false,
      isMainWorktree: false,
    });

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-rename",
      result: {
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: expect.stringContaining("renderer/beta"),
        },
      },
      confirmationDecision: "approved",
    });
  });

  it("refuses an approved force delete this view can no longer resolve (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    // No worktree record at all: the protected-branch and main-worktree inputs
    // live on it, so the tier is unknowable and a D2 approval cannot cover it.
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-unresolvable",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1", force: true },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-unresolvable",
      result: {
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED", message: expect.stringContaining("resolve") },
      },
      confirmationDecision: "approved",
    });
  });

  it("refuses a native grant's force delete that turns out to be D3 (#12115)", async () => {
    // A grant pre-authorises the D2 modal, not the typed-name attestation: it
    // names a tool, ahead of time, with no target or preview in front of the
    // person who issued it. So the granted call gives up `confirmed: true` and
    // raises the confirmation on its own account.
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "wt-1",
      branch: "main",
      isCurrent: false,
      isMainWorktree: false,
    });
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-grant",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1", force: true },
      confirmed: true,
    });

    // The grant did not skip the gate: a modal is raised, carrying it.
    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.typedNameTarget).toBe("main");
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("still honours a native grant for a force delete that is only D2 (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "wt-1",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
    });
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-grant-d2",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1", force: true },
      confirmed: true,
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("never acts on an approval that outlived main's dispatch deadline (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "wt-1",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
    });
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    });
    // Main dropped this dispatch and told the agent it timed out; a delete
    // starting now destroys a worktree behind a reported failure.
    const realNow = Date.now;
    const start = realNow();
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => start + elapsed);

    try {
      renderHook(() => useMcpBridge());
      const dispatched = dispatchHandler?.({
        requestId: "req-late",
        actionId: "worktree.delete",
        args: { worktreeId: "wt-1", force: true },
      });

      await vi.waitFor(() => {
        expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
      });
      // Past the bridge's own action deadline (main's 30s less the re-check
      // budget it may still have to spend), which is the point where it can no
      // longer prove the call is still live.
      elapsed = 26_000;
      useMcpConfirmStore.getState().resolveCurrent("approved");
      await dispatched;

      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(sendDispatchActionResponse).toHaveBeenCalledWith({
        requestId: "req-late",
        result: {
          ok: false,
          error: {
            code: "CONFIRMATION_TIMEOUT",
            message: expect.stringContaining("dispatch deadline"),
          },
        },
        confirmationDecision: "approved",
      });
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("drops a teardown-racing force delete without dispatching or answering (#12115)", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "wt-1",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
    });
    const clean = {
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      rootPath: "/repo/wt-1",
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    };
    let releaseRecheck: (() => void) | undefined;
    mocks.buildPreview.mockResolvedValueOnce(clean).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRecheck = () => resolve(clean);
        })
    );

    const { unmount } = renderHook(() => useMcpBridge());
    const dispatched = dispatchHandler?.({
      requestId: "req-teardown",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1", force: true },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await vi.waitFor(() => expect(releaseRecheck).toBeTypeOf("function"));

    unmount();
    releaseRecheck?.();
    await dispatched;

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).not.toHaveBeenCalled();
  });

  it("keeps a generic confirmation when no worktree view store is mounted at all", async () => {
    // `getCurrentViewStore` throws there. Letting it escape would turn a
    // destructive confirmation into an EXECUTION_ERROR — the dispatch would
    // fail instead of asking the user.
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
    mocks.viewStoreThrows = true;

    renderHook(() => useMcpBridge());
    const dispatched = dispatchHandler?.({
      requestId: "req-noview",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });

    await Promise.resolve();
    const pending = useMcpConfirmStore.getState().current;
    expect(pending?.requestId).toBe("req-noview");
    expect(pending).not.toHaveProperty("subject");

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
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

  // The pin used to KEEP every selector the caller sent and merely add `cwd`.
  // That was both weaker and more brittle than it looked: `worktreeId` wins
  // outright in `resolveWorktreeLocation`, so the pinned cwd was never
  // consulted for an id-named dispatch; and an id alongside a DIFFERENT path
  // (which used to dispatch fine, the id winning) tripped the resolver's
  // contradictory-spellings guard once a third spelling was added, failing a
  // dispatch the human had already approved.
  it("replaces every selector spelling with the one canonical previewed cwd", async () => {
    setWorktreePathIndexAccessor(() => new Map([["wt-1", "/repo/one"]]));
    mocks.get.mockReturnValue(
      confirmManifestEntry({ id: "git.push", name: "git.push", title: "Push" })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: undefined });
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/active" });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-canonical-pin",
      actionId: "git.push",
      args: { worktreeId: "wt-1", worktreePath: "/somewhere-else", setUpstream: true },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "git.push",
      { setUpstream: true, cwd: "/repo/one" },
      expect.objectContaining({ source: "agent", confirmed: true })
    );
  });

  it("pins nothing when the forge target could not resolve a repository", async () => {
    mocks.get.mockReturnValue(
      confirmManifestEntry({
        id: "forge.addIssueComment",
        name: "forge.addIssueComment",
        title: "Add Issue Comment",
        category: "forge",
      })
    );
    mocks.dispatch.mockResolvedValue({ ok: true, result: undefined });
    mocks.getContext.mockReturnValue({});

    renderHook(() => useMcpBridge());

    const args = { issueNumber: 4, body: "still broken" };
    const dispatched = dispatchHandler?.({
      requestId: "req-no-pin-forge",
      actionId: "forge.addIssueComment",
      args,
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    // The content still reached the approver, with the unknown target flagged.
    const preview = (useMcpConfirmStore.getState().current?.preview ?? []).join("\n");
    expect(preview).toContain("still broken");
    expect(preview).toContain("Couldn't identify the repository");

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    // No `cwd: undefined` smuggled in — that would replace a selector the
    // caller might have supplied with a field that fails `.min(1)`.
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "forge.addIssueComment",
      args,
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
      // The approval names the winner too, not the id the caller asked for —
      // recipeStore matches on the resolved id, so a scope naming "shadowed"
      // would silently fall back to the unapproved cap (#12263).
      expect.objectContaining({
        confirmed: true,
        hostApprovedRecipeRun: { recipeId: "winner", terminalCount: 1 },
      })
    );
    useRecipeStore.getState().reset();
  });

  describe("recipe run approval scope (#12263)", () => {
    const fiveTerminalRecipe = {
      id: "recipe-1",
      name: "Fleet",
      projectId: "p1",
      terminals: Array.from({ length: 5 }, (_, i) => ({
        type: "terminal" as const,
        command: `step-${i}`,
      })),
      createdAt: 1,
    };

    async function seedRecipe() {
      const { useRecipeStore } = await import("@/store/recipeStore");
      useRecipeStore.setState({ recipes: [fiveTerminalRecipe] });
      return useRecipeStore;
    }

    it("offers every terminal and carries the approved count into the dispatch", async () => {
      const useRecipeStore = await seedRecipe();
      mocks.get.mockReturnValue(confirmManifestEntry({ id: "recipe.run", name: "recipe.run" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
      renderHook(() => useMcpBridge());

      const dispatched = dispatchHandler?.({
        requestId: "req-scope",
        actionId: "recipe.run",
        args: { recipeId: "recipe-1" },
      });
      await Promise.resolve();
      await Promise.resolve();

      // What the approver reads and what the approval authorizes are the same
      // number, by construction — both come from the one resolved recipe.
      const preview = (useMcpConfirmStore.getState().current?.preview ?? []).join("\n");
      expect(preview).toContain("Starts 5 terminals");
      expect(preview).not.toContain("not started");

      useMcpConfirmStore.getState().resolveCurrent("approved");
      await dispatched;

      const options = mocks.dispatch.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(options.source).toBe("agent");
      expect(options.hostApprovedRecipeRun).toEqual({ recipeId: "recipe-1", terminalCount: 5 });
      useRecipeStore.getState().reset();
    });

    it("carries no approval scope for a pre-granted dispatch that showed no modal", async () => {
      // A standing automation grant names a tool in Settings — no arguments, no
      // preview, nobody shown five terminals. It must stay on the unapproved
      // cap, which is exactly what an absent scope means downstream.
      const useRecipeStore = await seedRecipe();
      mocks.get.mockReturnValue(confirmManifestEntry({ id: "recipe.run", name: "recipe.run" }));
      mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });
      renderHook(() => useMcpBridge());

      await dispatchHandler?.({
        requestId: "req-granted",
        actionId: "recipe.run",
        args: { recipeId: "recipe-1" },
        confirmed: true,
      });

      const options = mocks.dispatch.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(options.hostApprovedRecipeRun).toBeUndefined();
      useRecipeStore.getState().reset();
    });

    it("dispatches no approval scope when the approver rejected", async () => {
      const useRecipeStore = await seedRecipe();
      mocks.get.mockReturnValue(confirmManifestEntry({ id: "recipe.run", name: "recipe.run" }));
      renderHook(() => useMcpBridge());

      const dispatched = dispatchHandler?.({
        requestId: "req-reject",
        actionId: "recipe.run",
        args: { recipeId: "recipe-1" },
      });
      await Promise.resolve();
      useMcpConfirmStore.getState().resolveCurrent("rejected");
      await dispatched;

      expect(mocks.dispatch).not.toHaveBeenCalled();
      useRecipeStore.getState().reset();
    });
  });
  describe("batch terminal kill dispatch (#12123)", () => {
    function killBatchManifestEntry() {
      return confirmManifestEntry({
        id: "terminal.killBatch",
        name: "terminal.killBatch",
        title: "Kill terminals",
        description: "Permanently destroy several named panels.",
        category: "terminal",
      });
    }

    it("opens the modal with an approvable checklist and no pending preview fetch", async () => {
      mocks.get.mockReturnValue(killBatchManifestEntry());
      mocks.panelsById = { p1: { id: "p1", title: "zsh" }, p2: { id: "p2", title: "vitest" } };
      renderHook(() => useMcpBridge());

      void dispatchHandler?.({
        requestId: "req-batch",
        actionId: "terminal.killBatch",
        args: { terminalIds: ["p1", "p2"] },
      });
      await Promise.resolve();

      const current = useMcpConfirmStore.getState().current;
      expect(current?.selectableTargets?.map((target) => target.id)).toEqual(["p1", "p2"]);
      expect(current?.selectionConfirmLabel).toEqual({
        verb: "Kill",
        one: "terminal",
        many: "terminals",
      });
      // Nothing is being fetched, so approval must not be held behind a preview
      // gate that would never clear.
      expect(current?.previewPending).toBe(false);
      expect(current?.previewTitle).toBeUndefined();
    });

    it("dispatches only the approved rows, each carrying the state its row showed", async () => {
      mocks.get.mockReturnValue(killBatchManifestEntry());
      mocks.dispatch.mockResolvedValue({ ok: true, data: {} });
      mocks.panelsById = {
        p1: { id: "p1", title: "claude", detectedAgentId: "claude", agentState: "working" },
        p2: { id: "p2", title: "zsh" },
        p3: { id: "p3", title: "vitest" },
      };
      renderHook(() => useMcpBridge());

      const dispatched = dispatchHandler?.({
        requestId: "req-batch",
        actionId: "terminal.killBatch",
        args: { terminalIds: ["p1", "p2", "p3"] },
      });
      await Promise.resolve();
      useMcpConfirmStore.getState().resolveCurrent("approved", ["p1", "p3"]);
      await dispatched;

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "terminal.killBatch",
        { terminalIds: ["p1", "p2", "p3"] },
        expect.objectContaining({
          confirmed: true,
          hostApprovedTargets: [
            { id: "p1", observedAgentRunning: true },
            { id: "p3", observedAgentRunning: false },
          ],
        })
      );
    });

    it("stamps an empty approval when every row was unchecked", async () => {
      mocks.get.mockReturnValue(killBatchManifestEntry());
      mocks.dispatch.mockResolvedValue({ ok: true, data: {} });
      mocks.panelsById = { p1: { id: "p1", title: "zsh" } };
      renderHook(() => useMcpBridge());

      const dispatched = dispatchHandler?.({
        requestId: "req-batch",
        actionId: "terminal.killBatch",
        args: { terminalIds: ["p1"] },
      });
      await Promise.resolve();
      useMcpConfirmStore.getState().resolveCurrent("approved", []);
      await dispatched;

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "terminal.killBatch",
        { terminalIds: ["p1"] },
        expect.objectContaining({ hostApprovedTargets: [] })
      );
    });

    it("dispatches nothing when the batch is rejected", async () => {
      mocks.get.mockReturnValue(killBatchManifestEntry());
      mocks.panelsById = { p1: { id: "p1", title: "zsh" } };
      renderHook(() => useMcpBridge());

      const dispatched = dispatchHandler?.({
        requestId: "req-batch",
        actionId: "terminal.killBatch",
        args: { terminalIds: ["p1"] },
      });
      await Promise.resolve();
      useMcpConfirmStore.getState().resolveCurrent("rejected");
      await dispatched;

      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(sendDispatchActionResponse).toHaveBeenCalledWith(
        expect.objectContaining({ confirmationDecision: "rejected" })
      );
    });

    it("carries no per-target approval for a pre-granted dispatch that showed no modal", async () => {
      mocks.get.mockReturnValue(killBatchManifestEntry());
      mocks.dispatch.mockResolvedValue({ ok: true, data: {} });
      mocks.panelsById = { p1: { id: "p1", title: "zsh" } };
      renderHook(() => useMcpBridge());

      await dispatchHandler?.({
        requestId: "req-batch",
        actionId: "terminal.killBatch",
        args: { terminalIds: ["p1"] },
        confirmed: true,
      });

      const options = mocks.dispatch.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(options.hostApprovedTargets).toBeUndefined();
    });
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

  it("previews a terminal.new that names a launch target (#12216)", () => {
    // The elevation these arguments earn makes this modal the only gate on an
    // agent-initiated shell, and the collapsed argument summary redacts every
    // command long enough to be worth reading.
    expect(
      resolveMcpConfirmPreviewTarget("terminal.new", { command: "npm run deploy" }, undefined)
    ).toEqual({ kind: "terminalLaunch", command: "npm run deploy", cwd: undefined });

    expect(
      resolveMcpConfirmPreviewTarget("terminal.new", { cwd: "/repo/other" }, undefined)
    ).toEqual({ kind: "terminalLaunch", command: undefined, cwd: "/repo/other" });
  });

  it("gives a plain terminal.new no preview, matching the elevation", () => {
    // Nothing elevated it, so there is no modal to fill — and a card for a bare
    // "open a terminal" would be noise on a dispatch nobody is asked about.
    expect(
      resolveMcpConfirmPreviewTarget("terminal.new", { focusPolicy: "auto" }, undefined)
    ).toBeUndefined();
    expect(resolveMcpConfirmPreviewTarget("terminal.new", undefined, undefined)).toBeUndefined();
  });

  it("does not preview a command argument on some other action", () => {
    // Scoped by id, exactly as the elevation is: `system.checkCommand` takes a
    // `command` and explicitly runs nothing.
    expect(
      resolveMcpConfirmPreviewTarget("system.checkCommand", { command: "node" }, undefined)
    ).toBeUndefined();
  });

  it("returns undefined when worktree.delete args carry no worktreeId", () => {
    expect(
      resolveMcpConfirmPreviewTarget("worktree.delete", { force: true }, undefined)
    ).toBeUndefined();
  });

  it.each([
    ["a string 'false'", "false"],
    ["a truthy number", 1],
    ["a zero", 0],
    ["null", null],
    ["an absent flag", undefined],
  ])("treats %s as a non-force delete — only a literal true forces (#12115)", (_label, force) => {
    // Coercion here would let a caller reach the destructive path through a
    // value `argsSchema` would have rejected, and the gate keys off this flag.
    expect(
      resolveMcpConfirmPreviewTarget("worktree.delete", { worktreeId: "wt-1", force }, undefined)
    ).toEqual({ kind: "worktreeDelete", worktreeId: "wt-1", force: false });
  });

  it("carries a literal force: true through to the target", () => {
    expect(
      resolveMcpConfirmPreviewTarget(
        "worktree.delete",
        { worktreeId: "wt-1", force: true },
        undefined
      )
    ).toEqual({ kind: "worktreeDelete", worktreeId: "wt-1", force: true });
  });

  it("resolves a worktree.delete target from its worktreeId", () => {
    expect(
      resolveMcpConfirmPreviewTarget("worktree.delete", { worktreeId: "wt-1" }, undefined)
    ).toEqual({ kind: "worktreeDelete", worktreeId: "wt-1", force: false });
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

describe("resolveMcpConfirmSubject for a terminal launch (#12216)", () => {
  beforeEach(() => {
    mocks.worktrees.clear();
    mocks.viewStoreThrows = false;
  });

  afterEach(() => {
    mocks.worktrees.clear();
    mocks.viewStoreThrows = false;
  });

  it("names the worktree the chosen directory is, from the store", () => {
    mocks.worktrees.set("wt-1", { id: "wt-1", path: "/repo/feature", branch: "feat/x" });

    expect(
      resolveMcpConfirmSubject({ kind: "terminalLaunch", command: "ls", cwd: "/repo/feature" })
    ).toBe("feat/x");
  });

  it("falls back to the name for a detached worktree carrying an empty branch", () => {
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/detached",
      branch: "",
      name: "detached",
    });

    expect(
      resolveMcpConfirmSubject({
        kind: "terminalLaunch",
        command: undefined,
        cwd: "/repo/detached",
      })
    ).toBe("detached");
  });

  it("keeps the generic title rather than putting a caller's path in it", () => {
    // The title is the dialog's accessible name; a directory that is no
    // worktree root resolves to nothing rather than echoing the argument.
    expect(
      resolveMcpConfirmSubject({ kind: "terminalLaunch", command: "ls", cwd: "/tmp/elsewhere" })
    ).toBeUndefined();
    expect(
      resolveMcpConfirmSubject({ kind: "terminalLaunch", command: "ls", cwd: undefined })
    ).toBeUndefined();
  });

  it("fails soft when no worktree view store is mounted", () => {
    mocks.viewStoreThrows = true;

    expect(
      resolveMcpConfirmSubject({ kind: "terminalLaunch", command: "ls", cwd: "/repo/feature" })
    ).toBeUndefined();
  });
});

/**
 * The D3 typed-name gate for an agent-dispatched force delete (#12115).
 *
 * The invariant under test is narrow and load-bearing: the string a human has
 * to type comes from the renderer's own worktree record and a fresh fetch, and
 * NOTHING an MCP caller puts in `args` can name it, weaken it, or clear it.
 */
describe("resolveWorktreeDeleteGate (#12115)", () => {
  beforeEach(() => {
    mocks.worktrees.clear();
  });

  function seedWorktree(over: Record<string, unknown> = {}) {
    mocks.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo/wt-1",
      name: "feature-x",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
      ...over,
    });
  }

  function verified(over: Record<string, unknown> = {}): WorktreeDeletePreviewOutcome {
    return {
      state: "verified",
      preview: {
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        hasTrackedChanges: false,
        hasUntrackedFiles: false,
        changes: [],
        rootPath: "/repo/wt-1",
        submodules: { status: "verified", risk: emptySubmoduleRisk() },
        ...over,
      },
    } as WorktreeDeletePreviewOutcome;
  }

  const target = { kind: "worktreeDelete", worktreeId: "wt-1", force: true } as const;

  it("puts no gate on a delete the caller never asked to force", () => {
    seedWorktree();
    expect(
      resolveWorktreeDeleteGate(
        { ...target, force: false },
        verified({ hasTrackedChanges: true, trackedChangeCount: 3 })
      )
    ).toEqual({ state: "none" });
  });

  it("demands the branch name for a force delete that discards tracked changes", () => {
    seedWorktree();
    expect(
      resolveWorktreeDeleteGate(
        target,
        verified({ hasTrackedChanges: true, trackedChangeCount: 2 })
      )
    ).toEqual({ state: "required", typedNameTarget: "feature/x" });
  });

  it("leaves a clean, unprotected force delete at D2 with no gate", () => {
    seedWorktree();
    expect(resolveWorktreeDeleteGate(target, verified())).toEqual({ state: "none" });
  });

  it("does not escalate on untracked files alone (#4927)", () => {
    seedWorktree();
    expect(
      resolveWorktreeDeleteGate(
        target,
        verified({ untrackedFileCount: 4, hasUntrackedFiles: true })
      )
    ).toEqual({ state: "none" });
  });

  it("gates a protected branch and the main worktree even when the tree is clean", () => {
    seedWorktree({ branch: "main" });
    expect(resolveWorktreeDeleteGate(target, verified())).toEqual({
      state: "required",
      typedNameTarget: "main",
    });
    seedWorktree({ isMainWorktree: true });
    expect(resolveWorktreeDeleteGate(target, verified())).toEqual({
      state: "required",
      typedNameTarget: "feature/x",
    });
  });

  it("gates on modified files inside submodules the parent status cannot express", () => {
    seedWorktree();
    expect(
      resolveWorktreeDeleteGate(
        target,
        verified({
          submodules: {
            status: "verified",
            risk: emptySubmoduleRisk({ dirtyFiles: ["vendor/lib/src/main.c"] }),
          },
        })
      )
    ).toEqual({ state: "required", typedNameTarget: "feature/x" });
  });

  it("falls back to the worktree name on a detached HEAD, and on an EMPTY branch (#7493)", () => {
    // `??` would keep the empty string, which ConfirmDialog reads as "no gate"
    // and approves with zero keystrokes — the exact bug that shipped before.
    seedWorktree({ branch: undefined });
    expect(resolveWorktreeDeleteGate(target, verified({ hasTrackedChanges: true }))).toEqual({
      state: "required",
      typedNameTarget: "feature-x",
    });
    seedWorktree({ branch: "" });
    expect(resolveWorktreeDeleteGate(target, verified({ hasTrackedChanges: true }))).toEqual({
      state: "required",
      typedNameTarget: "feature-x",
    });
  });

  it("refuses rather than gating on an empty string when nothing names the worktree", () => {
    seedWorktree({ branch: "", name: "" });
    expect(resolveWorktreeDeleteGate(target, verified({ hasTrackedChanges: true }))).toEqual({
      state: "unresolvable",
    });
  });

  it("refuses a force delete whose worktree this view cannot see", () => {
    // The protected-branch and main-worktree inputs live on that record, so the
    // tier is unknowable — neither "no gate" nor a gate we can put up.
    expect(resolveWorktreeDeleteGate(target, verified())).toEqual({ state: "unresolvable" });
  });

  it("fails closed and gates when the fresh status fetch could not be read", () => {
    seedWorktree();
    expect(resolveWorktreeDeleteGate(target, { state: "failed", submodules: null })).toEqual({
      state: "required",
      typedNameTarget: "feature/x",
    });
  });

  it("never gates a delete the host will refuse outright", () => {
    // Blocked is not a tier: `guardSubmoduleDelete` throws on at-risk commits
    // before it reads `force`, so a typed-name gate here asks for the most
    // emphatic consent in the app and then hands back a toast.
    seedWorktree();
    expect(
      resolveWorktreeDeleteGate(
        target,
        verified({
          hasTrackedChanges: true,
          submodules: {
            status: "verified",
            risk: emptySubmoduleRisk({
              atRiskCommits: [{ oid: "a1b2c3d4e5f6", subject: "Vendored fix" }],
            }),
          },
        })
      )
    ).toEqual({ state: "none" });
  });

  it("does not gate an already-removed worktree on submodule content nobody can lose", () => {
    seedWorktree();
    expect(resolveWorktreeDeleteGate(target, { state: "gone" })).toEqual({ state: "none" });
  });
});

describe("worktreeDeleteGateRefusal (#12115)", () => {
  it("lets a dispatch through when the fresh re-check needs no gate", () => {
    expect(worktreeDeleteGateRefusal({ state: "none" }, undefined)).toBeUndefined();
  });

  it("lets a dispatch through when the approver typed the name the re-check still wants", () => {
    expect(
      worktreeDeleteGateRefusal({ state: "required", typedNameTarget: "feature/x" }, "feature/x")
    ).toBeUndefined();
  });

  it("lets a downgraded dispatch through — consent stronger than required is still consent", () => {
    expect(worktreeDeleteGateRefusal({ state: "none" }, "feature/x")).toBeUndefined();
  });

  it("refuses when the worktree turned dirty behind a gate that was never shown", () => {
    const refusal = worktreeDeleteGateRefusal(
      { state: "required", typedNameTarget: "feature/x" },
      undefined
    );
    expect(refusal?.ok).toBe(false);
    expect(refusal?.ok === false && refusal.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(refusal?.ok === false && refusal.error.message).toContain("feature/x");
  });

  it("refuses when the attestation target moved under the approval", () => {
    // Typing the old branch name does not attest to the renamed worktree.
    const refusal = worktreeDeleteGateRefusal(
      { state: "required", typedNameTarget: "feature/renamed" },
      "feature/x"
    );
    expect(refusal?.ok === false && refusal.error.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("refuses when the re-check can no longer resolve the worktree at all", () => {
    const refusal = worktreeDeleteGateRefusal({ state: "unresolvable" }, "feature/x");
    expect(refusal?.ok === false && refusal.error.code).toBe("CONFIRMATION_REQUIRED");
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
      buildMcpConfirmPreview({ kind: "worktreeDelete", worktreeId: "wt-1", force: false })
    ).resolves.toEqual({ lines: [] });
    expect(mocks.buildPreview).toHaveBeenCalledWith("wt-1");
  });

  it("surfaces the fresh changed-file list for worktree.delete", async () => {
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 1,
      untrackedFileCount: 0,
      hasTrackedChanges: true,
      hasUntrackedFiles: false,
      changes: [{ path: "src/app.ts", status: "modified", insertions: null, deletions: null }],
      submodules: { status: "verified", risk: emptySubmoduleRisk() },
    });
    const { lines } = await buildMcpConfirmPreview({
      kind: "worktreeDelete",
      worktreeId: "wt-1",
      force: false,
    });
    expect(lines[0]).toContain("1 uncommitted tracked file");
    expect(lines).toContain("  M src/app.ts");
  });

  it("shows the nested submodule paths and at-risk commits an agent would destroy", async () => {
    // This surface has no typed-name gate to fall back on, so a preview that
    // listed only what the parent's status can see would leave the approver
    // consenting to work they were never shown.
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      submodules: {
        status: "verified",
        risk: emptySubmoduleRisk({
          dirtyFiles: ["vendor/lib/src/main.c"],
          atRiskCommits: [{ oid: "a1b2c3d4e5f6", subject: "Fix the vendored parser" }],
        }),
      },
    });
    const { lines } = await buildMcpConfirmPreview({
      kind: "worktreeDelete",
      worktreeId: "wt-1",
      force: false,
    });
    expect(lines[0]).toBe("No uncommitted changes in the worktree itself.");
    expect(lines).toContain("  M vendor/lib/src/main.c");
    expect(lines).toContain("  a1b2c3d Fix the vendored parser");
    expect(hasCautionLine(lines)).toBe(true);
  });

  it("says the submodule inventory could not be finished rather than staying silent", async () => {
    mocks.buildPreview.mockResolvedValue({
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
      submodules: { status: "unverified", risk: null },
    });
    const { lines } = await buildMcpConfirmPreview({
      kind: "worktreeDelete",
      worktreeId: "wt-1",
      force: false,
    });
    expect(lines.some((l) => l.includes("Could not finish checking"))).toBe(true);
    expect(hasCautionLine(lines)).toBe(true);
  });

  it("fails closed with a couldn't-verify note when the fresh fetch throws", async () => {
    mocks.buildPreview.mockRejectedValue(new Error("timeout"));
    const { lines } = await buildMcpConfirmPreview({
      kind: "worktreeDelete",
      worktreeId: "wt-1",
      force: false,
    });
    expect(lines).toEqual(["⚠ Could not verify current changes — proceed with caution."]);
  });

  it("surfaces the branch and actual commits for a git.push target", async () => {
    mocks.buildGitPreview.mockResolvedValue({
      branch: "feature/x",
      destination: { remote: "origin", branch: "feature/x" },
      pullSource: { remote: "origin", branch: "feature/x" },
      commits: [{ hash: "abcdef1234", message: "Fix the thing", author: "Ada" }],
    });
    const { lines } = await buildMcpConfirmPreview({ kind: "gitPush", cwd: "/repo" });
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
    expect(empty.lines).toEqual([
      "Rebases onto: origin/main",
      "Branch: main",
      "No local commits to replay.",
    ]);

    mocks.buildGitPreview.mockRejectedValue(new Error("git exploded"));
    const failed = await buildMcpConfirmPreview({ kind: "gitPush", cwd: "/repo" });
    expect(failed.lines[0]).toContain("Could not verify");
  });
});

describe("batch terminal kill targets (#12123)", () => {
  it("resolves an explicit id list into a checklist target", () => {
    expect(
      resolveMcpConfirmPreviewTarget("terminal.killBatch", { terminalIds: ["a", "b"] }, undefined)
    ).toEqual({ kind: "terminalKillBatch", terminalIds: ["a", "b"] });
  });

  it("resolves no target for a malformed id list rather than repairing it", () => {
    for (const args of [
      undefined,
      {},
      { terminalIds: [] },
      { terminalIds: "a" },
      { terminalIds: ["a", 3] },
      { terminalIds: ["a", ""] },
      // Rejected on exactly the terms the action's own schema rejects them:
      // duplicates would give two rows one checkbox identity, and an over-cap
      // list would raise a dialog the dispatch then refuses.
      { terminalIds: ["a", "a"] },
      { terminalIds: Array.from({ length: MAX_KILL_BATCH_TERMINALS + 1 }, (_, i) => `t${i}`) },
    ]) {
      expect(resolveMcpConfirmPreviewTarget("terminal.killBatch", args, undefined)).toBeUndefined();
    }
  });

  it("resolves a list sitting exactly on the cap", () => {
    const terminalIds = Array.from({ length: MAX_KILL_BATCH_TERMINALS }, (_, i) => `t${i}`);
    expect(
      resolveMcpConfirmPreviewTarget("terminal.killBatch", { terminalIds }, undefined)
    ).toEqual({ kind: "terminalKillBatch", terminalIds });
  });

  it("builds a row per requested id, naming worktree, kind and running agent", () => {
    mocks.worktrees.set("wt-1", { branch: "feature/x", name: "x" });
    mocks.panelsById = {
      p1: {
        id: "p1",
        title: "claude · api",
        worktreeId: "wt-1",
        detectedAgentId: "claude",
        agentState: "working",
      },
      p2: { id: "p2", title: "zsh", kind: "terminal" },
    };

    expect(buildTerminalKillBatchTargets(["p1", "p2", "gone"])).toEqual([
      {
        id: "p1",
        name: "claude · api",
        worktree: "feature/x",
        kindLabel: "Claude",
        agentRunning: true,
      },
      { id: "p2", name: "zsh", kindLabel: "Terminal", agentRunning: false },
      { id: "gone", name: "gone", kindLabel: "No longer open", agentRunning: false },
    ]);
  });

  it("does not resolve a requested id off Object.prototype", () => {
    mocks.panelsById = {};
    expect(buildTerminalKillBatchTargets(["constructor"])).toEqual([
      {
        id: "constructor",
        name: "constructor",
        kindLabel: "No longer open",
        agentRunning: false,
      },
    ]);
  });

  it("survives a view with no worktree store mounted", () => {
    mocks.viewStoreThrows = true;
    mocks.panelsById = { p1: { id: "p1", title: "zsh", worktreeId: "wt-1" } };

    const [row] = buildTerminalKillBatchTargets(["p1"]);
    expect(row?.worktree).toBeUndefined();
    expect(row?.name).toBe("zsh");
  });
});

describe("forge write previews (#12118)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getContext.mockReturnValue({ activeWorktreePath: "/repo/active" });
  });

  it("resolves forge.createIssue content alongside the worktree it files into", () => {
    expect(
      resolveMcpConfirmPreviewTarget(
        "forge.createIssue",
        { title: "Crash", body: "steps", labels: ["bug", "p1"] },
        undefined
      )
    ).toEqual({
      kind: "forgeCreateIssue",
      worktreePath: "/repo/active",
      title: "Crash",
      body: "steps",
      labels: ["bug", "p1"],
    });
  });

  it("resolves forge.addIssueComment content the same way", () => {
    expect(
      resolveMcpConfirmPreviewTarget(
        "forge.addIssueComment",
        { issueNumber: 42, body: "still broken" },
        undefined
      )
    ).toEqual({
      kind: "forgeAddIssueComment",
      worktreePath: "/repo/active",
      issueNumber: 42,
      body: "still broken",
    });
  });

  it("prefers an explicitly named worktree over the active one", () => {
    expect(
      resolveMcpConfirmPreviewTarget(
        "forge.createIssue",
        { cwd: "/repo/named", title: "Crash", body: undefined, labels: undefined },
        undefined
      )
    ).toEqual({
      kind: "forgeCreateIssue",
      worktreePath: "/repo/named",
      title: "Crash",
      body: undefined,
      labels: undefined,
    });
  });

  // Both halves must land or there is no preview. A card naming a repository
  // with no content — or content with no repository — is only half of what the
  // approver is being asked to consent to, and neither may be repaired with a
  // default (#7880).
  it.each([
    ["a missing title", { body: "b" }],
    ["an empty title", { title: "" }],
    ["a non-string title", { title: 7 }],
    ["a non-string body", { title: "t", body: 7 }],
    ["a non-array labels", { title: "t", labels: "bug" }],
    ["a non-string label", { title: "t", labels: ["bug", 3] }],
  ])("refuses to preview forge.createIssue with %s", (_label, args) => {
    expect(resolveMcpConfirmPreviewTarget("forge.createIssue", args, undefined)).toBeUndefined();
  });

  it.each([
    ["a missing issue number", { body: "b" }],
    ["a zero issue number", { issueNumber: 0, body: "b" }],
    ["a fractional issue number", { issueNumber: 1.5, body: "b" }],
    ["a missing body", { issueNumber: 1 }],
    ["an empty body", { issueNumber: 1, body: "" }],
  ])("refuses to preview forge.addIssueComment with %s", (_label, args) => {
    expect(
      resolveMcpConfirmPreviewTarget("forge.addIssueComment", args, undefined)
    ).toBeUndefined();
  });

  // An unresolvable repository leaves `worktreePath` undefined rather than
  // killing the preview. Dropping the card would hand the approver the redacted
  // argument summary for the one action whose content is the point, and an id
  // missing from the index at modal-open can be present when `run()`
  // re-resolves it — publishing on an approval that never saw the text. The
  // formatter states the unknown target as a caution instead, and nothing is
  // pinned. Critically it is still never SUBSTITUTED with the active worktree.
  it("previews the content but no worktree when the named selector is unusable", () => {
    expect(
      resolveMcpConfirmPreviewTarget("forge.createIssue", { cwd: "", title: "t" }, undefined)
    ).toEqual({
      kind: "forgeCreateIssue",
      worktreePath: undefined,
      title: "t",
      body: undefined,
      labels: undefined,
    });
  });

  it("previews the content but no worktree when none resolves at all", () => {
    mocks.getContext.mockReturnValue({});
    expect(resolveMcpConfirmPreviewTarget("forge.createIssue", { title: "t" }, undefined)).toEqual({
      kind: "forgeCreateIssue",
      worktreePath: undefined,
      title: "t",
      body: undefined,
      labels: undefined,
    });
  });

  it("builds the issue preview synchronously, with no fetch", async () => {
    const { lines } = await buildMcpConfirmPreview({
      kind: "forgeCreateIssue",
      worktreePath: "/repo/active",
      title: "Crash on startup",
      body: "line one\nline two",
      labels: ["bug"],
    });
    expect(lines[0]).toBe("Worktree: /repo/active");
    expect(lines.join("\n")).toContain("line two");
    expect(mocks.buildGitPreview).not.toHaveBeenCalled();
    expect(mocks.buildPreview).not.toHaveBeenCalled();
  });

  it("offers a spawning recipe's full terminal count, and nothing for a non-spawning one", async () => {
    const { useRecipeStore } = await import("@/store/recipeStore");
    useRecipeStore.setState({
      recipes: [
        {
          id: "recipe-1",
          name: "Fleet",
          projectId: "p1",
          terminals: [
            { type: "terminal", command: "a" },
            { type: "terminal", command: "b" },
          ],
          createdAt: 1,
        },
      ],
    });

    const spawning = await buildMcpConfirmPreview({
      kind: "recipe",
      recipeId: "recipe-1",
      resolvedRecipeId: "recipe-1",
      spawns: true,
    });
    expect(spawning.approvedRecipeRun).toEqual({ recipeId: "recipe-1", terminalCount: 2 });

    // recipe.delete / recipe.saveToRepo are gated and preview the same content,
    // but start nothing — there is no spawn for an approval to authorize.
    const naming = await buildMcpConfirmPreview({
      kind: "recipe",
      recipeId: "recipe-1",
      resolvedRecipeId: "recipe-1",
      spawns: false,
    });
    expect(naming.approvedRecipeRun).toBeUndefined();

    const missing = await buildMcpConfirmPreview({
      kind: "recipe",
      recipeId: "gone",
      resolvedRecipeId: "gone",
      spawns: true,
    });
    expect(missing.approvedRecipeRun).toBeUndefined();
    useRecipeStore.getState().reset();
  });

  it("builds the comment preview synchronously, with no fetch", async () => {
    const { lines } = await buildMcpConfirmPreview({
      kind: "forgeAddIssueComment",
      worktreePath: "/repo/active",
      issueNumber: 9,
      body: "still broken",
    });
    expect(lines).toContain("Issue: #9");
    expect(lines.join("\n")).toContain("still broken");
    expect(mocks.buildGitPreview).not.toHaveBeenCalled();
  });
});
