/**
 * #12337: `terminal:get-submissions` resolves one submission token against a
 * set of terminals. It is a read on behalf of a renderer, so it carries the
 * same cross-project ownership gate the ingest port does — a window must not
 * be able to probe a terminal belonging to another project, and the routing is
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

function buildDeps(): HandlerDependencies {
  return {
    ptyClient: { getTerminalAsync, getTerminalProjectId },
    windowRegistry: { getByWindowId: () => undefined },
  } as unknown as HandlerDependencies;
}

function getSubmissions(
  senderId: number,
  terminalIds: unknown,
  submissionToken: unknown
): Promise<unknown> {
  const call = ipcMainMock.handle.mock.calls.find(
    ([channel]) => channel === CHANNELS.TERMINAL_GET_SUBMISSIONS
  );
  if (!call) throw new Error("get-submissions handler was never registered");
  const registered = call[1] as (...args: unknown[]) => Promise<unknown>;
  return registered({ sender: { id: senderId } }, terminalIds, submissionToken);
}

describe("terminal:get-submissions (#12337)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getProjectForWebContentsMock.mockImplementation((id) => VIEW_TO_PROJECT.get(id) ?? null);
    getTerminalProjectId.mockImplementation((id: string) => TERMINAL_OWNERS.get(id) ?? null);
    getTerminalAsync.mockImplementation(async (id: string, token?: string) => ({
      id,
      submission: token === undefined ? undefined : { token, phase: "pty_written", at: 7 },
    }));
    registerTerminalIOHandlers(buildDeps());
  });

  it("resolves a token for a terminal the sender's own project owns", async () => {
    await expect(getSubmissions(SENDER_A, ["term-a"], "tok-1")).resolves.toEqual({
      "term-a": { token: "tok-1", phase: "pty_written", at: 7 },
    });
    expect(getTerminalAsync).toHaveBeenCalledWith("term-a", "tok-1");
  });

  it("never routes an RPC for a terminal owned by another project", async () => {
    const result = await getSubmissions(SENDER_A, ["term-b"], "tok-1");

    // Absent from the map rather than present-and-null: a foreign id must not
    // be confirmed to exist, and the lookup must not reach its shard at all.
    expect(result).toEqual({});
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("serves an unbound window its own projectless terminal", async () => {
    // Null is an identity, not a wildcard — the same rule the ingest-port gate
    // follows. A project-picker window must still be able to confirm a
    // submission it made.
    getProjectForWebContentsMock.mockReturnValue(null);

    await expect(getSubmissions(SENDER_A, ["term-unowned"], "tok-1")).resolves.toEqual({
      "term-unowned": { token: "tok-1", phase: "pty_written", at: 7 },
    });
  });

  it("maps a terminal with no record to null rather than omitting it", async () => {
    getTerminalAsync.mockResolvedValue({ id: "term-a", submission: undefined });

    await expect(getSubmissions(SENDER_A, ["term-a"], "tok-1")).resolves.toEqual({
      "term-a": null,
    });
  });

  it("maps an unreadable terminal to null instead of failing the whole call", async () => {
    // `getTerminalAsync` folds an RPC failure into null; one bad shard must not
    // cost the caller every other answer in the batch.
    getTerminalAsync.mockResolvedValue(null);

    await expect(getSubmissions(SENDER_A, ["term-a"], "tok-1")).resolves.toEqual({
      "term-a": null,
    });
  });

  it("deduplicates repeated ids into one RPC", async () => {
    await getSubmissions(SENDER_A, ["term-a", "term-a", "term-a"], "tok-1");

    expect(getTerminalAsync).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing or empty token rather than reading anything", async () => {
    await expect(getSubmissions(SENDER_A, ["term-a"], "")).rejects.toBeTruthy();
    await expect(getSubmissions(SENDER_A, ["term-a"], undefined)).rejects.toBeTruthy();
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("rejects a non-array id list", async () => {
    await expect(getSubmissions(SENDER_A, "term-a", "tok-1")).rejects.toBeTruthy();
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("caps the id list so one call cannot fan out without bound", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `term-${i}`);
    getTerminalProjectId.mockReturnValue("project-a");

    await getSubmissions(SENDER_A, ids, "tok-1");

    expect(getTerminalAsync).toHaveBeenCalledTimes(256);
  });
});
