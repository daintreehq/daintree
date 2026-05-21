// @vitest-environment jsdom
//
// Cold-module-graph regression gate for issue #8402.
//
// `worktreeStore.ts` and `panelStore.ts` form a circular import: panelStore
// statically imports `useWorktreeSelectionStore`, and (post-#8402) worktreeStore
// statically imports `usePanelStore`. This test proves the cycle is init-safe in
// BOTH evaluation orders from a cold module graph — neither store reads the
// other's export during module evaluation, so the live binding resolves before
// any action runs. If either order throws, the static-import approach is unsafe
// and the storeAccessors indirection must be used instead.
//
// Only the leaf dependencies are mocked. The two stores under test are NEVER
// mocked — that is the whole point of the gate.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/controllers", () => ({
  terminalRegistryController: {
    kill: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    destroy: vi.fn(),
    detachForProjectSwitch: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    applyRendererPolicy: vi.fn(),
    wake: vi.fn(),
  },
}));

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelSnapshotOptions: vi.fn((p: { id: string }) => ({ id: p.id })),
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(() => "mock-notification-id"),
}));

vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: {
    getState: () => ({ clearAllDraftInputs: vi.fn() }),
  },
}));

vi.mock("@/clients", () => ({
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: { setTerminals: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    flush: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

(globalThis as Record<string, unknown>).window = globalThis.window ?? {};

function assertLiveStore(store: { getState?: () => unknown } | undefined, label: string) {
  expect(store, `${label} export should be defined`).toBeDefined();
  const getState = store?.getState;
  expect(typeof getState, `${label}.getState should be callable`).toBe("function");
  // Reading state forces the zustand state-creator to have run, which is where
  // a TDZ/circular-eval failure would surface.
  expect(() => getState?.()).not.toThrow();
}

describe("worktreeStore ↔ panelStore circular init", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is init-safe when panelStore is evaluated before worktreeStore", async () => {
    const panelMod = await import("@/store/panelStore");
    const worktreeMod = await import("@/store/worktreeStore");

    assertLiveStore(panelMod.usePanelStore, "usePanelStore");
    assertLiveStore(worktreeMod.useWorktreeSelectionStore, "useWorktreeSelectionStore");
  });

  it("is init-safe when worktreeStore is evaluated before panelStore", async () => {
    const worktreeMod = await import("@/store/worktreeStore");
    const panelMod = await import("@/store/panelStore");

    assertLiveStore(worktreeMod.useWorktreeSelectionStore, "useWorktreeSelectionStore");
    assertLiveStore(panelMod.usePanelStore, "usePanelStore");
  });

  it("is init-safe when an internal panelRegistry slice is the cold-graph entry point", async () => {
    // Regression for the #8402 init-order trap: panelStore's top-level
    // create() calls createPanelRegistrySlice(), so if a consumer enters the
    // graph via panelRegistrySlice (white-box slice tests do exactly this),
    // panelStore must not evaluate while panelRegistrySlice is still mid-eval.
    // The worktreeStore→panelStore static edge previously closed that loop
    // through panelRegistry/addPanel; addPanel now uses the storeAccessors
    // snapshot instead of importing worktreeStore, breaking the cycle.
    const sliceMod = await import("@/store/slices/panelRegistrySlice");
    const worktreeMod = await import("@/store/worktreeStore");
    const panelMod = await import("@/store/panelStore");

    expect(typeof sliceMod.createPanelRegistrySlice).toBe("function");
    assertLiveStore(panelMod.usePanelStore, "usePanelStore");
    assertLiveStore(worktreeMod.useWorktreeSelectionStore, "useWorktreeSelectionStore");
  });

  it("worktreeStore can read panelStore state synchronously after cold load", async () => {
    const worktreeMod = await import("@/store/worktreeStore");
    const panelMod = await import("@/store/panelStore");

    // selectWorktree → applyWorktreeTerminalPolicy reads usePanelStore.getState()
    // synchronously post-#8402. With an empty panel registry this must not throw.
    expect(() =>
      worktreeMod.useWorktreeSelectionStore.getState().selectWorktree("wt-cold-graph")
    ).not.toThrow();
    expect(worktreeMod.useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-cold-graph");
    expect(panelMod.usePanelStore.getState().panelIds).toEqual([]);
  });
});
