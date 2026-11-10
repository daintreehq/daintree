// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalSubmissionLookup,
  TerminalSubmissionPhase,
} from "@shared/types/terminalSubmission";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import type { DiffNote } from "@/components/Worktree/diffNotes";

const getSubmissions = vi.hoisted(() =>
  vi.fn<(ids: string[], token: string) => Promise<Record<string, TerminalSubmissionLookup>>>()
);
vi.mock("@/clients", () => ({ terminalClient: { getSubmissions } }));

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logWarn }));

import { clearDiffNotesOnceWritten } from "../diffNotesDelivery";

const found = (phase: TerminalSubmissionPhase): Record<string, TerminalSubmissionLookup> => ({
  t1: { status: "found", record: { token: "tok", phase } },
});

function pendingNote(): DiffNote {
  return useDiffNotesStore
    .getState()
    .addNote({ worktreePath: "/repo", filePath: "a.ts", anchor: { kind: "file" }, body: "Note" })!;
}

const stillPending = (note: DiffNote) => useDiffNotesStore.getState().notes[note.id] !== undefined;

describe("clearDiffNotesOnceWritten", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSubmissions.mockReset();
    logWarn.mockReset();
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears only once the terminal reports the submission written", async () => {
    const note = pendingNote();
    getSubmissions
      .mockResolvedValueOnce(found("queued"))
      .mockResolvedValueOnce(found("writing"))
      .mockResolvedValue(found("pty_written"));

    clearDiffNotesOnceWritten("t1", "tok", [note]);
    expect(stillPending(note)).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    expect(getSubmissions).toHaveBeenCalledTimes(1);
    expect(stillPending(note)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(getSubmissions).toHaveBeenCalledTimes(2);
    expect(stillPending(note)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getSubmissions).toHaveBeenCalledTimes(3);
    expect(stillPending(note)).toBe(false);
    expect(getSubmissions).toHaveBeenCalledWith(["t1"], "tok");
  });

  it.each<TerminalSubmissionPhase>(["failed", "cancelled", "unknown"])(
    "keeps the notes and stops looking when the submission ends %s",
    async (phase) => {
      const note = pendingNote();
      getSubmissions.mockResolvedValue(found(phase));

      clearDiffNotesOnceWritten("t1", "tok", [note]);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(stillPending(note)).toBe(true);
      expect(getSubmissions).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps the notes when the terminal can't be read, or the read itself fails", async () => {
    const unreadable = pendingNote();
    getSubmissions.mockResolvedValueOnce({ t1: { status: "unreadable" } });
    clearDiffNotesOnceWritten("t1", "tok", [unreadable]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stillPending(unreadable)).toBe(true);

    const rejected = pendingNote();
    getSubmissions.mockRejectedValueOnce(new Error("gone"));
    clearDiffNotesOnceWritten("t1", "tok", [rejected]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stillPending(rejected)).toBe(true);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("waits out a token still on its way to the host, but not one that never arrives", async () => {
    const arrives = pendingNote();
    getSubmissions
      .mockResolvedValueOnce({ t1: { status: "absent" } })
      .mockResolvedValue(found("pty_written"));
    clearDiffNotesOnceWritten("t1", "tok", [arrives]);
    await vi.advanceTimersByTimeAsync(750);
    expect(stillPending(arrives)).toBe(false);

    getSubmissions.mockReset();
    getSubmissions.mockResolvedValue({ t1: { status: "absent" } });
    const lost = pendingNote();
    clearDiffNotesOnceWritten("t1", "tok", [lost]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stillPending(lost)).toBe(true);
    expect(getSubmissions).toHaveBeenCalledTimes(5);
  });

  it("keeps watching a submission the lane is still holding, however long", async () => {
    const note = pendingNote();
    getSubmissions.mockResolvedValue(found("queued"));

    clearDiffNotesOnceWritten("t1", "tok", [note]);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const reads = getSubmissions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getSubmissions.mock.calls.length).toBeGreaterThan(reads);
    expect(stillPending(note)).toBe(true);

    getSubmissions.mockResolvedValue(found("pty_written"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stillPending(note)).toBe(false);
  });

  it("eases off while it waits, rather than polling a stuck lane at full rate", async () => {
    getSubmissions.mockResolvedValue(found("queued"));

    clearDiffNotesOnceWritten("t1", "tok", [pendingNote()]);
    await vi.advanceTimersByTimeAsync(60_000);

    // Every 250ms would be 240 reads.
    expect(getSubmissions.mock.calls.length).toBeLessThan(40);
  });

  it("gives up on a submission that never settles, leaving its notes pending", async () => {
    const note = pendingNote();
    getSubmissions.mockResolvedValue(found("queued"));

    clearDiffNotesOnceWritten("t1", "tok", [note]);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const reads = getSubmissions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stillPending(note)).toBe(true);
    expect(getSubmissions).toHaveBeenCalledTimes(reads);
  });

  it("leaves a note edited, or opened in an editor, while the send was on its way", async () => {
    const edited = pendingNote();
    const opened = pendingNote();
    const sent = pendingNote();
    getSubmissions.mockResolvedValue(found("pty_written"));

    clearDiffNotesOnceWritten("t1", "tok", [edited, opened, sent]);
    useDiffNotesStore.getState().saveNote(edited, "Rewritten");
    useDiffNotesStore.getState().setEditing(opened.id, true);
    await vi.advanceTimersByTimeAsync(250);

    expect(useDiffNotesStore.getState().notes[edited.id]?.body).toBe("Rewritten");
    expect(stillPending(opened)).toBe(true);
    expect(stillPending(sent)).toBe(false);
  });
});
