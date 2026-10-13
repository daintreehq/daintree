/**
 * #11652: `terminal:reconnect` resolved a terminal by id alone. Terminal ids are
 * globally unique, so any project could reattach to any other project's running
 * terminal — and the result carries the live `projectId`/`cwd`, which the
 * renderer trusts over its own saved snapshot, so a foreign id in saved state
 * (#11651) was silently adopted.
 *
 * The gate resolves the sender's workspace from the sender itself. `ctx.projectId`
 * is authoritative once the view is bound, but reconnect runs during cold-boot
 * hydration, when the startup-restore renderer may still be unbound — there the
 * `?projectId=` query string on its URL is the only sender-local identity.
 *
 * A refusal is `{ exists: false, conflict: true }`: no metadata, but distinct
 * from "not found" so restore mints a fresh id instead of respawning onto the
 * still-live foreign one.
 *
 * These specs drive the real `defineIpcNamespace` → `typedHandleWithContext`
 * chain so the context is built by production code, not by the fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
  webContents: { fromId: vi.fn(() => null) },
}));

const getWindowForWebContentsMock = vi.hoisted(() =>
  vi.fn<(wc: { id: number }) => unknown>(() => null)
);
const getProjectForWebContentsMock = vi.hoisted(() =>
  vi.fn<(id: number) => string | null>(() => null)
);

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowForWebContentsMock,
  getProjectForWebContents: getProjectForWebContentsMock,
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => true),
  isCachedViewWebContents: vi.fn(() => false),
}));

const mockIsHelpTerminal = vi.hoisted(() => vi.fn((_id: string) => false));

vi.mock("../../../../services/AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({
    isHelpTerminal: mockIsHelpTerminal,
  }),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { registerTerminalSnapshotHandlers } from "../snapshots.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";
import { getIpcDispatcher } from "../../../dispatcher.js";
import type { ClientEndpoint, ClientRef } from "../../../endpoint.js";
import type { SerializedTerminalSnapshot } from "../../../../../shared/types/terminal.js";

const SENDER_A = 101;
const SENDER_B = 202;
/** A webContents id deliberately absent from the registry — an unbound window. */
const UNBOUND_SENDER = 999;

/** Sender A's view is bound to project A; sender B's to project B. */
const VIEW_TO_PROJECT = new Map([
  [SENDER_A, "project-a"],
  [SENDER_B, "project-b"],
]);

/** What a refused (live, but foreign) terminal must look like on the wire. */
const REFUSED = { exists: false, conflict: true };
/** What a genuinely absent terminal must look like — no conflict flag. */
const NOT_FOUND = { exists: false };

type ReconnectResult = { exists: boolean; conflict?: boolean; id?: string; cwd?: string };

function makeTerminal(id: string, projectId: string | null = "project-a") {
  return {
    id,
    projectId,
    kind: "terminal",
    cwd: `/tmp/${projectId ?? "unowned"}`,
    spawnedAt: 1,
    hasPty: true,
  };
}

/**
 * `t-absent` omits `projectId` entirely. The production wire shape is
 * `projectId?: string`, so an unowned terminal reaches this handler as
 * `undefined`, not `null` — both must normalize to the same identity.
 */
const { projectId: _omitted, ...terminalWithNoProjectField } = makeTerminal("t-absent", null);

const TERMINALS = new Map<string, Record<string, unknown>>([
  ["t-a", makeTerminal("t-a", "project-a")],
  ["t-a2", makeTerminal("t-a2", "project-a")],
  ["t-b", makeTerminal("t-b", "project-b")],
  ["t-unowned", makeTerminal("t-unowned", null)],
  ["t-absent", terminalWithNoProjectField],
  ["t-scratch", makeTerminal("t-scratch", "scratch-1")],
  // Carries the live PTY grid the pty-host mapper reports (#11718).
  ["t-sized", { ...makeTerminal("t-sized", "project-a"), ptyCols: 203, ptyRows: 51 }],
  // Carries backend worktree attribution, which the mapper began reporting in
  // #12078 and this projection must keep stripping (#5176).
  [
    "t-worktreed",
    { ...makeTerminal("t-worktreed", "project-a"), worktreeId: "/repo/.worktrees/backend" },
  ],
  // The assistant's overlay PTY, recognised from its spawn-time record stamp
  // rather than the renderer's mark (#12183).
  ["t-assistant", { ...makeTerminal("t-assistant", "project-a"), isAssistantTerminal: true }],
]);

/** An invoke event whose URL can be mutated mid-flight, to prove identity is snapshotted. */
function makeEvent(id: number, url?: string) {
  const state = { url };
  const event = {
    sender: {
      id,
      ...(url === undefined ? {} : { getURL: () => state.url as string }),
    },
  };
  return { event, setUrl: (next: string) => (state.url = next) };
}

/**
 * An ordinary post-startup event: a plain URL with no `?projectId=`, so identity
 * comes from the registry alone.
 */
function senderEvent(id: number) {
  return makeEvent(id, "app://index.html").event;
}

function defaultPtyClient() {
  return {
    getTerminalAsync: vi.fn(async (id: string) => TERMINALS.get(id) ?? null),
  };
}

function register(ptyClient: unknown = defaultPtyClient()) {
  registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
  return ptyClient as ReturnType<typeof defaultPtyClient>;
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`handler for ${channel} was never registered`);
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

function reconnect(event: unknown, terminalId: string): Promise<ReconnectResult> {
  return getHandler(CHANNELS.TERMINAL_RECONNECT)(event, terminalId) as Promise<ReconnectResult>;
}

function reconnectBulk(
  event: unknown,
  terminalIds: unknown
): Promise<Record<string, ReconnectResult>> {
  return getHandler(CHANNELS.TERMINAL_RECONNECT_BULK)(event, terminalIds) as Promise<
    Record<string, ReconnectResult>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetIpcGuardForTesting();
  markIpcSecurityReady();
  mockIsHelpTerminal.mockReturnValue(false);
  getProjectForWebContentsMock.mockImplementation((id) => VIEW_TO_PROJECT.get(id) ?? null);
  getWindowForWebContentsMock.mockReturnValue(null);
});

describe("terminal:reconnect — assistant overlay", () => {
  it("refuses a stamped assistant terminal the renderer has not marked", async () => {
    // Reconnect is hydration's fallback for panes `getForProject` missed, so
    // reading only the renderer's mark let a cold-boot bulk restore adopt the
    // assistant as a grid pane before that mark landed.
    mockIsHelpTerminal.mockReturnValue(false);
    register();

    await expect(reconnect(senderEvent(SENDER_A), "t-assistant")).resolves.toMatchObject({
      exists: false,
    });
  });
});

describe("terminal:reconnect — workspace ownership", () => {
  it("reconnects a terminal the sender's own project owns", async () => {
    register();

    await expect(reconnect(senderEvent(SENDER_A), "t-a")).resolves.toMatchObject({
      exists: true,
      id: "t-a",
      hasPty: true,
    });
  });

  it("refuses a terminal owned by another project, leaking no metadata", async () => {
    register();

    // toStrictEqual, not toEqual: toEqual ignores own properties whose value is
    // undefined, so a leak of `cwd: undefined` would slip through.
    await expect(reconnect(senderEvent(SENDER_A), "t-b")).resolves.toStrictEqual(REFUSED);
  });

  it("forwards the live PTY grid so restore can build the xterm on it (#11718)", async () => {
    // Main relays these two fields and nothing else asserts it, so dropping them
    // leaves the pty-host mapper and the hydration precedence both green while
    // the reconnect-fallback path silently restores panes at 80×24.
    register();

    const result = (await reconnect(senderEvent(SENDER_A), "t-sized")) as ReconnectResult & {
      ptyCols?: number;
      ptyRows?: number;
    };
    expect(result.ptyCols).toBe(203);
    expect(result.ptyRows).toBe(51);
  });

  it("strips backend worktree attribution, which is renderer-owned (#5176)", async () => {
    // The pty-host mapper only began reporting worktreeId in #12078, so this
    // projection had never actually seen a populated value — a refactor to a
    // spread would now hand restore a placement authority that must stay the
    // renderer's saved state alone.
    register();

    const result = await reconnect(senderEvent(SENDER_A), "t-worktreed");

    expect(result).not.toHaveProperty("worktreeId");
  });

  it("serves each project its own terminal in the same session", async () => {
    register();

    const [a, b] = await Promise.all([
      reconnect(senderEvent(SENDER_A), "t-a"),
      reconnect(senderEvent(SENDER_B), "t-b"),
    ]);

    expect(a).toMatchObject({ exists: true, id: "t-a" });
    expect(b).toMatchObject({ exists: true, id: "t-b" });
  });

  // Null is an identity, not a wildcard — all three asymmetries below matter.
  it("serves an unbound sender its own projectless terminal", async () => {
    register();

    await expect(reconnect(senderEvent(UNBOUND_SENDER), "t-unowned")).resolves.toMatchObject({
      exists: true,
      id: "t-unowned",
    });
  });

  it("treats an absent projectId the same as an explicit null", async () => {
    register();

    await expect(reconnect(senderEvent(UNBOUND_SENDER), "t-absent")).resolves.toMatchObject({
      exists: true,
      id: "t-absent",
    });
    await expect(reconnect(senderEvent(SENDER_A), "t-absent")).resolves.toStrictEqual(REFUSED);
  });

  it("refuses an unbound sender a project-owned terminal", async () => {
    register();

    await expect(reconnect(senderEvent(UNBOUND_SENDER), "t-a")).resolves.toStrictEqual(REFUSED);
  });

  it("refuses a project-bound sender an unowned terminal", async () => {
    register();

    await expect(reconnect(senderEvent(SENDER_A), "t-unowned")).resolves.toStrictEqual(REFUSED);
  });

  it("reconnects a scratch workspace's own terminal", async () => {
    getProjectForWebContentsMock.mockReturnValue("scratch-1");
    register();

    await expect(reconnect(senderEvent(SENDER_A), "t-scratch")).resolves.toMatchObject({
      exists: true,
      id: "t-scratch",
    });
  });

  it("reports a missing terminal as not found, with no conflict flag", async () => {
    register();

    // The distinction is load-bearing: only a plain not-found lets restore reuse
    // the saved id.
    await expect(reconnect(senderEvent(SENDER_A), "gone")).resolves.toStrictEqual(NOT_FOUND);
  });

  it("reports a help terminal as not found, not as a conflict", async () => {
    mockIsHelpTerminal.mockImplementation((id: string) => id === "t-a");
    register();

    await expect(reconnect(senderEvent(SENDER_A), "t-a")).resolves.toStrictEqual(NOT_FOUND);
  });
});

describe("terminal:reconnect — sender identity resolution", () => {
  // The startup-restore renderer hydrates before `registerInitialView` binds it,
  // so the registry answers null while its URL still names the project. Without
  // the fallback every restored terminal would be refused and respawned.
  it("reconnects via ?projectId= while the view is still unbound", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);
    register();

    const { event } = makeEvent(SENDER_A, "app://index.html?projectId=project-a");

    await expect(reconnect(event, "t-a")).resolves.toMatchObject({ exists: true, id: "t-a" });
  });

  it("still refuses a foreign terminal when identity came from the URL", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);
    register();

    const { event } = makeEvent(SENDER_A, "app://index.html?projectId=project-a");

    await expect(reconnect(event, "t-b")).resolves.toStrictEqual(REFUSED);
  });

  it("lets the registry binding win over a stale URL", async () => {
    register();

    // Registry says project-a; the query string disagrees. The binding is
    // authoritative, so project-b's terminal stays refused.
    const { event } = makeEvent(SENDER_A, "app://index.html?projectId=project-b");

    await expect(reconnect(event, "t-b")).resolves.toStrictEqual(REFUSED);
    await expect(reconnect(event, "t-a")).resolves.toMatchObject({ exists: true });
  });

  it("falls back to no identity when the sender has no getURL", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);
    register();

    await expect(reconnect({ sender: { id: 1 } }, "t-unowned")).resolves.toMatchObject({
      exists: true,
    });
  });

  it("falls back to no identity when getURL throws", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);
    register();

    const event = {
      sender: {
        id: SENDER_A,
        getURL: () => {
          throw new Error("webContents destroyed");
        },
      },
    };

    await expect(reconnect(event, "t-unowned")).resolves.toMatchObject({ exists: true });
    await expect(reconnect(event, "t-a")).resolves.toStrictEqual(REFUSED);
  });

  it("falls back to no identity when the URL is malformed", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);
    register();

    const { event } = makeEvent(SENDER_A, "not-a-valid-url");

    await expect(reconnect(event, "t-unowned")).resolves.toMatchObject({ exists: true });
    await expect(reconnect(event, "t-a")).resolves.toStrictEqual(REFUSED);
  });

  it("snapshots the sender's identity before the PTY lookup resolves", async () => {
    let release!: (terminal: unknown) => void;
    const pending = new Promise<unknown>((resolve) => (release = resolve));
    getProjectForWebContentsMock.mockReturnValue(null);
    register({ getTerminalAsync: vi.fn(() => pending) });

    const { event, setUrl } = makeEvent(SENDER_A, "app://index.html?projectId=project-a");
    const inFlight = reconnect(event, "t-a");

    // The sender navigates while the lookup is outstanding. Re-reading identity
    // after the await would flip this decision to a refusal.
    setUrl("app://index.html?projectId=project-b");
    release(TERMINALS.get("t-a"));

    await expect(inFlight).resolves.toMatchObject({ exists: true, id: "t-a" });
  });
});

describe("terminal:reconnect-bulk handler", () => {
  it("returns per-id results identical to the single reconnect contract", async () => {
    register();
    const event = senderEvent(SENDER_A);

    const [single, bulk] = await Promise.all([
      reconnect(event, "t-a"),
      reconnectBulk(event, ["t-a"]),
    ]);

    // Full equality, so bulk can't quietly drop live metadata the single path returns.
    expect(bulk["t-a"]).toStrictEqual(single);
  });

  it("refuses only the foreign ids in a mixed batch", async () => {
    register();

    const result = await reconnectBulk(senderEvent(SENDER_A), ["t-a", "t-b", "t-unowned", "gone"]);

    expect(result["t-a"]).toMatchObject({ exists: true });
    expect(result["t-b"]).toStrictEqual(REFUSED);
    expect(result["t-unowned"]).toStrictEqual(REFUSED);
    expect(result["gone"]).toStrictEqual(NOT_FOUND);
  });

  it("resolves the sender's identity once for the whole batch", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);
    register();

    // Identity read once → both ids judged as project-a. A per-id resolver would
    // see project-b on the second read and refuse t-a2.
    let reads = 0;
    const event = {
      sender: {
        id: SENDER_A,
        getURL: () =>
          ++reads === 1
            ? "app://index.html?projectId=project-a"
            : "app://index.html?projectId=project-b",
      },
    };

    const result = await reconnectBulk(event, ["t-a", "t-a2"]);

    expect(result["t-a"]).toMatchObject({ exists: true, id: "t-a" });
    expect(result["t-a2"]).toMatchObject({ exists: true, id: "t-a2" });
  });

  it("deduplicates ids before probing", async () => {
    const ptyClient = register();

    const result = await reconnectBulk(senderEvent(SENDER_A), ["t-a", "t-a", "t-a2"]);

    expect(Object.keys(result).sort()).toEqual(["t-a", "t-a2"]);
    expect(ptyClient.getTerminalAsync).toHaveBeenCalledTimes(2);
  });

  it("degrades a failing id to { exists: false } without failing the batch", async () => {
    register({
      getTerminalAsync: vi.fn(async (id: string) => {
        if (id === "t-fail") throw new Error("boom");
        return TERMINALS.get(id) ?? null;
      }),
    });

    const result = await reconnectBulk(senderEvent(SENDER_A), ["t-a", "t-fail"]);

    expect(result["t-a"]).toMatchObject({ exists: true });
    expect(result["t-fail"]).toStrictEqual(NOT_FOUND);
  });

  it("reports help terminals as { exists: false }, mirroring single reconnect", async () => {
    mockIsHelpTerminal.mockImplementation((id: string) => id === "t-a2");
    register();

    const result = await reconnectBulk(senderEvent(SENDER_A), ["t-a2", "t-a"]);

    expect(result["t-a2"]).toStrictEqual(NOT_FOUND);
    expect(result["t-a"]).toMatchObject({ exists: true });
  });

  it("accepts a full batch at the 256-id cap and rejects one more", async () => {
    register();
    const event = senderEvent(SENDER_A);
    const ids = Array.from({ length: 256 }, (_, i) => `t-${i}`);

    await expect(reconnectBulk(event, ids)).resolves.toHaveProperty("t-255");
    await expect(reconnectBulk(event, [...ids, "t-256"])).rejects.toThrow(
      "Invalid terminal IDs: maximum 256 IDs allowed"
    );
  });

  it("rejects invalid payloads", async () => {
    register();
    const event = senderEvent(SENDER_A);

    await expect(reconnectBulk(event, null)).rejects.toThrow(
      "Invalid terminal IDs: must be an array"
    );
    await expect(reconnectBulk(event, [""])).rejects.toThrow(
      "Invalid terminal ID in batch payload"
    );
  });

  it("returns an empty map for an empty id list", async () => {
    const ptyClient = register();

    await expect(reconnectBulk(senderEvent(SENDER_A), [])).resolves.toEqual({});
    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalled();
  });
});

describe("terminal:get-for-project handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes dev-preview PTYs from getForProject results", async () => {
    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-visible", "t-dev-preview"]),
      getTerminalAsync: vi.fn(async (id: string) => {
        if (id === "t-visible") {
          return {
            id,
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            spawnedAt: Date.now(),
          };
        }
        if (id === "t-dev-preview") {
          return {
            id,
            kind: "dev-preview",
            type: "terminal",
            cwd: "/tmp",
            spawnedAt: Date.now(),
          };
        }
        return null;
      }),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const getForProjectCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT);
    expect(getForProjectCall).toBeTruthy();

    const handler = getForProjectCall?.[1] as unknown as (
      event: unknown,
      projectId: string
    ) => Promise<unknown[]>;

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-1");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe("t-visible");
    expect(ptyClient.getTerminalsForProjectAsync).toHaveBeenCalledWith("project-1");
    expect(ptyClient.getTerminalAsync).toHaveBeenCalledTimes(2);
  });

  it("passes through trash metadata when present", async () => {
    const now = Date.now();
    const expiresAt = now + 120000;

    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-active", "t-will-expire"]),
      getTerminalAsync: vi.fn(async (id: string) => {
        if (id === "t-active") {
          return {
            id,
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            spawnedAt: now,
            isTrashed: false,
          };
        }
        if (id === "t-will-expire") {
          return {
            id,
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            spawnedAt: now,
            isTrashed: false,
            trashExpiresAt: expiresAt,
          };
        }
        return null;
      }),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const getForProjectCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT);
    expect(getForProjectCall).toBeTruthy();

    const handler = getForProjectCall?.[1] as unknown as (
      event: unknown,
      projectId: string
    ) => Promise<unknown[]>;

    const result = (await handler(
      { senderFrame: { url: "http://localhost:5173" } },
      "project-1"
    )) as Array<{ id: string }>;

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    const active = result.find((t: { id: string }) => t.id === "t-active") as {
      id: string;
      isTrashed?: boolean;
      trashExpiresAt?: number;
    };
    const willExpire = result.find((t: { id: string }) => t.id === "t-will-expire") as {
      id: string;
      isTrashed?: boolean;
      trashExpiresAt?: number;
    };

    expect(active.isTrashed).toBe(false);
    expect(active.trashExpiresAt).toBeUndefined();

    expect(willExpire.isTrashed).toBe(false);
    expect(willExpire.trashExpiresAt).toBe(expiresAt);
  });

  it("excludes help-marked terminals from getForProject results", async () => {
    mockIsHelpTerminal.mockImplementation((id: string) => id === "t-help");

    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-visible", "t-help", "t-dev-preview"]),
      getTerminalAsync: vi.fn(async (id: string) => ({
        id,
        kind: id === "t-dev-preview" ? "dev-preview" : "agent",
        type: "terminal",
        cwd: "/tmp",
        spawnedAt: Date.now(),
      })),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const getForProjectCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT);
    expect(getForProjectCall).toBeTruthy();

    const handler = getForProjectCall?.[1] as unknown as (
      event: unknown,
      projectId: string
    ) => Promise<unknown[]>;

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-1");

    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe("t-visible");

    mockIsHelpTerminal.mockImplementation(() => false);
  });

  it("forwards the live PTY grid so restore can build the xterm on it (#11718)", async () => {
    // Main is a pure relay here, and dropping these two fields is invisible:
    // the pty-host mapper still reports them and hydration still prefers them,
    // so every other suite stays green while the fix goes inert and restored
    // panes silently fall back to 80×24.
    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-sized", "t-unknown"]),
      getTerminalAsync: vi.fn(async (id: string) => ({
        id,
        kind: "terminal",
        type: "terminal",
        cwd: "/tmp",
        spawnedAt: Date.now(),
        ...(id === "t-sized" ? { ptyCols: 203, ptyRows: 51 } : {}),
      })),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const handler = calls.find(
      (c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT
    )?.[1] as unknown as (
      event: unknown,
      projectId: string
    ) => Promise<{ id: string; ptyCols?: number; ptyRows?: number }[]>;

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-1");

    const sized = result.find((t) => t.id === "t-sized");
    expect(sized?.ptyCols).toBe(203);
    expect(sized?.ptyRows).toBe(51);
    // A host that reports no grid must stay "unknown" rather than acquire one.
    const unknown = result.find((t) => t.id === "t-unknown");
    expect(unknown?.ptyCols).toBeUndefined();
  });

  it("strips backend worktree attribution, which is renderer-owned (#5176)", async () => {
    // Hydration's primary path. The pty-host mapper only began reporting
    // worktreeId in #12078, so this projection had never seen a populated
    // value — a refactor to a spread would now let the backend win a placement
    // decision that belongs to the renderer's saved layout state alone.
    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-worktreed"]),
      getTerminalAsync: vi.fn(async (id: string) => ({
        id,
        kind: "terminal",
        type: "terminal",
        cwd: "/repo/.worktrees/backend",
        spawnedAt: Date.now(),
        worktreeId: "/repo/.worktrees/backend",
      })),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const handler = calls.find(
      (c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT
    )?.[1] as unknown as (event: unknown, projectId: string) => Promise<unknown[]>;

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-1");

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("worktreeId");
  });
});

describe("terminal:get-serialized-states handler", () => {
  function snapshot(data: string): SerializedTerminalSnapshot {
    return { data, cols: 80, rows: 24 };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function getHandler(): (
    event: unknown,
    terminalIds: string[]
  ) => Promise<Record<string, SerializedTerminalSnapshot | null>> {
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const handlerCall = calls.find((call) => call[0] === CHANNELS.TERMINAL_GET_SERIALIZED_STATES);
    expect(handlerCall).toBeTruthy();
    return handlerCall?.[1] as (
      event: unknown,
      terminalIds: string[]
    ) => Promise<Record<string, SerializedTerminalSnapshot | null>>;
  }

  it("returns serialized state map for unique terminal IDs", async () => {
    const ptyClient = {
      getSerializedStateAsync: vi.fn(async (terminalId: string) => {
        if (terminalId === "t-1") return snapshot("state-1");
        if (terminalId === "t-2") return null;
        return snapshot("unknown");
      }),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    const result = await handler({}, ["t-1", "t-1", "t-2"]);

    // The batch must forward the capture grid per entry, not just the payload:
    // it is what each replay sizes itself to (#11552).
    expect(result).toEqual({
      "t-1": snapshot("state-1"),
      "t-2": null,
    });
    expect(ptyClient.getSerializedStateAsync).toHaveBeenCalledTimes(2);
  });

  it("returns null for terminals that fail to serialize without failing whole batch", async () => {
    const ptyClient = {
      getSerializedStateAsync: vi.fn(async (terminalId: string) => {
        if (terminalId === "t-fail") {
          throw new Error("boom");
        }
        return snapshot("ok");
      }),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    const result = await handler({}, ["t-ok", "t-fail"]);

    expect(result).toEqual({
      "t-ok": snapshot("ok"),
      "t-fail": null,
    });
  });

  it("rejects invalid payloads", async () => {
    const ptyClient = {
      getSerializedStateAsync: vi.fn(async () => snapshot("state")),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    await expect(handler({}, null as unknown as string[])).rejects.toThrow(
      "Invalid terminal IDs: must be an array"
    );
    await expect(handler({}, ["" as unknown as string])).rejects.toThrow(
      "Invalid terminal ID in batch payload"
    );
    await expect(handler({}, new Array(257).fill("id"))).rejects.toThrow(
      "Invalid terminal IDs: maximum 256 IDs allowed"
    );
  });
});

describe("terminal pool inspection handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("terminal:get-available handler", () => {
    it("excludes dev-preview PTYs from available results", async () => {
      const ptyClient = {
        getAvailableTerminalsAsync: vi.fn(async () => [
          {
            id: "t-idle",
            kind: "terminal",
            type: "claude",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
          {
            id: "t-dev-preview",
            kind: "dev-preview",
            type: "terminal",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAvailableCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_AVAILABLE);
      const handler = getAvailableCall?.[1] as unknown as () => Promise<unknown[]>;

      const result = await handler();

      expect(result).toHaveLength(1);
      expect((result[0] as { id: string }).id).toBe("t-idle");
    });
  });

  describe("terminal:get-by-state handler", () => {
    it("returns terminals filtered by state", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => [
          {
            id: "t-working-1",
            kind: "terminal",
            type: "claude",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
          {
            id: "t-working-2",
            kind: "terminal",
            type: "codex",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      expect(getByStateCall).toBeTruthy();

      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      const result = await handler({}, "working");

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(ptyClient.getTerminalsByStateAsync).toHaveBeenCalledWith("working");
    });

    it("excludes dev-preview PTYs from state results", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => [
          {
            id: "t-working",
            kind: "terminal",
            type: "claude",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
          {
            id: "t-dev-preview",
            kind: "dev-preview",
            type: "terminal",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      const result = await handler({}, "working");

      expect(result).toHaveLength(1);
      expect((result[0] as { id: string }).id).toBe("t-working");
    });

    it("throws error for empty state parameter", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => []),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      await expect(handler({}, "")).rejects.toThrow("Invalid state");
      expect(ptyClient.getTerminalsByStateAsync).not.toHaveBeenCalled();
    });

    it("throws error for invalid state value", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => []),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      await expect(handler({}, "invalid")).rejects.toThrow(
        "Failed to get terminals by state: Invalid state: must be one of idle, working, waiting, directing, completed, exited"
      );
      expect(ptyClient.getTerminalsByStateAsync).not.toHaveBeenCalled();
    });

    it("includes all metadata fields for returned terminals", async () => {
      const now = Date.now();
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => [
          {
            id: "t-full",
            projectId: "proj-1",
            kind: "terminal",
            launchAgentId: "claude",
            title: "Claude Agent",
            cwd: "/tmp",
            worktreeId: "wt-1",
            agentState: "working",
            lastStateChange: now - 1000,
            spawnedAt: now,
            isTrashed: false,
            trashExpiresAt: undefined,
            activityTier: "active",
            hasPty: true,
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      const result = (await handler({}, "working")) as Array<{
        id: string;
        projectId?: string;
        worktreeId?: string;
        launchAgentId?: string;
        lastStateChange?: number;
        activityTier?: string;
        hasPty?: boolean;
      }>;

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t-full");
      expect(result[0].projectId).toBe("proj-1");
      expect(result[0].worktreeId).toBe("wt-1");
      expect(result[0].launchAgentId).toBe("claude");
      expect(result[0].lastStateChange).toBe(now - 1000);
      expect(result[0].activityTier).toBe("active");
      expect(result[0].hasPty).toBe(true);
    });
  });

  describe("terminal:get-all handler", () => {
    it("excludes dev-preview PTYs from all results", async () => {
      const ptyClient = {
        getAllTerminalsAsync: vi.fn(async () => [
          {
            id: "t-terminal",
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
          {
            id: "t-dev-preview",
            kind: "dev-preview",
            type: "terminal",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAllCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_ALL);
      const handler = getAllCall?.[1] as unknown as () => Promise<unknown[]>;

      const result = await handler();

      expect(result).toHaveLength(1);
      expect((result[0] as { id: string }).id).toBe("t-terminal");
    });

    it("includes hasPty and activityTier fields", async () => {
      const ptyClient = {
        getAllTerminalsAsync: vi.fn(async () => [
          {
            id: "t-active",
            kind: "terminal",
            type: "claude",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
            activityTier: "active",
            hasPty: true,
          },
          {
            id: "t-background",
            kind: "terminal",
            type: "codex",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
            activityTier: "background",
            hasPty: false,
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAllCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_ALL);
      const handler = getAllCall?.[1] as unknown as () => Promise<
        Array<{ activityTier?: string; hasPty?: boolean }>
      >;

      const result = await handler();

      expect(result).toHaveLength(2);
      expect(result[0].activityTier).toBe("active");
      expect(result[0].hasPty).toBe(true);
      expect(result[1].activityTier).toBe("background");
      expect(result[1].hasPty).toBe(false);
    });
  });
});

describe("terminal:search-semantic-buffers", () => {
  const matches = [
    { terminalId: "mine", line: "token here", matchStart: 0, matchEnd: 5 },
    { terminalId: "theirs", line: "token there", matchStart: 0, matchEnd: 5 },
    { terminalId: "nobodys", line: "token", matchStart: 0, matchEnd: 5 },
  ];
  const owners: Record<string, string | null> = { mine: "proj-1", theirs: "proj-2", nobodys: null };

  function remoteView(projectId: string | null): ClientEndpoint {
    return {
      endpointId: "remote:s:v",
      clientId: "shell",
      projectId,
      kind: "remote-view",
      handle: -3,
      send: vi.fn(),
      request: vi.fn(),
      onClose: () => ({ dispose: () => undefined }),
      isClosed: () => false,
    } as unknown as ClientEndpoint;
  }
  const client: ClientRef = {
    clientId: "shell",
    clientName: "s",
    platform: "darwin",
    kind: "remote",
  };

  const ptyClient = {
    searchSemanticBuffersAsync: vi.fn(async () => matches),
    getTerminalProjectId: (id: string) => owners[id] ?? null,
  };
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    dispose = registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    // The plain envelope, as security setup installs it for real.
    getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, run) => {
      try {
        return { ok: true, data: await run() } as never;
      } catch (error) {
        return { ok: false, error } as never;
      }
    });
  });

  afterEach(() => {
    dispose?.();
    getIpcDispatcher().setInvokeEnveloper(null);
  });

  it("finds only the remote view's own project's terminals", async () => {
    const envelope = await getIpcDispatcher().invokeForEndpoint(
      { endpoint: remoteView("proj-1"), client },
      CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS,
      ["token", false]
    );
    if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
    expect(envelope.data).toEqual([matches[0]]);
    const none = await getIpcDispatcher().invokeForEndpoint(
      { endpoint: remoteView(null), client },
      CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS,
      ["token", false]
    );
    expect(none.ok && none.data).toEqual([]);
  });

  it("finds every terminal for this machine's own window", async () => {
    const call = (
      ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }
    ).mock.calls.find((c) => c[0] === CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS);
    const handler = call?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
    const result = await handler(
      { sender: { id: 7 }, senderFrame: { url: "app://daintree" } },
      "token",
      false
    );
    const data =
      (result as { ok?: boolean; data?: unknown }).ok !== undefined
        ? (result as { data: unknown }).data
        : result;
    expect(data).toEqual(matches);
  });
});
