// @vitest-environment jsdom
/**
 * #11054 — the dock only renders kinds it can host (`isDockPanel`). A dock
 * request for a non-dockable kind must be redirected to the grid by
 * `addPanel`, not honored, or the panel strands invisibly (still persisted,
 * still counted, unreachable). Because state hydration funnels persisted
 * non-PTY panels through this same `addPanel` path
 * (`buildArgsForNonPtyRecreation` → `addPanel`), the redirect also rescues
 * already-stranded panels on restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(null),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: vi.fn(() => null),
    cleanup: vi.fn(),
    destroy: vi.fn(),
    detachForProjectSwitch: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    prewarmTerminal: vi.fn(),
    sendPtyResize: vi.fn(),
    setInputLocked: vi.fn(),
    wake: vi.fn(),
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(() => "mock-notification-id"),
}));

vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: {
    getState: () => ({ clearAllDraftInputs: vi.fn() }),
  },
}));

// jsdom provides `window`; define a partial `electron` bridge via
// defineProperty (its descriptor value is untyped) so the store's clients can
// resolve without an unsafe cast on the typed global shim.
Object.defineProperty(window, "electron", {
  configurable: true,
  value: {
    terminal: {
      spawn: vi.fn().mockResolvedValue(undefined),
      trash: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
    },
    globalEnv: {
      get: vi.fn().mockResolvedValue({}),
    },
  },
});

import { usePanelStore } from "../panelStore";

function resetState() {
  usePanelStore.setState((s) => ({
    ...s,
    panelsById: {},
    panelIds: [],
    trashedTerminals: new Map(),
    backgroundedTerminals: new Map(),
    tabGroups: new Map(),
    focusedId: null,
    previousFocusedId: null,
    maximizedId: null,
    activeDockTerminalId: null,
    pingedId: null,
    commandQueue: [],
    commandQueueCountById: {},
    mruList: [],
  }));
}

describe("panelStore.addPanel dockability guard (#11054)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  it("redirects a dock request for a non-dockable kind (review) to the grid", async () => {
    const id = await usePanelStore.getState().addPanel({ kind: "review", location: "dock" });

    expect(id).toBeTruthy();
    const panel = usePanelStore.getState().panelsById[id!];
    expect(panel?.location).toBe("grid");
    // Rescued to a visible grid slot, not left with dock-flavored hidden state.
    expect(panel?.isVisible).toBe(true);
  });

  it("redirects a dock request for dev-preview to the grid", async () => {
    const id = await usePanelStore.getState().addPanel({ kind: "dev-preview", location: "dock" });

    expect(id).toBeTruthy();
    expect(usePanelStore.getState().panelsById[id!]?.location).toBe("grid");
  });

  it("honors a dock request for a dockable non-PTY kind (file)", async () => {
    const id = await usePanelStore
      .getState()
      .addPanel({ kind: "file", filePath: "/test/readme.md", location: "dock" });

    expect(id).toBeTruthy();
    expect(usePanelStore.getState().panelsById[id!]?.location).toBe("dock");
  });

  it("honors a dock request for a PTY kind (terminal)", async () => {
    const id = await usePanelStore
      .getState()
      .addPanel({ kind: "terminal", cwd: "/test", location: "dock" });

    expect(id).toBeTruthy();
    expect(usePanelStore.getState().panelsById[id!]?.location).toBe("dock");
  });

  it("leaves an explicit grid request for a non-dockable kind untouched", async () => {
    const id = await usePanelStore.getState().addPanel({ kind: "dev-preview", location: "grid" });

    expect(id).toBeTruthy();
    expect(usePanelStore.getState().panelsById[id!]?.location).toBe("grid");
  });

  it("does not activate the dock for a redirected (non-dockable) dock request", async () => {
    // The create-focus wrapper keys on the COMMITTED location: a dev-preview
    // requested into the dock is redirected to the grid, so it must NOT take
    // the dock-activation path — otherwise activeDockTerminalId would point at a
    // panel that isn't actually in the dock.
    const id = await usePanelStore
      .getState()
      .addPanel({ kind: "dev-preview", location: "dock", activateDockOnCreate: true });

    expect(id).toBeTruthy();
    const state = usePanelStore.getState();
    expect(state.panelsById[id!]?.location).toBe("grid");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("redirects a restore-shaped dock request (preserved id + saved dock location) to the grid", async () => {
    // This is the addPanel-contract half of the hydration rescue, not a full
    // restart. On restart, `buildArgsForNonPtyRecreation` (statePatcher.ts)
    // forwards a persisted non-PTY panel's saved `location`, and
    // `restorePanelsPhase` calls `addPanel` with the restored id/config (the
    // latter covered by the mocked-addPanel hydration tests in
    // stateHydration.panelRehydration). Here we prove the other half: given a
    // restore-shaped dock request, addPanel redirects it to the grid while
    // preserving the id — so a previously stranded panel comes back instead of
    // carrying invisible dock state forever.
    const id = await usePanelStore.getState().addPanel({
      kind: "dev-preview",
      location: "dock",
      requestedId: "stranded-devpreview-1",
    });

    expect(id).toBe("stranded-devpreview-1");
    expect(usePanelStore.getState().panelsById["stranded-devpreview-1"]?.location).toBe("grid");
  });
});
