import { beforeEach, describe, expect, it, vi } from "vitest";

const { collectMock, saveMock } = vi.hoisted(() => ({
  collectMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  systemClient: {
    collectDiagnosticsForReview: collectMock,
    saveDiagnosticsBundle: saveMock,
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/utils/safeFireAndForget", () => ({
  safeFireAndForget: vi.fn(),
}));

import { systemClient } from "@/clients";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useDiagnosticsReviewStore } from "../diagnosticsReviewStore";

const samplePayload = {
  payload: { app: { version: "1.0" }, env: { node: "20" } },
  sectionKeys: ["app", "env"],
  previewJson: '{"app":{"version":"1.0"},"env":{"node":"20"}}',
  collectedAtMs: 1_700_000_000_000,
};

function resetStore() {
  useDiagnosticsReviewStore.setState({
    isOpen: false,
    isCollecting: false,
    isSaving: false,
    reviewPayload: null,
    scope: null,
    downloadError: null,
    saveError: null,
    savedIssueUrl: null,
  });
}

describe("diagnosticsReviewStore", () => {
  beforeEach(() => {
    collectMock.mockReset();
    saveMock.mockReset();
    vi.mocked(notify).mockReset();
    vi.mocked(safeFireAndForget).mockClear();
    vi.mocked(systemClient.openExternal).mockReset().mockResolvedValue(undefined);
    resetStore();
  });

  it("openReview collects then atomically sets isOpen + reviewPayload + clears collecting", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);

    const seenStates: Array<{
      isCollecting: boolean;
      isOpen: boolean;
      payload: unknown;
    }> = [];
    const unsub = useDiagnosticsReviewStore.subscribe((s) =>
      seenStates.push({
        isCollecting: s.isCollecting,
        isOpen: s.isOpen,
        payload: s.reviewPayload,
      })
    );

    await useDiagnosticsReviewStore.getState().openReview();
    unsub();

    expect(collectMock).toHaveBeenCalledTimes(1);

    // The mid-flight state has isCollecting=true with the dialog still closed.
    expect(seenStates[0]).toEqual({ isCollecting: true, isOpen: false, payload: null });

    // Final state: dialog open, payload populated, collecting cleared — all in
    // a single transition so the dialog's useEffect never observes an
    // intermediate (isOpen=true, payload=null) frame.
    const final = useDiagnosticsReviewStore.getState();
    expect(final.isOpen).toBe(true);
    expect(final.isCollecting).toBe(false);
    expect(final.reviewPayload).toEqual(samplePayload);
    expect(final.downloadError).toBeNull();
  });

  it("openReview captures the scope hint", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    await useDiagnosticsReviewStore.getState().openReview({
      source: "recovery.hostCrashBanner",
      timeWindowMs: 300_000,
      sections: ["app"],
    });

    const state = useDiagnosticsReviewStore.getState();
    expect(state.scope).toEqual({
      source: "recovery.hostCrashBanner",
      timeWindowMs: 300_000,
      sections: ["app"],
    });
  });

  it("openReview reports collection failures via downloadError without opening", async () => {
    collectMock.mockRejectedValueOnce(new Error("boom"));
    await useDiagnosticsReviewStore.getState().openReview();

    const state = useDiagnosticsReviewStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.isCollecting).toBe(false);
    expect(state.reviewPayload).toBeNull();
    expect(state.downloadError).toContain("boom");
  });

  it("ignores concurrent openReview calls while collecting", async () => {
    type Resolver = (value: typeof samplePayload) => void;
    let resolveCollect: Resolver = () => {};
    collectMock.mockImplementationOnce(
      () =>
        new Promise<typeof samplePayload>((resolve) => {
          resolveCollect = resolve;
        })
    );

    const first = useDiagnosticsReviewStore.getState().openReview();
    // Second call should short-circuit because isCollecting is already true.
    await useDiagnosticsReviewStore.getState().openReview();
    expect(collectMock).toHaveBeenCalledTimes(1);

    resolveCollect(samplePayload);
    await first;
  });

  it("closeReview clears isOpen and the scope hint", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    await useDiagnosticsReviewStore.getState().openReview({ source: "settings" });
    expect(useDiagnosticsReviewStore.getState().isOpen).toBe(true);

    useDiagnosticsReviewStore.getState().closeReview();
    const state = useDiagnosticsReviewStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.scope).toBeNull();
    // The collected payload is intentionally retained so a re-open from the
    // same surface doesn't need to re-IPC. closeReview only flips the visible
    // state.
    expect(state.reviewPayload).toEqual(samplePayload);
  });

  it("saveReview hits IPC, bounded by when the review was collected, and closes the dialog", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    saveMock.mockResolvedValueOnce(true);
    await useDiagnosticsReviewStore.getState().openReview();

    await useDiagnosticsReviewStore
      .getState()
      .saveReview({ app: true, env: false }, [{ find: "secret", replace: "[REDACTED]" }]);

    expect(saveMock).toHaveBeenCalledWith({
      payload: samplePayload.payload,
      enabledSections: { app: true, env: false },
      replacements: [{ find: "secret", replace: "[REDACTED]" }],
      timeWindowStartMs: undefined,
      collectedAtMs: samplePayload.collectedAtMs,
    });
    const state = useDiagnosticsReviewStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.isSaving).toBe(false);
  });

  it("saveReview clears stale downloadError on success", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    saveMock.mockResolvedValueOnce(true);
    await useDiagnosticsReviewStore.getState().openReview();
    // Seed a stale error from a prior attempt.
    useDiagnosticsReviewStore.setState({ downloadError: "previous attempt failed" });

    await useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    expect(useDiagnosticsReviewStore.getState().downloadError).toBeNull();
  });

  it("openReview short-circuits while a save is in flight", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    await useDiagnosticsReviewStore.getState().openReview();

    // Park the save in-flight and try to open a second review.
    type Resolver = (value: boolean) => void;
    let resolveSave: Resolver = () => {};
    saveMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSave = resolve;
        })
    );

    const savePromise = useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    await useDiagnosticsReviewStore.getState().openReview();
    // collectMock would have been called twice if the guard missed.
    expect(collectMock).toHaveBeenCalledTimes(1);

    resolveSave(true);
    await savePromise;
  });

  it("saveReview keeps the dialog open when the user cancels the save dialog", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    saveMock.mockResolvedValueOnce(false);
    await useDiagnosticsReviewStore.getState().openReview();

    await useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    const state = useDiagnosticsReviewStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.isSaving).toBe(false);
  });

  it("saveReview keeps the dialog open and reports an IPC failure through saveError", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    saveMock.mockRejectedValueOnce(new Error("disk full"));
    await useDiagnosticsReviewStore.getState().openReview();

    await useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    const state = useDiagnosticsReviewStore.getState();
    expect(state.isSaving).toBe(false);
    expect(state.isOpen).toBe(true);
    expect(state.saveError).toContain("disk full");
    // The surfaces behind the dialog read downloadError; a save failure belongs
    // to the dialog it happened in.
    expect(state.downloadError).toBeNull();
  });

  it("saveReview clears the last failure while a retry is in flight", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    saveMock.mockRejectedValueOnce(new Error("disk full"));
    await useDiagnosticsReviewStore.getState().openReview();
    await useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);

    let resolveSave: (value: boolean) => void = () => {};
    saveMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSave = resolve;
        })
    );
    const retry = useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    expect(useDiagnosticsReviewStore.getState().isSaving).toBe(true);
    expect(useDiagnosticsReviewStore.getState().saveError).toBeNull();
    resolveSave(false);
    await retry;
    expect(useDiagnosticsReviewStore.getState().saveError).toBeNull();
  });

  it("a failed save's error lasts until the review next opens", async () => {
    collectMock.mockResolvedValue(samplePayload);
    saveMock.mockRejectedValue(new Error("disk full"));
    await useDiagnosticsReviewStore.getState().openReview();
    await useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    expect(useDiagnosticsReviewStore.getState().saveError).toContain("disk full");

    await useDiagnosticsReviewStore.getState().openReview();
    expect(useDiagnosticsReviewStore.getState().saveError).toBeNull();
  });

  it("saves nothing once the review has closed", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    await useDiagnosticsReviewStore.getState().openReview();
    useDiagnosticsReviewStore.getState().closeReview();

    await useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("closes the dialog before confirming a toast save, so the toast never reports an open review", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    saveMock.mockResolvedValueOnce(true);
    await useDiagnosticsReviewStore.getState().openReview();
    let stateAtNotify: { isOpen: boolean; isSaving: boolean } | null = null;
    vi.mocked(notify).mockImplementationOnce(() => {
      const { isOpen, isSaving } = useDiagnosticsReviewStore.getState();
      stateAtNotify = { isOpen, isSaving };
      return "";
    });

    await useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    expect(vi.mocked(notify).mock.calls[0]![0]).toMatchObject({ type: "success" });
    expect(stateAtNotify).toEqual({ isOpen: false, isSaving: false });
    expect(useDiagnosticsReviewStore.getState().savedIssueUrl).toBeNull();
  });

  describe("inline confirmation", () => {
    it("keeps the review open on its saved view and raises no notification", async () => {
      collectMock.mockResolvedValueOnce(samplePayload);
      saveMock.mockResolvedValueOnce(true);
      await useDiagnosticsReviewStore.getState().openReview();

      await useDiagnosticsReviewStore.getState().saveReview({ app: true }, [], null, "inline");
      const state = useDiagnosticsReviewStore.getState();
      expect(state.isOpen).toBe(true);
      expect(state.isSaving).toBe(false);
      expect(state.savedIssueUrl).toMatch(/^https:\/\/github\.com\//);
      expect(notify).not.toHaveBeenCalled();
    });

    it("never reaches the saved view when the user cancels or the save fails", async () => {
      collectMock.mockResolvedValueOnce(samplePayload);
      await useDiagnosticsReviewStore.getState().openReview();

      saveMock.mockResolvedValueOnce(false);
      await useDiagnosticsReviewStore.getState().saveReview({ app: true }, [], null, "inline");
      expect(useDiagnosticsReviewStore.getState().savedIssueUrl).toBeNull();

      saveMock.mockRejectedValueOnce(new Error("EACCES"));
      await useDiagnosticsReviewStore.getState().saveReview({ app: true }, [], null, "inline");
      expect(useDiagnosticsReviewStore.getState().savedIssueUrl).toBeNull();
      expect(useDiagnosticsReviewStore.getState().saveError).toContain("EACCES");
    });

    it("opens the saved issue and closes the review on continue", async () => {
      collectMock.mockResolvedValueOnce(samplePayload);
      saveMock.mockResolvedValueOnce(true);
      await useDiagnosticsReviewStore.getState().openReview();
      await useDiagnosticsReviewStore.getState().saveReview({ app: true }, [], null, "inline");
      const issueUrl = useDiagnosticsReviewStore.getState().savedIssueUrl;

      useDiagnosticsReviewStore.getState().continueToIssue();
      expect(systemClient.openExternal).toHaveBeenCalledWith(issueUrl);
      expect(safeFireAndForget).toHaveBeenCalledTimes(1);
      expect(useDiagnosticsReviewStore.getState().isOpen).toBe(false);

      // A second press while the dialog fades out opens nothing more.
      useDiagnosticsReviewStore.getState().continueToIssue();
      expect(systemClient.openExternal).toHaveBeenCalledTimes(1);
    });

    it("refuses another save from the saved view", async () => {
      collectMock.mockResolvedValueOnce(samplePayload);
      saveMock.mockResolvedValueOnce(true);
      await useDiagnosticsReviewStore.getState().openReview();
      await useDiagnosticsReviewStore.getState().saveReview({ app: true }, [], null, "inline");

      await useDiagnosticsReviewStore.getState().saveReview({ app: true }, [], null, "inline");
      expect(saveMock).toHaveBeenCalledTimes(1);
    });

    it("holds the saved view through the close and drops it on the next open", async () => {
      collectMock.mockResolvedValue(samplePayload);
      saveMock.mockResolvedValue(true);
      await useDiagnosticsReviewStore.getState().openReview();
      await useDiagnosticsReviewStore.getState().saveReview({ app: true }, [], null, "inline");
      const issueUrl = useDiagnosticsReviewStore.getState().savedIssueUrl;
      useDiagnosticsReviewStore.getState().closeReview();
      // The dialog is still fading out on the saved view, not the review form.
      expect(useDiagnosticsReviewStore.getState().savedIssueUrl).toBe(issueUrl);

      await useDiagnosticsReviewStore.getState().openReview();
      expect(useDiagnosticsReviewStore.getState().savedIssueUrl).toBeNull();
    });
  });

  it("saveReview no-ops if there is no payload yet", async () => {
    await useDiagnosticsReviewStore.getState().saveReview({}, []);
    expect(saveMock).not.toHaveBeenCalled();
  });

  describe("requestSeq (ErrorBoundary reset signal, #9918)", () => {
    it("increments on each successful open, including a re-open while already open", async () => {
      collectMock.mockResolvedValue(samplePayload);
      const before = useDiagnosticsReviewStore.getState().requestSeq;

      await useDiagnosticsReviewStore.getState().openReview();
      const afterFirst = useDiagnosticsReviewStore.getState().requestSeq;
      expect(afterFirst).toBeGreaterThan(before);
      expect(useDiagnosticsReviewStore.getState().isOpen).toBe(true);

      // Re-open without closing first: `isOpen` stays true the whole time, so a
      // `Number(isOpen)` key would not change — the counter must still advance.
      await useDiagnosticsReviewStore.getState().openReview();
      expect(useDiagnosticsReviewStore.getState().requestSeq).toBeGreaterThan(afterFirst);
    });

    it("does not increment when collection fails", async () => {
      collectMock.mockRejectedValueOnce(new Error("boom"));
      const before = useDiagnosticsReviewStore.getState().requestSeq;

      await useDiagnosticsReviewStore.getState().openReview();
      expect(useDiagnosticsReviewStore.getState().requestSeq).toBe(before);
    });
  });
});
