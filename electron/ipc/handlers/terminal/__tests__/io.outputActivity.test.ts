/**
 * #12495: `terminal:get-output-activity` reads `lastOutputChangeAt` for the
 * renderer's `terminal.getStatus` when the caller asked for output. It carries
 * the same cross-project ownership gate as submission lookup — the routing is
 * as much of the answer as the payload is.
 *
 * Drives the real `defineIpcNamespace` → `typedHandleWithContext` chain so the
 * context is built by production code, not by the fixture.
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

const getProjectForWebContentsMock = vi.hoisted(() =>
  vi.fn<(id: number) => string | null>(() => null)
);

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: getProjectForWebContentsMock,
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => true),
  isCachedViewWebContents: vi.fn(() => false),
}));

vi.mock("../../../../window/portDistribution.js", () => ({
  distributeTerminalWorkerPortToView: vi.fn(),
  releaseTerminalWorkerPort: vi.fn(),
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalIOHandlers } from "../io.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";

const SENDER_A = 101;
const SENDER_B = 202;

const VIEW_TO_PROJECT = new Map([
  [SENDER_A, "project-a"],
  [SENDER_B, "project-b"],
]);

const TERMINAL_OWNERS = new Map<string, string | null>([
  ["term-a", "project-a"],
  ["term-b", "project-b"],
  ["term-unowned", null],
]);

const getTerminalAsync = vi.fn();
const getTerminalProjectId = vi.fn((id: string) => TERMINAL_OWNERS.get(id) ?? null);
const getTerminalsForProjectAsync = vi.fn(async (_projectId: string): Promise<string[]> => []);

function buildDeps(): HandlerDependencies {
  return {
    ptyClient: { getTerminalAsync, getTerminalProjectId, getTerminalsForProjectAsync },
    windowRegistry: { getByWindowId: () => undefined },
  } as unknown as HandlerDependencies;
}

function getOutputActivity(senderId: number, terminalIds: unknown): Promise<unknown> {
  const call = ipcMainMock.handle.mock.calls.find(
    ([channel]) => channel === CHANNELS.TERMINAL_GET_OUTPUT_ACTIVITY
  );
  if (!call) throw new Error("get-output-activity handler was never registered");
  const registered = call[1] as (...args: unknown[]) => Promise<unknown>;
  return registered({ sender: { id: senderId } }, terminalIds);
}

describe("terminal:get-output-activity (#12495)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getProjectForWebContentsMock.mockImplementation((id) => VIEW_TO_PROJECT.get(id) ?? null);
    getTerminalProjectId.mockImplementation((id: string) => TERMINAL_OWNERS.get(id) ?? null);
    getTerminalsForProjectAsync.mockResolvedValue([]);
    getTerminalAsync.mockImplementation(async (id: string) => ({
      id,
      projectId: TERMINAL_OWNERS.get(id) ?? undefined,
      lastOutputChangeAt: 5_000,
    }));
    registerTerminalIOHandlers(buildDeps());
  });

  it("reads the timestamp for a terminal the sender's own project owns", async () => {
    await expect(getOutputActivity(SENDER_A, ["term-a"])).resolves.toEqual({
      "term-a": { status: "read", lastOutputChangeAt: 5_000 },
    });
    // No token: this is a plain record read, not a submission lookup.
    expect(getTerminalAsync).toHaveBeenCalledWith("term-a");
  });

  it("reports a read terminal with no observed change as read, without a timestamp", async () => {
    getTerminalAsync.mockResolvedValue({
      id: "term-a",
      projectId: "project-a",
      lastOutputChangeAt: undefined,
    });

    const result = (await getOutputActivity(SENDER_A, ["term-a"])) as Record<string, object>;

    expect(result["term-a"]).toEqual({ status: "read" });
    expect(result["term-a"]).not.toHaveProperty("lastOutputChangeAt");
  });

  it("reports a terminal whose read failed as unreadable, never as read", async () => {
    // `getTerminalAsync` folds an RPC failure into null. A `read` with no
    // timestamp would present that failure as a screen that never changed.
    getTerminalAsync.mockResolvedValue(null);

    await expect(getOutputActivity(SENDER_A, ["term-a"])).resolves.toEqual({
      "term-a": { status: "unreadable" },
    });
  });

  it("tells the outcomes apart within one batch", async () => {
    getTerminalProjectId.mockReturnValue("project-a");
    getTerminalAsync.mockImplementation(async (id: string) => {
      if (id === "term-gone") return null;
      if (id === "term-quiet") return { id, projectId: "project-a" };
      return { id, projectId: "project-a", lastOutputChangeAt: 9 };
    });

    await expect(
      getOutputActivity(SENDER_A, ["term-a", "term-quiet", "term-gone"])
    ).resolves.toEqual({
      "term-a": { status: "read", lastOutputChangeAt: 9 },
      "term-quiet": { status: "read" },
      "term-gone": { status: "unreadable" },
    });
  });

  it("never routes an RPC for a terminal owned by another project", async () => {
    const result = await getOutputActivity(SENDER_A, ["term-b"]);

    expect(result).toEqual({ "term-b": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("reads a terminal main stopped tracking when the project's inventory still holds it", async () => {
    // An agent that exited on its own leaves its pane and pty-host record, but
    // main drops the spawn entry, so `getTerminalProjectId` answers null. Its
    // screen timestamp is still there to read.
    getTerminalProjectId.mockImplementation((id: string) =>
      id === "term-b" ? "project-b" : id === "term-a" ? "project-a" : null
    );
    getTerminalsForProjectAsync.mockResolvedValue(["term-exited", "term-b"]);
    getTerminalAsync.mockImplementation(async (id: string) => ({
      id,
      projectId: "project-a",
      lastOutputChangeAt: 5_000,
    }));

    const result = await getOutputActivity(SENDER_A, ["term-a", "term-exited", "term-b", "term-x"]);

    expect(result).toEqual({
      "term-a": { status: "read", lastOutputChangeAt: 5_000 },
      "term-exited": { status: "read", lastOutputChangeAt: 5_000 },
      // A known foreign owner is settled before the inventory is consulted,
      // whatever the inventory says.
      "term-b": { status: "unreadable" },
      "term-x": { status: "unreadable" },
    });
    expect(getTerminalsForProjectAsync).toHaveBeenCalledTimes(1);
    expect(getTerminalsForProjectAsync).toHaveBeenCalledWith("project-a");
    expect(getTerminalAsync.mock.calls.map(([id]) => id)).toEqual(["term-a", "term-exited"]);
  });

  it("never serves an unbound sender a record another project owns once main forgot its owner", async () => {
    // Main's null for an exited terminal matches an unbound sender's null
    // project; the record's own owner is what refuses it.
    getProjectForWebContentsMock.mockReturnValue(null);
    getTerminalProjectId.mockReturnValue(null);
    getTerminalAsync.mockResolvedValue({
      id: "term-exited",
      projectId: "project-a",
      lastOutputChangeAt: 5_000,
    });

    await expect(getOutputActivity(SENDER_A, ["term-exited"])).resolves.toEqual({
      "term-exited": { status: "unreadable" },
    });
  });

  it("skips the inventory when every id is already placed", async () => {
    await getOutputActivity(SENDER_A, ["term-a", "term-b"]);

    expect(getTerminalsForProjectAsync).not.toHaveBeenCalled();
  });

  it("gives an unknown id the same answer a foreign one gets", async () => {
    const foreign = await getOutputActivity(SENDER_A, ["term-b"]);
    const unknown = await getOutputActivity(SENDER_A, ["term-never-existed"]);

    expect(foreign).toEqual({ "term-b": { status: "unreadable" } });
    expect(unknown).toEqual({ "term-never-existed": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("treats a null project as an identity, not a wildcard", async () => {
    // A project-bound sender cannot read a projectless terminal…
    await expect(getOutputActivity(SENDER_A, ["term-unowned"])).resolves.toEqual({
      "term-unowned": { status: "unreadable" },
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();

    // …and an unbound window reads its own projectless terminal but not a
    // project-owned one.
    getProjectForWebContentsMock.mockReturnValue(null);
    getTerminalsForProjectAsync.mockClear();
    await expect(getOutputActivity(SENDER_A, ["term-unowned", "term-a"])).resolves.toEqual({
      "term-unowned": { status: "read", lastOutputChangeAt: 5_000 },
      "term-a": { status: "unreadable" },
    });
    expect(getTerminalAsync).toHaveBeenCalledTimes(1);
    expect(getTerminalAsync).toHaveBeenCalledWith("term-unowned");
    // An unbound sender has no project inventory to consult.
    expect(getTerminalsForProjectAsync).not.toHaveBeenCalled();
  });

  it("serves each project its own terminal in the same session", async () => {
    const [a, b] = await Promise.all([
      getOutputActivity(SENDER_A, ["term-a", "term-b"]),
      getOutputActivity(SENDER_B, ["term-a", "term-b"]),
    ]);

    expect(a).toEqual({
      "term-a": { status: "read", lastOutputChangeAt: 5_000 },
      "term-b": { status: "unreadable" },
    });
    expect(b).toEqual({
      "term-a": { status: "unreadable" },
      "term-b": { status: "read", lastOutputChangeAt: 5_000 },
    });
  });

  it("deduplicates repeated ids into one RPC", async () => {
    await getOutputActivity(SENDER_A, ["term-a", "term-a", "term-a"]);

    expect(getTerminalAsync).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-array id list", async () => {
    await expect(getOutputActivity(SENDER_A, "term-a")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("rejects an oversized id list instead of silently dropping the tail", async () => {
    const ids = Array.from({ length: 257 }, (_, i) => `term-${i}`);
    getTerminalProjectId.mockReturnValue("project-a");

    await expect(getOutputActivity(SENDER_A, ids)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("serves a list right at the bound", async () => {
    const ids = Array.from({ length: 256 }, (_, i) => `term-${i}`);
    getTerminalProjectId.mockReturnValue("project-a");

    await getOutputActivity(SENDER_A, ids);

    expect(getTerminalAsync).toHaveBeenCalledTimes(256);
  });
});
