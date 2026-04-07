import { beforeEach, describe, expect, it, vi } from "vitest";

const focusStateGetterMock = vi.hoisted(() => vi.fn(() => ({ isFocusMode: false })));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
  },
}));

vi.mock("@shared/types/panel", () => ({
  TerminalRefreshTier: { VISIBLE: "visible" },
}));

vi.mock("@/utils/errorContext", () => ({
  logErrorWithContext: vi.fn(),
}));

vi.mock("@/store/focusStore", () => ({
  useFocusStore: {
    getState: focusStateGetterMock,
  },
}));

vi.mock("@/utils/performance", () => ({
  markRendererPerformance: vi.fn(),
}));

vi.mock("@shared/perf/marks", () => ({
  PERF_MARKS: {},
}));

vi.mock("@/clients", () => ({
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: { setTerminals: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
    getState: vi.fn(() => ({
      terminals: [],
      activeDockTerminalId: null,
      focusedId: null,
      mruList: [],
      recordMru: vi.fn(),
      setFocused: vi.fn(),
    })),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

describe("worktreeStore createDialog.onCreated", () => {
  let store: Awaited<typeof import("@/store/worktreeStore")>["useWorktreeSelectionStore"];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/store/worktreeStore");
    store = mod.useWorktreeSelectionStore;
  });

  it("stores onCreated callback when opening dialog", () => {
    const callback = vi.fn();
    store.getState().openCreateDialog(null, { onCreated: callback });

    const state = store.getState();
    expect(state.createDialog.isOpen).toBe(true);
    expect(state.createDialog.onCreated).toBe(callback);
  });

  it("clears onCreated callback when closing dialog", () => {
    const callback = vi.fn();
    store.getState().openCreateDialog(null, { onCreated: callback });
    store.getState().closeCreateDialog();

    expect(store.getState().createDialog.onCreated).toBeUndefined();
  });

  it("clears onCreated callback on reset", () => {
    const callback = vi.fn();
    store.getState().openCreateDialog(null, { onCreated: callback });
    store.getState().reset();

    expect(store.getState().createDialog.onCreated).toBeUndefined();
  });

  it("does not set onCreated when no callback provided", () => {
    store.getState().openCreateDialog(null);

    expect(store.getState().createDialog.onCreated).toBeUndefined();
  });

  it("does not set onCreated for PR dialog open", () => {
    store.getState().openCreateDialogForPR({
      number: 1,
      title: "test",
      url: "",
      state: "OPEN",
      isDraft: false,
      updatedAt: new Date().toISOString(),
      author: { login: "test", avatarUrl: "" },
    });

    expect(store.getState().createDialog.onCreated).toBeUndefined();
  });
});
