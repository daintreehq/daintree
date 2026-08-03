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

/** Sender A's view is bound to project A; sender B's to project B. */
const VIEW_TO_PROJECT = new Map([
  [SENDER_A, "project-a"],
  [SENDER_B, "project-b"],
]);

type ReconnectResult = { exists: boolean; id?: string; hasPty?: boolean; cwd?: string };

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

const TERMINALS = new Map([
  ["t-a", makeTerminal("t-a", "project-a")],
  ["t-a2", makeTerminal("t-a2", "project-a")],
  ["t-b", makeTerminal("t-b", "project-b")],
  ["t-unowned", makeTerminal("t-unowned", null)],
  ["t-scratch", makeTerminal("t-scratch", "scratch-1")],
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

/** A bound sender, the ordinary post-startup case. */
function boundEvent(id: number) {
  return makeEvent(id, "app://index.html").event;
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

    await expect(reconnect(boundEvent(SENDER_A), "t-a")).resolves.toMatchObject({
      exists: true,
      id: "t-a",
      hasPty: true,
    });
  });

  it("refuses a terminal owned by another project, leaking no metadata", async () => {
    register();

    const result = await reconnect(boundEvent(SENDER_A), "t-b");

    expect(result).toEqual({ exists: false });
    expect(result.cwd).toBeUndefined();
  });

  it("serves each project its own terminal in the same session", async () => {
    register();

    const [a, b] = await Promise.all([
      reconnect(boundEvent(SENDER_A), "t-a"),
      reconnect(boundEvent(SENDER_B), "t-b"),
    ]);

    expect(a).toMatchObject({ exists: true, id: "t-a" });
    expect(b).toMatchObject({ exists: true, id: "t-b" });
  });

  // Null is an identity, not a wildcard — all three asymmetries below matter.
  it("serves an unbound sender its own projectless terminal", async () => {
    register();

    await expect(reconnect(boundEvent(999), "t-unowned")).resolves.toMatchObject({
      exists: true,
      id: "t-unowned",
    });
  });

  it("refuses an unbound sender a project-owned terminal", async () => {
    register();

    await expect(reconnect(boundEvent(999), "t-a")).resolves.toEqual({ exists: false });
  });

  it("refuses a project-bound sender an unowned terminal", async () => {
    register();

    await expect(reconnect(boundEvent(SENDER_A), "t-unowned")).resolves.toEqual({ exists: false });
  });

  it("reconnects a scratch workspace's own terminal", async () => {
    getProjectForWebContentsMock.mockReturnValue("scratch-1");
    register();

    await expect(reconnect(boundEvent(SENDER_A), "t-scratch")).resolves.toMatchObject({
      exists: true,
      id: "t-scratch",
    });
  });

  it("still reports a missing terminal as not found", async () => {
    register();

    await expect(reconnect(boundEvent(SENDER_A), "gone")).resolves.toEqual({ exists: false });
  });

  it("tolerates a sender with no getURL", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);
    register();

    await expect(reconnect({ sender: { id: 1 } }, "t-unowned")).resolves.toMatchObject({
      exists: true,
    });
  });
});

describe("terminal:reconnect — cold-boot startup URL fallback", () => {
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

    await expect(reconnect(event, "t-b")).resolves.toEqual({ exists: false });
  });

  it("lets the registry binding win over a stale URL", async () => {
    register();

    // Registry says project-a; the query string disagrees. The binding is
    // authoritative, so project-b's terminal stays refused.
    const { event } = makeEvent(SENDER_A, "app://index.html?projectId=project-b");

    await expect(reconnect(event, "t-b")).resolves.toEqual({ exists: false });
    await expect(reconnect(event, "t-a")).resolves.toMatchObject({ exists: true });
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
  it("returns a per-id map matching the single reconnect contract", async () => {
    register();

    const result = await reconnectBulk(boundEvent(SENDER_A), ["t-a", "t-dead"]);

    expect(result["t-a"]).toMatchObject({ exists: true, id: "t-a", hasPty: true });
    expect(result["t-dead"]).toEqual({ exists: false });
  });

  it("refuses only the foreign ids in a mixed batch", async () => {
    register();

    const result = await reconnectBulk(boundEvent(SENDER_A), ["t-a", "t-b", "t-unowned", "gone"]);

    expect(result["t-a"]).toMatchObject({ exists: true });
    expect(result["t-b"]).toEqual({ exists: false });
    expect(result["t-unowned"]).toEqual({ exists: false });
    expect(result["gone"]).toEqual({ exists: false });
  });

  it("applies one snapshotted identity to every id in the batch", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);
    register();

    const { event, setUrl } = makeEvent(SENDER_A, "app://index.html?projectId=project-a");
    const inFlight = reconnectBulk(event, ["t-a", "t-a2"]);
    setUrl("app://index.html?projectId=project-b");

    const result = await inFlight;

    expect(result["t-a"]).toMatchObject({ exists: true });
    expect(result["t-a2"]).toMatchObject({ exists: true });
  });

  it("deduplicates ids before probing", async () => {
    const ptyClient = register();

    const result = await reconnectBulk(boundEvent(SENDER_A), ["t-a", "t-a", "t-a2"]);

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

    const result = await reconnectBulk(boundEvent(SENDER_A), ["t-a", "t-fail"]);

    expect(result["t-a"]).toMatchObject({ exists: true });
    expect(result["t-fail"]).toEqual({ exists: false });
  });

  it("reports help terminals as { exists: false }, mirroring single reconnect", async () => {
    mockIsHelpTerminal.mockImplementation((id: string) => id === "t-a2");
    register();

    const result = await reconnectBulk(boundEvent(SENDER_A), ["t-a2", "t-a"]);

    expect(result["t-a2"]).toEqual({ exists: false });
    expect(result["t-a"]).toMatchObject({ exists: true });
  });

  it("rejects invalid payloads", async () => {
    register();
    const event = boundEvent(SENDER_A);

    await expect(reconnectBulk(event, null)).rejects.toThrow(
      "Invalid terminal IDs: must be an array"
    );
    await expect(reconnectBulk(event, [""])).rejects.toThrow(
      "Invalid terminal ID in batch payload"
    );
    await expect(reconnectBulk(event, new Array(257).fill("id"))).rejects.toThrow(
      "Invalid terminal IDs: maximum 256 IDs allowed"
    );
  });

  it("returns an empty map for an empty id list", async () => {
    const ptyClient = register();

    await expect(reconnectBulk(boundEvent(SENDER_A), [])).resolves.toEqual({});
    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalled();
  });
});
