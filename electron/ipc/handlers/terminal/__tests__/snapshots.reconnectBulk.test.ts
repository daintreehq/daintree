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
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { CHANNELS } from "../../../channels.js";
import { registerTerminalSnapshotHandlers } from "../snapshots.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";

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
