// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelRecoveryResponder } from "../usePanelRecoveryResponder";
import { useFileDocumentStore, type FileDocumentProjection } from "@/store/fileDocumentStore";
import {
  resetPluginPanelLifecycleForTests,
  setViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";

const projection = (overrides: Partial<FileDocumentProjection>): FileDocumentProjection => ({
  identityKey: "k",
  draftText: null,
  dirty: false,
  conflict: false,
  save: async () => true,
  discard: async () => {},
  ...overrides,
});

describe("usePanelRecoveryResponder", () => {
  let ask: (requestId: string) => void;
  const reply = vi.fn();
  const unsubscribe = vi.fn();

  beforeEach(() => {
    reply.mockReset();
    Object.assign(window, {
      electron: {
        project: {
          onPanelRecoveryQuery: (cb: (requestId: string) => void) => {
            ask = cb;
            return unsubscribe;
          },
          replyPanelRecovery: reply,
        },
      },
    });
    useFileDocumentStore.setState({ byPanelId: {} });
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

  it("stops listening on unmount", () => {
    const { unmount } = renderHook(() => usePanelRecoveryResponder());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
