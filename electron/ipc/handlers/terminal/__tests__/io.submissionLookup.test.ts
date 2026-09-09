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
      "term-a": { status: "found", record: { token: "tok-1", phase: "pty_written", at: 7 } },
    });
    expect(getTerminalAsync).toHaveBeenCalledWith("term-a", "tok-1");
  });

  it("never routes an RPC for a terminal owned by another project", async () => {
    const result = await getSubmissions(SENDER_A, ["term-b"], "tok-1");

    // `unreadable`, and identical to what an id this host never heard of gets:
    // the reply shape must not tell a caller which foreign ids exist. The
    // lookup must also never reach that terminal's shard.
    expect(result).toEqual({ "term-b": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("serves an unbound window its own projectless terminal", async () => {
    // Null is an identity, not a wildcard — the same rule the ingest-port gate
    // follows. A project-picker window must still be able to confirm a
    // submission it made.
    getProjectForWebContentsMock.mockReturnValue(null);

    await expect(getSubmissions(SENDER_A, ["term-unowned"], "tok-1")).resolves.toEqual({
      "term-unowned": { status: "found", record: { token: "tok-1", phase: "pty_written", at: 7 } },
    });
  });

  it("reports a read terminal holding no record as absent, not unreadable", async () => {
    getTerminalAsync.mockResolvedValue({ id: "term-a", submission: undefined });

    await expect(getSubmissions(SENDER_A, ["term-a"], "tok-1")).resolves.toEqual({
      "term-a": { status: "absent" },
    });
  });

  it("reports a terminal whose read failed as unreadable, never as absent", async () => {
    // `getTerminalAsync` folds an RPC failure into null. Calling that "no such
    // submission" would be a claim made on the strength of a query that failed,
    // and one bad shard must not cost the caller the rest of the batch either.
    getTerminalAsync.mockResolvedValue(null);

    await expect(getSubmissions(SENDER_A, ["term-a"], "tok-1")).resolves.toEqual({
      "term-a": { status: "unreadable" },
    });
  });

  it("tells the three outcomes apart within one batch", async () => {
    getTerminalProjectId.mockReturnValue("project-a");
    getTerminalAsync.mockImplementation(async (id: string, token?: string) => {
      if (id === "term-gone") return null;
      if (id === "term-empty") return { id, submission: undefined };
      return { id, submission: { token, phase: "pty_written", at: 7 } };
    });

    await expect(
      getSubmissions(SENDER_A, ["term-a", "term-empty", "term-gone"], "tok-1")
    ).resolves.toEqual({
      "term-a": { status: "found", record: { token: "tok-1", phase: "pty_written", at: 7 } },
      "term-empty": { status: "absent" },
      "term-gone": { status: "unreadable" },
    });
  });

  it("gives an unknown id the same answer a foreign one gets", async () => {
    // Both are `unreadable` and neither is routed, so the reply cannot be used
    // to probe which terminals exist outside the caller's project.
    const foreign = await getSubmissions(SENDER_A, ["term-b"], "tok-1");
    // Only the RPC spy is reset — `vi.clearAllMocks()` would also wipe the
    // `ipcMain.handle` call record the helper resolves the handler through.
    getTerminalAsync.mockClear();
    const unknown = await getSubmissions(SENDER_A, ["term-never-existed"], "tok-1");

    expect(foreign).toEqual({ "term-b": { status: "unreadable" } });
    expect(unknown).toEqual({ "term-never-existed": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("refuses a project-bound sender a projectless terminal", async () => {
    // Null is an identity in both directions: it matches null, and nothing else.
    const result = await getSubmissions(SENDER_A, ["term-unowned"], "tok-1");

    expect(result).toEqual({ "term-unowned": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("refuses an unbound sender a project-owned terminal", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);

    const result = await getSubmissions(SENDER_A, ["term-a"], "tok-1");

    expect(result).toEqual({ "term-a": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("serves each project its own terminal in the same session", async () => {
    const [a, b] = await Promise.all([
      getSubmissions(SENDER_A, ["term-a", "term-b"], "tok-1"),
      getSubmissions(SENDER_B, ["term-a", "term-b"], "tok-2"),
    ]);

    expect(a).toEqual({
      "term-a": { status: "found", record: { token: "tok-1", phase: "pty_written", at: 7 } },
      "term-b": { status: "unreadable" },
    });
    expect(b).toEqual({
      "term-a": { status: "unreadable" },
      "term-b": { status: "found", record: { token: "tok-2", phase: "pty_written", at: 7 } },
    });
  });

  it("deduplicates repeated ids into one RPC", async () => {
    await getSubmissions(SENDER_A, ["term-a", "term-a", "term-a"], "tok-1");

    expect(getTerminalAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", ""],
    ["missing", undefined],
    ["non-string", 42],
    ["over the length bound", "x".repeat(129)],
  ])("rejects a %s token as VALIDATION without reading anything", async (_label, token) => {
    // The preload is reachable without the action's own schema, so these bounds
    // have to hold here too rather than only on the MCP surface.
    await expect(getSubmissions(SENDER_A, ["term-a"], token)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("accepts a token exactly at the length bound", async () => {
    const token = "x".repeat(128);
    await expect(getSubmissions(SENDER_A, ["term-a"], token)).resolves.toEqual({
      "term-a": { status: "found", record: { token, phase: "pty_written", at: 7 } },
    });
  });

  it("rejects a non-array id list", async () => {
    await expect(getSubmissions(SENDER_A, "term-a", "tok-1")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("rejects an oversized id list instead of silently dropping the tail", async () => {
    // Truncating would answer `unreadable` for ids the caller asked about and
    // give it no way to learn that its request was clipped.
    const ids = Array.from({ length: 257 }, (_, i) => `term-${i}`);
    getTerminalProjectId.mockReturnValue("project-a");

    await expect(getSubmissions(SENDER_A, ids, "tok-1")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("serves a list right at the bound", async () => {
    const ids = Array.from({ length: 256 }, (_, i) => `term-${i}`);
    getTerminalProjectId.mockReturnValue("project-a");

    await getSubmissions(SENDER_A, ids, "tok-1");

    expect(getTerminalAsync).toHaveBeenCalledTimes(256);
  });
});
