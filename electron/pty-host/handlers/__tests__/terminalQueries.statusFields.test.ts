import { describe, it, expect, vi } from "vitest";
import { createTerminalQueryHandlers } from "../terminalQueries.js";
import type { HostContext } from "../types.js";
import type { PtyHostTerminalStatusFields } from "../../../../shared/types/pty-host.js";

interface FakeRecord {
  id: string;
  projectId?: string;
  lastOutputChangeAt?: number;
  lastTypedInputAt?: number;
}

/**
 * Live records whose native grid getters are counted: the status projection
 * must answer without reading them, however many terminals it covers.
 */
function setup(records: FakeRecord[], submissions: Record<string, Record<string, unknown>> = {}) {
  const geometryReads = { count: 0 };
  const lookups: string[] = [];
  const byId = new Map(
    records.map((record) => [
      record.id,
      {
        ...record,
        wasKilled: false,
        isExited: false,
        ptyProcess: {
          get cols() {
            geometryReads.count++;
            return 120;
          },
          get rows() {
            geometryReads.count++;
            return 40;
          },
        },
      },
    ])
  );
  const getSubmission = vi.fn((id: string, token: string) => submissions[id]?.[token]);
  const sendEvent = vi.fn();
  // Everything the full record mapper also reads, so a regression to it fails
  // on the geometry count rather than on a missing stub.
  const ctx = {
    sendEvent,
    getPauseCoordinator: () => undefined,
    ptyManager: {
      getTerminal: (id: string) => {
        lookups.push(id);
        return byId.get(id);
      },
      getSubmission,
      isInTrash: () => false,
      getTrashExpiresAt: () => undefined,
      isClosing: () => false,
      getActivityTier: () => "active",
      hasPendingSubmission: () => false,
      analysisObservedSince: () => undefined,
    },
  } as unknown as HostContext;
  const handler = createTerminalQueryHandlers(ctx)["get-terminal-status-fields"];
  const query = (ids: unknown, submissionToken?: unknown) => {
    sendEvent.mockClear();
    handler?.({ type: "get-terminal-status-fields", requestId: "r1", ids, submissionToken });
    expect(sendEvent).toHaveBeenCalledTimes(1);
    const [[event]] = sendEvent.mock.calls;
    expect(event).toMatchObject({ type: "terminal-status-fields", requestId: "r1" });
    return (event as { terminals: PtyHostTerminalStatusFields[] }).terminals;
  };
  return { query, geometryReads, lookups, getSubmission };
}

describe("get-terminal-status-fields (#17809)", () => {
  it("answers a large selection in one event without reading any terminal's grid", () => {
    const records = Array.from({ length: 256 }, (_, i) => ({
      id: `t${i}`,
      projectId: "project-a",
      lastOutputChangeAt: 1_000 + i,
    }));
    const { query, geometryReads } = setup(records);

    const terminals = query(records.map((r) => r.id));

    expect(terminals).toHaveLength(256);
    expect(terminals[255]).toMatchObject({ id: "t255", lastOutputChangeAt: 1_255 });
    expect(geometryReads.count).toBe(0);
  });

  it("projects the two timestamps and the record's own owner, and nothing else", () => {
    const { query } = setup([
      { id: "t1", projectId: "project-a", lastOutputChangeAt: 5_000, lastTypedInputAt: 7_000 },
    ]);

    const [entry] = query(["t1"]);

    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "id",
      "lastOutputChangeAt",
      "lastTypedInputAt",
      "projectId",
    ]);
    expect(entry).toEqual({
      id: "t1",
      projectId: "project-a",
      lastOutputChangeAt: 5_000,
      lastTypedInputAt: 7_000,
    });
  });

  it("leaves out an id the shard holds no record for, so it can't read as observed", () => {
    const { query } = setup([{ id: "t1", projectId: "project-a" }]);

    expect(query(["t1", "t-gone"]).map((t) => t.id)).toEqual(["t1"]);
  });

  it("reads a repeated id once", () => {
    const { query, lookups } = setup([{ id: "t1", projectId: "project-a" }]);

    expect(query(["t1", "t1", "t1"])).toHaveLength(1);
    expect(lookups).toEqual(["t1"]);
  });

  it("resolves the named token per terminal, telling a held record from none", () => {
    const record = { token: "tok-1", phase: "pty_written", at: 7 };
    const { query, getSubmission, geometryReads } = setup(
      [
        { id: "t1", projectId: "project-a" },
        { id: "t2", projectId: "project-a" },
      ],
      { t1: { "tok-1": record } }
    );

    const terminals = query(["t1", "t2"], "tok-1");

    expect(geometryReads.count).toBe(0);
    expect(terminals).toEqual([
      expect.objectContaining({ id: "t1", submission: record }),
      expect.objectContaining({ id: "t2", submission: undefined }),
    ]);
    expect(getSubmission.mock.calls).toEqual([
      ["t1", "tok-1"],
      ["t2", "tok-1"],
    ]);
  });

  it("never consults submissions when no token is named", () => {
    const { query, getSubmission } = setup([{ id: "t1", projectId: "project-a" }]);

    const [entry] = query(["t1"]);

    expect(entry).not.toHaveProperty("submission");
    expect(getSubmission).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-array id list", "t1"],
    ["a missing id list", undefined],
  ])("answers %s with nothing instead of throwing", (_label, ids) => {
    const { query } = setup([{ id: "t1", projectId: "project-a" }]);

    expect(query(ids)).toEqual([]);
  });

  it("skips non-string ids and keeps the rest", () => {
    const { query, lookups } = setup([{ id: "t1", projectId: "project-a" }]);

    expect(query([42, null, "t1", { id: "t1" }]).map((t) => t.id)).toEqual(["t1"]);
    expect(lookups).toEqual(["t1"]);
  });

  it("ignores a token that isn't a string", () => {
    const { query, getSubmission } = setup([{ id: "t1", projectId: "project-a" }]);

    const [entry] = query(["t1"], 42);

    expect(entry).not.toHaveProperty("submission");
    expect(getSubmission).not.toHaveBeenCalled();
  });
});
