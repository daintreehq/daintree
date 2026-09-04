import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

// Mock the modules registerAgentActions imports so the registry builds in a node
// test env; only the bookmark actions' collaborators (panel store, window.electron)
// carry behavior for these tests.
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const currentViewStoreMock = vi.hoisted(() => ({ getCurrentViewStore: vi.fn() }));
const worktreeSelectionMock = vi.hoisted(() => ({
  useWorktreeSelectionStore: { getState: vi.fn(() => ({ activeWorktreeId: null })) },
}));
const agentRegistryMock = vi.hoisted(() => ({
  AGENT_REGISTRY: { claude: { name: "Claude" } },
  getAgentDisplayTitle: vi.fn((id: string) => `Title:${id}`),
}));
const clientsMock = vi.hoisted(() => ({
  agentSettingsClient: { get: vi.fn() },
  cliAvailabilityClient: { get: vi.fn() },
  agentCapabilitiesClient: { getRegistry: vi.fn() },
  userAgentRegistryClient: { get: vi.fn() },
}));
const agentSettingsStoreMock = vi.hoisted(() => ({ useAgentSettingsStore: { getState: vi.fn() } }));
const cliAvailabilityStoreMock = vi.hoisted(() => ({
  useCliAvailabilityStore: { getState: vi.fn() },
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/worktreeStore", () => worktreeSelectionMock);
vi.mock("@/store/agentSettingsStore", () => agentSettingsStoreMock);
vi.mock("@/store/cliAvailabilityStore", () => cliAvailabilityStoreMock);
vi.mock("@/config/agents", () => agentRegistryMock);
vi.mock("@/clients/userAgentRegistryClient", () => ({
  userAgentRegistryClient: clientsMock.userAgentRegistryClient,
}));
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    agentSettingsClient: clientsMock.agentSettingsClient,
    cliAvailabilityClient: clientsMock.cliAvailabilityClient,
    agentCapabilitiesClient: clientsMock.agentCapabilitiesClient,
  };
});

import { registerAgentActions } from "../agentActions";
import { resolveEffectiveActionDanger } from "../../effectiveDanger";

const agentSessionHistoryMock = {
  list: vi.fn(),
  prepareBookmark: vi.fn(),
  promoteBookmark: vi.fn(),
  renameBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  listBookmarks: vi.fn(),
};

function setupActions(): ActionRegistry {
  const actions: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bookmark actions don't touch callbacks; a bare stub is enough to build the registry
  registerAgentActions(actions, {} as ActionCallbacks);
  return actions;
}

function callAction(
  actions: ActionRegistry,
  id: string,
  args?: unknown,
  ctx: Partial<ActionContext> = {}
): Promise<unknown> {
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  const def = factory() as AnyActionDefinition;
  return def.run(args, ctx as ActionContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { electron: { agentSessionHistory: agentSessionHistoryMock } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A record that actually satisfies the service's AgentSessionRecord contract —
// `{ sessionId }` alone would make the projection emit the required keys as
// undefined, which `toEqual` hides.
const VALID_RECORD = {
  sessionId: "s1",
  agentId: "claude",
  worktreeId: "wt-1",
  title: "T",
  projectId: "p",
  savedAt: 5,
  bookmark: { bookmarkedAt: 9, label: "L" },
};

describe("session bookmark actions", () => {
  it("bookmarkAndClose captures the pane's metadata, then removes the pane without a second kill", async () => {
    const record = {
      sessionId: "s1",
      agentId: "claude",
      bookmark: { bookmarkedAt: 1, label: "L" },
    };
    agentSessionHistoryMock.prepareBookmark.mockResolvedValue({ record });
    const removePanel = vi.fn();
    panelStoreMock.getState.mockReturnValue({
      getTerminal: vi.fn(() => ({
        id: "term-1",
        kind: "terminal",
        location: "grid",
        titleMode: "user",
        agentPresetId: "preset-1",
        agentPresetColor: "#abc",
        originalPresetId: "preset-0",
        isUsingFallback: true,
        fallbackChainIndex: 2,
        isInputLocked: false,
      })),
      removePanel,
    });

    const actions = setupActions();
    const result = await callAction(actions, "session.bookmarkAndClose", {
      terminalId: "term-1",
      label: "L",
    });

    expect(agentSessionHistoryMock.prepareBookmark).toHaveBeenCalledWith({
      terminalId: "term-1",
      label: "L",
      metadata: {
        sourcePanelId: "term-1",
        sourceLocation: "grid",
        titleMode: "user",
        agentPresetId: "preset-1",
        agentPresetColor: "#abc",
        originalPresetId: "preset-0",
        isUsingFallback: true,
        fallbackChainIndex: 2,
        isInputLocked: false,
      },
    });
    expect(removePanel).toHaveBeenCalledWith("term-1", { backendAlreadyClosed: true });
    expect(result).toEqual({ record });
  });

  it("bookmarkAndClose rejects without invoking IPC when the target is not a local pane", async () => {
    const removePanel = vi.fn();
    panelStoreMock.getState.mockReturnValue({
      getTerminal: vi.fn(() => undefined), // stale / cross-project id
      removePanel,
    });

    const actions = setupActions();
    await expect(
      callAction(actions, "session.bookmarkAndClose", { terminalId: "ghost", label: "L" })
    ).rejects.toThrow(/No local agent pane/);
    expect(agentSessionHistoryMock.prepareBookmark).not.toHaveBeenCalled();
    expect(removePanel).not.toHaveBeenCalled();
  });

  it("bookmarkAndClose leaves the pane open when capture fails", async () => {
    agentSessionHistoryMock.prepareBookmark.mockRejectedValue(new Error("SESSION_CAPTURE_FAILED"));
    const removePanel = vi.fn();
    panelStoreMock.getState.mockReturnValue({
      getTerminal: vi.fn(() => ({ id: "term-1", kind: "terminal" })),
      removePanel,
    });

    const actions = setupActions();
    await expect(
      callAction(actions, "session.bookmarkAndClose", { terminalId: "term-1", label: "L" })
    ).rejects.toThrow(/SESSION_CAPTURE_FAILED/);
    expect(removePanel).not.toHaveBeenCalled();
  });

  it("promote and rename forward the exact sessionId and label", async () => {
    const record = { sessionId: "s1" };
    agentSessionHistoryMock.promoteBookmark.mockResolvedValue(record);
    agentSessionHistoryMock.renameBookmark.mockResolvedValue(record);
    const actions = setupActions();

    await callAction(actions, "session.bookmark.promote", { sessionId: "s1", label: "P" });
    expect(agentSessionHistoryMock.promoteBookmark).toHaveBeenCalledWith({
      sessionId: "s1",
      label: "P",
    });

    await callAction(actions, "session.bookmark.rename", { sessionId: "s1", label: "R" });
    expect(agentSessionHistoryMock.renameBookmark).toHaveBeenCalledWith({
      sessionId: "s1",
      label: "R",
    });
  });

  it("delete forwards only the sessionId", async () => {
    agentSessionHistoryMock.deleteBookmark.mockResolvedValue(undefined);
    const actions = setupActions();
    await callAction(actions, "session.bookmark.delete", { sessionId: "s1" });
    expect(agentSessionHistoryMock.deleteBookmark).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  it("list scopes to the explicit projectId, then the context project, and never leaks across projects", async () => {
    agentSessionHistoryMock.listBookmarks.mockResolvedValue([VALID_RECORD]);
    const actions = setupActions();

    // Explicit arg wins.
    await callAction(
      actions,
      "session.bookmarks.list",
      { projectId: "explicit" },
      { projectId: "ctx" }
    );
    expect(agentSessionHistoryMock.listBookmarks).toHaveBeenLastCalledWith({
      projectId: "explicit",
    });

    // Falls back to the context project.
    const wrapped = await callAction(actions, "session.bookmarks.list", undefined, {
      projectId: "ctx",
    });
    expect(agentSessionHistoryMock.listBookmarks).toHaveBeenLastCalledWith({ projectId: "ctx" });
    // Strict: the projection must not smuggle in required keys with undefined
    // values, which `toEqual` would silently ignore.
    expect(wrapped).toStrictEqual({ bookmarks: [VALID_RECORD], total: 1, hasMore: false });

    // No scope at all: returns empty WITHOUT querying — bookmarks stay project-scoped.
    agentSessionHistoryMock.listBookmarks.mockClear();
    const empty = await callAction(actions, "session.bookmarks.list", undefined, {});
    expect(empty).toEqual({ bookmarks: [], total: 0, hasMore: false });
    expect(agentSessionHistoryMock.listBookmarks).not.toHaveBeenCalled();
  });

  // A scratch view has no project, but its terminals are journaled under the
  // opaque scratch id — so it is a real scope, not "no scope".
  it("list falls back to the context scratch id when there is no project", async () => {
    agentSessionHistoryMock.listBookmarks.mockResolvedValue([VALID_RECORD]);
    const actions = setupActions();
    const result = await callAction(actions, "session.bookmarks.list", undefined, {
      scratchId: "scratch-7",
    });
    expect(agentSessionHistoryMock.listBookmarks).toHaveBeenCalledWith({ projectId: "scratch-7" });
    expect(result).toStrictEqual({ bookmarks: [VALID_RECORD], total: 1, hasMore: false });
  });

  // #11530 — bookmarks are exempt from both the retention window and the
  // per-worktree cap, so the stored set grows without bound; `limit` is the only
  // thing keeping the agent-facing payload finite.
  function bookmarkDef(): AnyActionDefinition {
    const def = setupActions().get("session.bookmarks.list")?.() as AnyActionDefinition | undefined;
    if (!def) throw new Error("session.bookmarks.list not registered");
    return def;
  }

  it("list truncates to exactly the default limit and reports the untruncated total", async () => {
    // Read the declared default off the schema instead of copying the constant.
    const { limit: defaultLimit } = bookmarkDef().argsSchema?.parse({}) as { limit: number };
    const many = Array.from({ length: defaultLimit + 2 }, (_, i) => ({
      ...VALID_RECORD,
      sessionId: `s${i}`,
      bookmark: { bookmarkedAt: i, label: `L${i}` },
    }));
    agentSessionHistoryMock.listBookmarks.mockResolvedValue(many);
    const actions = setupActions();
    const result = (await callAction(actions, "session.bookmarks.list", undefined, {
      projectId: "p",
    })) as { bookmarks: Array<{ sessionId: string }>; total: number; hasMore: boolean };
    expect(result.bookmarks.map((b) => b.sessionId)).toEqual(
      many.slice(0, defaultLimit).map((b) => b.sessionId)
    );
    expect(result.total).toBe(many.length);
    expect(result.hasMore).toBe(true);
  });

  it("list rejects an over-large limit without querying the journal", async () => {
    const actions = setupActions();
    await expect(
      callAction(actions, "session.bookmarks.list", { limit: 100_000 }, { projectId: "p" })
    ).rejects.toThrow();
    expect(agentSessionHistoryMock.listBookmarks).not.toHaveBeenCalled();
  });

  // Bookmarks never expire, so a project can hold more than the maximum limit —
  // without offset those sessionIds would be unreachable, and sessionId is the
  // only handle rename/delete accept.
  it("list pages past the limit with offset and ends with hasMore false", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...VALID_RECORD,
      sessionId: `s${i}`,
      bookmark: { bookmarkedAt: i, label: `L${i}` },
    }));
    agentSessionHistoryMock.listBookmarks.mockResolvedValue(many);
    const actions = setupActions();

    const page2 = (await callAction(
      actions,
      "session.bookmarks.list",
      { limit: 2, offset: 2 },
      { projectId: "p" }
    )) as { bookmarks: Array<{ sessionId: string }>; total: number; hasMore: boolean };
    expect(page2.bookmarks.map((b) => b.sessionId)).toEqual(["s2", "s3"]);
    expect(page2).toMatchObject({ total: 5, hasMore: true });

    const tail = (await callAction(
      actions,
      "session.bookmarks.list",
      { limit: 2, offset: 4 },
      { projectId: "p" }
    )) as { bookmarks: Array<{ sessionId: string }>; hasMore: boolean };
    expect(tail.bookmarks.map((b) => b.sessionId)).toEqual(["s4"]);
    expect(tail.hasMore).toBe(false);
  });

  it("list reports hasMore false when the result exactly fills the limit", async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      ...VALID_RECORD,
      sessionId: `s${i}`,
      bookmark: { bookmarkedAt: i, label: `L${i}` },
    }));
    agentSessionHistoryMock.listBookmarks.mockResolvedValue(many);
    const actions = setupActions();
    const exact = (await callAction(
      actions,
      "session.bookmarks.list",
      { limit: many.length },
      { projectId: "p" }
    )) as { bookmarks: unknown[]; hasMore: boolean };
    expect(exact.bookmarks).toHaveLength(many.length);
    expect(exact.hasMore).toBe(false);
  });

  it("list honours an explicit limit and keeps the newest-first order", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...VALID_RECORD,
      sessionId: `s${i}`,
      bookmark: { bookmarkedAt: i, label: `L${i}` },
    }));
    agentSessionHistoryMock.listBookmarks.mockResolvedValue(many);
    const actions = setupActions();
    const result = (await callAction(
      actions,
      "session.bookmarks.list",
      { limit: 2 },
      {
        projectId: "p",
      }
    )) as { bookmarks: Array<{ sessionId: string }>; total: number; hasMore: boolean };
    expect(result.bookmarks.map((b) => b.sessionId)).toEqual(["s0", "s1"]);
    expect(result).toMatchObject({ total: 8, hasMore: true });
  });

  it("list strips pane-presentation bookmark fields an agent cannot act on", async () => {
    const stored = {
      sessionId: "s1",
      agentId: "claude",
      worktreeId: "wt-1",
      title: "T",
      projectId: "p",
      savedAt: 5,
      bookmark: {
        bookmarkedAt: 9,
        label: "Pinned",
        sourceLocation: "dock",
        agentPresetId: "preset-a",
        originalPresetId: "preset-b",
        isInputLocked: false,
        sourcePanelId: "panel-1",
        titleMode: "user",
        agentPresetColor: "#00ff00",
        isUsingFallback: false,
        fallbackChainIndex: 1,
      },
    };
    agentSessionHistoryMock.listBookmarks.mockResolvedValue([stored]);
    const actions = setupActions();
    const result = (await callAction(actions, "session.bookmarks.list", undefined, {
      projectId: "p",
    })) as { bookmarks: Array<{ bookmark?: Record<string, unknown> }> };
    const bookmark = result.bookmarks[0]?.bookmark ?? {};
    expect(Object.keys(bookmark).sort()).toEqual([
      "agentPresetId",
      "bookmarkedAt",
      "isInputLocked",
      "label",
      "originalPresetId",
      "sourceLocation",
    ]);
    // Retained fields keep their values, and the stored record is untouched.
    expect(bookmark.label).toBe("Pinned");
    expect(bookmark.isInputLocked).toBe(false);
    expect(stored.bookmark.agentPresetColor).toBe("#00ff00");
  });

  // The action's description ends "Never errors." — dispatch parses results
  // against `resultSchema` now (#11539), and `listBookmarks` selects rows on
  // `bookmark !== undefined`, so a hand-written `"bookmark": {}` reaches the
  // projection carrying neither `bookmarkedAt` nor `label`. Dropping the row is
  // what keeps that promise true.
  it("list drops a bookmark row the advertised shape cannot carry", async () => {
    agentSessionHistoryMock.listBookmarks.mockResolvedValue([
      VALID_RECORD,
      { ...VALID_RECORD, sessionId: "s2", bookmark: {} },
      { sessionId: "s3" },
    ]);
    const actions = setupActions();
    const result = (await callAction(actions, "session.bookmarks.list", undefined, {
      projectId: "p",
    })) as { bookmarks: Array<{ sessionId: string }>; total: number; hasMore: boolean };

    expect(result.bookmarks.map((b) => b.sessionId)).toEqual(["s1"]);
    expect(result).toMatchObject({ total: 3, hasMore: false });
  });
});

/**
 * #11908 put these four on the assistant's action tier. The tier grant is only
 * half the contract — the other half is that becoming agent-reachable did not
 * relax the gate on the two that remove something the user can see.
 *
 * Asserting `danger === "confirm"` on its own would be a literal copied from the
 * definition, so these go through `resolveEffectiveActionDanger` instead: it is
 * the function BOTH enforcement sites read (`ActionService.dispatch`, which
 * rejects, and `useMcpBridge`, which decides whether the modal opens), so it is
 * what actually decides whether an assistant call is gated.
 */
describe("bookmark mutations stay gated once agent-reachable (#11908)", () => {
  function danger(id: string, args: unknown, source: "agent" | "user" = "agent") {
    const actions = setupActions();
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return resolveEffectiveActionDanger(id, def.danger, source, args);
  }

  it("gates closing a live pane and deleting a bookmark for an agent caller", () => {
    expect(danger("session.bookmarkAndClose", { terminalId: "t1", label: "x" })).toBe("confirm");
    expect(danger("session.bookmark.delete", { sessionId: "s1" })).toBe("confirm");
  });

  it("gates them for a human caller too — the tier grant is not a bypass", () => {
    expect(danger("session.bookmarkAndClose", { terminalId: "t1", label: "x" }, "user")).toBe(
      "confirm"
    );
    expect(danger("session.bookmark.delete", { sessionId: "s1" }, "user")).toBe("confirm");
  });

  it("leaves the two reversible mutations ungated, so routine edits stay cheap", () => {
    // Over-gating is its own failure: a confirm on every rename trains the user
    // to click through the ones that matter.
    expect(danger("session.bookmark.promote", { sessionId: "s1", label: "x" })).toBe("safe");
    expect(danger("session.bookmark.rename", { sessionId: "s1", label: "x" })).toBe("safe");
  });

  it("keeps both gated actions out of the palette, where a pick would skip the gate", () => {
    const actions = setupActions();
    for (const id of ["session.bookmarkAndClose", "session.bookmark.delete"]) {
      const def = actions.get(id)!() as AnyActionDefinition;
      expect(def.palette?.mode, `${id} must stay palette-hidden`).toBe("hidden");
      // A gated action with no rationale gives the confirm dialog nothing to
      // show, which the registry-wide quality gate also enforces.
      expect(def.dangerRationale, `${id} must explain why it is gated`).toBeTruthy();
    }
  });
});

/**
 * Cross-project isolation for the three id-only mutations (#11908).
 *
 * Main matches `sessionId` against the WHOLE journal, so nothing below the
 * action layer stops a promote/rename/delete aimed at another project's record.
 * Once the assistant could call these, that mattered: `session.bookmarks.list`
 * takes an explicit `projectId`, so a model can legitimately enumerate another
 * project's session ids and then hand one to a mutation.
 */
describe("bookmark mutations are project-scoped (#11908)", () => {
  const OURS = { ...VALID_RECORD, sessionId: "ours", projectId: "p1" };

  beforeEach(() => {
    agentSessionHistoryMock.list.mockResolvedValue([OURS]);
    agentSessionHistoryMock.promoteBookmark.mockResolvedValue(OURS);
    agentSessionHistoryMock.renameBookmark.mockResolvedValue(OURS);
    agentSessionHistoryMock.deleteBookmark.mockResolvedValue(undefined);
  });

  const MUTATIONS: Array<[string, Record<string, string>, keyof typeof agentSessionHistoryMock]> = [
    ["session.bookmark.promote", { sessionId: "theirs", label: "x" }, "promoteBookmark"],
    ["session.bookmark.rename", { sessionId: "theirs", label: "x" }, "renameBookmark"],
    ["session.bookmark.delete", { sessionId: "theirs" }, "deleteBookmark"],
  ];

  it.each(MUTATIONS)("%s refuses a session id from another project", async (id, args, ipc) => {
    const actions = setupActions();

    await expect(callAction(actions, id, args, { projectId: "p1" })).rejects.toThrow(
      /No session with that id in this project/i
    );
    expect(agentSessionHistoryMock[ipc]).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS)("%s scopes its check to the caller's own project", async (id, args) => {
    const actions = setupActions();

    await callAction(actions, id, { ...args, sessionId: "ours" }, { projectId: "p1" });
    // Scope comes from the dispatch context, never from an argument — an
    // argument the caller supplies is not a boundary it can be held to.
    expect(agentSessionHistoryMock.list).toHaveBeenCalledWith(undefined, "p1");
  });

  it.each(MUTATIONS)(
    "%s refuses a headless dispatch with no project in scope",
    async (id, args, ipc) => {
      const actions = setupActions();

      // Both headless sources, not just agents: a plugin dispatch during a
      // scope-less renderer state would otherwise reach the global journal.
      for (const dispatchSource of ["agent", "plugin"] as const) {
        await expect(
          callAction(actions, id, { ...args, sessionId: "ours" }, { dispatchSource })
        ).rejects.toThrow(/No project in scope/i);
      }
      expect(agentSessionHistoryMock[ipc]).not.toHaveBeenCalled();
    }
  );

  it.each(MUTATIONS)(
    "%s still works for a human surface with no project",
    async (id, args, ipc) => {
      // The guard tightens what a model can reach; it must not break the bookmark
      // UI, which was already confined to the project the user is looking at.
      const actions = setupActions();

      await callAction(actions, id, { ...args, sessionId: "ours" }, { dispatchSource: "user" });
      expect(agentSessionHistoryMock[ipc]).toHaveBeenCalled();
    }
  );
});
