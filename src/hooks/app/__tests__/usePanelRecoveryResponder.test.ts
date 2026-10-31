// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelRecoveryResponder } from "../usePanelRecoveryResponder";
import { useFileDocumentStore, type FileDocumentProjection } from "@/store/fileDocumentStore";
import { useReviewCommitDraftStore } from "@/store/reviewCommitDraftStore";
import {
  resetPluginPanelLifecycleForTests,
  setViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";

const projection = (overrides: Partial<FileDocumentProjection>): FileDocumentProjection => ({
  identityKey: "k",
  draftText: null,
  dirty: false,
  conflict: false,
  save: async () => ({ status: "saved" as const }),
  discard: async () => {},
  ...overrides,
});

describe("usePanelRecoveryResponder", () => {
  let ask: (requestId: string) => void;
  const reply = vi.fn();
  const report = vi.fn();
  const unsubscribe = vi.fn();

  beforeEach(() => {
    reply.mockReset();
    report.mockReset();
    Object.assign(window, {
      electron: {
        project: {
          onPanelRecoveryQuery: (cb: (requestId: string) => void) => {
            ask = cb;
            return unsubscribe;
          },
          replyPanelRecovery: reply,
          reportPanelRecoveryState: report,
        },
      },
    });
    useFileDocumentStore.setState({ byPanelId: {} });
    useReviewCommitDraftStore.setState({ draftsByWorktree: {} });
    resetPluginPanelLifecycleForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers that a clean view holds nothing", () => {
    renderHook(() => usePanelRecoveryResponder());
    ask("r1");
    expect(reply).toHaveBeenCalledWith("r1", false);
  });

  it("answers that a dirty draft with stored recovery holds nothing", () => {
    useFileDocumentStore.setState({
      byPanelId: { a: projection({ dirty: true, recoveryStored: true }) },
    });
    renderHook(() => usePanelRecoveryResponder());
    ask("r1");
    expect(reply).toHaveBeenCalledWith("r1", false);
  });

  it.each([
    ["recovery was not acknowledged", { dirty: true, recoveryStored: false }],
    ["the plugin says nothing about recovery", { dirty: true }],
  ])("holds when %s", (_name, overrides) => {
    useFileDocumentStore.setState({ byPanelId: { a: projection(overrides) } });
    renderHook(() => usePanelRecoveryResponder());
    ask("r1");
    expect(reply).toHaveBeenCalledWith("r1", true);
  });

  it("holds while a plugin panel reports unsaved changes", () => {
    setViewUnsavedChanges("panel", {}, true);
    renderHook(() => usePanelRecoveryResponder());
    ask("r1");
    expect(reply).toHaveBeenCalledWith("r1", true);
  });

  it("holds while a typed commit message waits in Review & commit (#15574)", () => {
    useReviewCommitDraftStore.getState().setDraft("/repo/a", "feat: carefully worded");
    renderHook(() => usePanelRecoveryResponder());
    ask("r1");
    expect(reply).toHaveBeenCalledWith("r1", true);
  });

  it("answers that an emptied or whitespace-only commit draft holds nothing", () => {
    const { setDraft } = useReviewCommitDraftStore.getState();
    setDraft("/repo/a", "feat: second thoughts");
    setDraft("/repo/a", "");
    setDraft("/repo/b", " \n\t");
    renderHook(() => usePanelRecoveryResponder());
    ask("r1");
    expect(reply).toHaveBeenCalledWith("r1", false);
  });

  it("stops listening on unmount", () => {
    const { unmount } = renderHook(() => usePanelRecoveryResponder());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  describe("pushing the answer for eviction", () => {
    it("reports the current answer on mount", () => {
      setViewUnsavedChanges("panel", {}, true);
      renderHook(() => usePanelRecoveryResponder());
      expect(report.mock.calls).toEqual([[true]]);
    });

    it("reports each flip of a plugin view's unsaved flag, and only flips", () => {
      const a = {};
      const b = {};
      renderHook(() => usePanelRecoveryResponder());
      setViewUnsavedChanges("panel", a, true);
      setViewUnsavedChanges("other", b, true);
      setViewUnsavedChanges("panel", a, false);
      setViewUnsavedChanges("other", b, false);
      expect(report.mock.calls).toEqual([[false], [true], [false]]);
    });

    it("reports a file draft losing and regaining its stored recovery", () => {
      renderHook(() => usePanelRecoveryResponder());
      useFileDocumentStore.setState({
        byPanelId: { a: projection({ dirty: true, recoveryStored: false }) },
      });
      useFileDocumentStore.setState({
        byPanelId: { a: projection({ dirty: true, recoveryStored: true }) },
      });
      expect(report.mock.calls).toEqual([[false], [true], [false]]);
    });

    it("reports a commit draft appearing, then going with its commit or its worktree", () => {
      renderHook(() => usePanelRecoveryResponder());
      const { setDraft, clearCommitted, clearWorktree } = useReviewCommitDraftStore.getState();
      setDraft("/repo/a", "feat: a");
      clearCommitted("/repo/a", "feat: a");
      setDraft("/repo/b", "fix: b");
      clearWorktree("/repo/b");
      expect(report.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
    });

    it("stops reporting on unmount", () => {
      const { unmount } = renderHook(() => usePanelRecoveryResponder());
      unmount();
      setViewUnsavedChanges("panel", {}, true);
      expect(report.mock.calls).toEqual([[false]]);
    });
  });
});
