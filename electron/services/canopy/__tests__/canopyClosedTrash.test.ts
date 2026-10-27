import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../../../../shared/types/ipc/agentSessionHistory.js";
import type { CanopyTrashEntry } from "../../../../shared/types/ipc/canopy.js";
import { CANOPY_TRASH_LIMIT } from "../../../../shared/config/trash.js";
import { CanopyClosedTrash, endedEntryOf, mergeCanopyTrash } from "../canopyClosedTrash.js";

function close(
  terminalId: string,
  closedAt: number,
  overrides: Partial<AgentSessionRecord> = {}
): AgentSessionRecord {
  return {
    sessionId: `session-${terminalId}-${closedAt}`,
    agentId: "claude",
    worktreeId: "/repo/wt",
    title: "Fix the login form",
    projectId: "project-a",
    savedAt: closedAt + 20_000,
    cwd: "/repo/wt",
    closedBy: "user",
    terminal: { id: terminalId, spawnedAt: closedAt - 60_000 },
    trash: { expiresAt: closedAt + 20_000, closedAt },
    ...overrides,
  };
}

function live(runId: string, trashedAt: number, spawnedAt = trashedAt - 60_000): CanopyTrashEntry {
  return {
    run: { runId, workspaceId: "project-a", spawnedAt, cwd: "/repo/wt", launchAgentId: "claude" },
    trashedAt,
    expiresAt: trashedAt + 20_000,
  };
}

describe("endedEntryOf", () => {
  it("lists a user close as its live row had it: same run, same trash, ended", () => {
    const entry = endedEntryOf(close("t1", 1_000), false);
    expect(entry).toMatchObject({
      run: {
        runId: "t1",
        workspaceId: "project-a",
        worktreeId: "/repo/wt",
        agentId: "claude",
        spawnedAt: 1_000 - 60_000,
        lastObservedTitle: "Fix the login form",
        cwd: "/repo/wt",
      },
      trashedAt: 1_000,
      expiresAt: 21_000,
      ended: {},
    });
  });

  it("keeps a title the user gave the pane as the pane's own", () => {
    const entry = endedEntryOf(
      close("t1", 1_000, { trash: { expiresAt: 21_000, closedAt: 1_000, titleMode: "user" } }),
      false
    );
    expect(entry?.run).toMatchObject({ title: "Fix the login form", titleMode: "user" });
    expect(entry?.run.lastObservedTitle).toBeUndefined();
  });

  it("lists nothing the user did not close, took out of the Trash, or that has no place", () => {
    expect(endedEntryOf(close("t1", 1, { closedBy: "shutdown", trash: undefined }), false)).toBe(
      null
    );
    expect(endedEntryOf(close("t1", 1, { closedBy: "sleep", trash: undefined }), false)).toBe(null);
    expect(endedEntryOf(close("t1", 1, { closedBy: "restart", trash: undefined }), false)).toBe(
      null
    );
    expect(
      endedEntryOf(close("t1", 1, { trash: { expiresAt: 2, closedAt: 1, removedAt: 5 } }), false)
    ).toBe(null);
    expect(endedEntryOf(close("t1", 1, { projectId: null }), false)).toBe(null);
    expect(endedEntryOf(close("t1", 1, { terminal: undefined }), false)).toBe(null);
  });

  it("says when the worktree it ran in is gone", () => {
    expect(endedEntryOf(close("t1", 1), true)?.ended).toEqual({ worktreeRemoved: true });
  });
});

describe("mergeCanopyTrash", () => {
  it("lists live and ended runs together, newest first", () => {
    const ended = [endedEntryOf(close("old", 1_000), false)!];
    const merged = mergeCanopyTrash([live("new", 5_000)], ended);
    expect(merged.map((entry) => entry.run.runId)).toEqual(["new", "old"]);
    expect(merged.map((entry) => entry.ended)).toEqual([undefined, {}]);
  });

  it("shows a run once: its close once journaled, and a newer incarnation over an older close", () => {
    const journaled = endedEntryOf(close("t1", 1_000), false)!;
    const ending: CanopyTrashEntry = { ...live("t1", 1_000, 1_000 - 60_000), ended: {} };
    expect(mergeCanopyTrash([ending], [journaled])).toEqual([journaled]);

    const newer = live("t1", 9_000, 5_000);
    expect(mergeCanopyTrash([newer], [journaled])).toEqual([newer]);
  });

  it("keeps the newest closes up to the limit", () => {
    const ended = Array.from({ length: CANOPY_TRASH_LIMIT + 5 }, (_, index) =>
      endedEntryOf(close(`t${index}`, 1_000 + index), false)
    ).filter((entry): entry is CanopyTrashEntry => entry !== null);
    const merged = mergeCanopyTrash([live("live", 99_000)], ended);
    expect(merged).toHaveLength(CANOPY_TRASH_LIMIT);
    expect(merged[0]!.run.runId).toBe("live");
    expect(merged[merged.length - 1]!.trashedAt).toBe(1_000 + 6);
  });
});

describe("CanopyClosedTrash", () => {
  function setup(records: AgentSessionRecord[], gone: (path: string) => boolean = () => false) {
    const onChange = vi.fn();
    const readRecords = vi.fn(() => records);
    const trash = new CanopyClosedTrash({
      readRecords,
      isWorktreeGone: async (path) => gone(path),
      onChange,
    });
    return { trash, onChange, readRecords, records };
  }

  it("reads the journal only once asked, and again only on refresh", () => {
    const { trash, readRecords } = setup([close("t1", 1_000)]);
    expect(readRecords).not.toHaveBeenCalled();
    expect(trash.list().map((entry) => entry.run.runId)).toEqual(["t1"]);
    trash.list();
    expect(readRecords).toHaveBeenCalledTimes(1);
    trash.refresh();
    expect(readRecords).toHaveBeenCalledTimes(2);
  });

  it("finds a close only for the trash its row showed, with the record to resume", () => {
    const record = close("t1", 1_000);
    const { trash } = setup([record]);
    trash.list();
    expect(trash.find("t1", { spawnedAt: 1_000 - 60_000, expiresAt: 21_000 })?.record).toBe(record);
    expect(trash.find("t1", { spawnedAt: 1, expiresAt: 21_000 })).toBeUndefined();
    expect(trash.find("t1", { spawnedAt: 1_000 - 60_000, expiresAt: 1 })).toBeUndefined();
  });

  it("marks a close whose worktree is gone once checked, and says so", async () => {
    const { trash, onChange } = setup([close("t1", 1_000)], (path) => path === "/repo/wt");
    expect(trash.list()[0]!.ended).toEqual({});
    await vi.waitFor(() => expect(trash.list()[0]!.ended).toEqual({ worktreeRemoved: true }));
    expect(onChange).toHaveBeenCalled();
  });

  it("says nothing when a refresh changes nothing, and lets a removed close go", () => {
    const records = [close("t1", 1_000)];
    const { trash, onChange } = setup(records);
    trash.list();
    trash.refresh();
    expect(onChange).not.toHaveBeenCalled();
    records[0] = { ...records[0]!, trash: { ...records[0]!.trash!, removedAt: 5_000 } };
    trash.refresh();
    expect(trash.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
