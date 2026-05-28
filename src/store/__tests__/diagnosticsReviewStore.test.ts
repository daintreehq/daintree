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

import { useDiagnosticsReviewStore } from "../diagnosticsReviewStore";

const samplePayload = {
  payload: { app: { version: "1.0" }, env: { node: "20" } },
  sectionKeys: ["app", "env"],
  previewJson: '{"app":{"version":"1.0"},"env":{"node":"20"}}',
};

function resetStore() {
  useDiagnosticsReviewStore.setState({
    isOpen: false,
    isCollecting: false,
    isSaving: false,
    reviewPayload: null,
    scope: null,
    downloadError: null,
  });
}

describe("diagnosticsReviewStore", () => {
  beforeEach(() => {
    collectMock.mockReset();
    saveMock.mockReset();
    resetStore();
  });

  it("starts closed with no payload or error", () => {
    const state = useDiagnosticsReviewStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.isCollecting).toBe(false);
    expect(state.isSaving).toBe(false);
    expect(state.reviewPayload).toBeNull();
    expect(state.downloadError).toBeNull();
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

  it("saveReview hits IPC and closes the dialog when the user picks a file", async () => {
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
    });
    const state = useDiagnosticsReviewStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.isSaving).toBe(false);
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

  it("saveReview surfaces IPC failures via downloadError", async () => {
    collectMock.mockResolvedValueOnce(samplePayload);
    saveMock.mockRejectedValueOnce(new Error("disk full"));
    await useDiagnosticsReviewStore.getState().openReview();

    await useDiagnosticsReviewStore.getState().saveReview({ app: true }, []);
    const state = useDiagnosticsReviewStore.getState();
    expect(state.isSaving).toBe(false);
    expect(state.downloadError).toContain("disk full");
  });

  it("saveReview no-ops if there is no payload yet", async () => {
    await useDiagnosticsReviewStore.getState().saveReview({}, []);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("clearError resets the error string", () => {
    useDiagnosticsReviewStore.setState({ downloadError: "boom" });
    useDiagnosticsReviewStore.getState().clearError();
    expect(useDiagnosticsReviewStore.getState().downloadError).toBeNull();
  });
});
