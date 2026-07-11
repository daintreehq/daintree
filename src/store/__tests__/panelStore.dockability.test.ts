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

(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  terminal: {
    spawn: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
  },
  globalEnv: {
    get: vi.fn().mockResolvedValue({}),
  },
};

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

  it("redirects a dock request for a non-dockable kind (browser) to the grid", async () => {
    const id = await usePanelStore.getState().addPanel({ kind: "browser", location: "dock" });

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
    const id = await usePanelStore.getState().addPanel({ kind: "browser", location: "grid" });

    expect(id).toBeTruthy();
    expect(usePanelStore.getState().panelsById[id!]?.location).toBe("grid");
  });

  it("rescues an already-stranded persisted dock panel back to the grid on restore", async () => {
    // Mirrors what `buildArgsForNonPtyRecreation` passes into `addPanel` when
    // rehydrating a persisted non-PTY panel: a preserved id plus the saved
    // `location: "dock"`. The guard redirects it to the grid so the user gets
    // the panel back instead of carrying invisible state forever.
    const id = await usePanelStore.getState().addPanel({
      kind: "browser",
      location: "dock",
      requestedId: "stranded-browser-1",
    });

    expect(id).toBe("stranded-browser-1");
    expect(usePanelStore.getState().panelsById["stranded-browser-1"]?.location).toBe("grid");
  });
});
