// @vitest-environment jsdom
/**
 * Regression tests for #6959 — Daintree Assistant loses focus when MCP launches
 * an agent terminal. Verifies that `panelStore.addPanel` does NOT advance
 * `focusedId` to the freshly-spawned panel when:
 *   1. the assistant region currently owns keyboard focus, OR
 *   2. the spawn carries `focusPolicy: "preserve"` (issued through the MCP bridge).
 *
 * For both cases, the panel still lands in the panel registry. Focus-preserve
 * dock panels also must not auto-open the dock popover, because mounting that
 * popover runs its own terminal focus path.
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
    // No attached renderer xterm in these tests — spawn falls back to the
    // default/estimated dims path.
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
import { useMacroFocusStore } from "../macroFocusStore";
import { runWithMcpSpawnFocusSuppressed } from "../mcpSpawnFocusGuard";
import type { PtyPanelData } from "@shared/types/panel";

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
  useMacroFocusStore.setState({ focusedRegion: null });
  useMacroFocusStore.getState().refs.clear();
}

describe("panelStore.addPanel focus guard (#6959)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    // Seed an existing focused panel so we can detect any unwanted focus shift.
    usePanelStore.setState((s) => ({
      ...s,
      panelsById: {
        "incumbent-1": {
          id: "incumbent-1",
          kind: "terminal",
          title: "Existing",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["incumbent-1"],
      focusedId: "incumbent-1",
    }));
  });

  afterEach(() => {
    resetState();
  });

  it("does not advance focusedId when the assistant region owns focus", async () => {
    // Simulate Cmd-/-cycled focus into the assistant.
    useMacroFocusStore.setState({ focusedRegion: "assistant" });

    const newId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      cwd: "/test",
      location: "grid",
    });

    expect(newId).toBeTruthy();
    const state = usePanelStore.getState();
    expect(state.focusedId).toBe("incumbent-1");
    expect(state.panelsById[newId!]).toBeDefined();
    // previousFocusedId is metadata for the alternate-pane toggle and must
    // also stay pinned — the user has not navigated.
    expect(state.previousFocusedId).toBeNull();
  });

  it("does not advance focusedId when DOM focus is inside the assistant ref", async () => {
    const panelEl = document.createElement("section");
    const inputEl = document.createElement("textarea");
    panelEl.appendChild(inputEl);
    document.body.appendChild(panelEl);
    useMacroFocusStore.getState().setRegionRef("assistant", panelEl);
    inputEl.focus();
    expect(document.activeElement).toBe(inputEl);

    const newId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      cwd: "/test",
      location: "grid",
    });

    expect(newId).toBeTruthy();
    expect(usePanelStore.getState().focusedId).toBe("incumbent-1");

    document.body.removeChild(panelEl);
  });

  it("does not advance focusedId when focusPolicy is 'preserve'", async () => {
    const newId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      cwd: "/test",
      location: "grid",
      focusPolicy: "preserve",
      spawnedBy: "mcp",
    });

    expect(newId).toBeTruthy();
    const state = usePanelStore.getState();
    expect(state.focusedId).toBe("incumbent-1");
    expect(state.previousFocusedId).toBeNull();
    expect((state.panelsById[newId!] as PtyPanelData | undefined)?.spawnedBy).toBe("mcp");
    expect((state.panelsById[newId!] as PtyPanelData | undefined)?.focusPolicy).toBe("preserve");
  });

  it("does not advance focusedId while an MCP dispatch is active even without explicit focusPolicy", async () => {
    const newId = await runWithMcpSpawnFocusSuppressed(() =>
      usePanelStore.getState().addPanel({
        kind: "terminal",
        cwd: "/test",
        location: "grid",
      })
    );

    expect(newId).toBeTruthy();
    const state = usePanelStore.getState();
    expect(state.focusedId).toBe("incumbent-1");
    expect(state.previousFocusedId).toBeNull();
    expect((state.panelsById[newId!] as PtyPanelData | undefined)?.focusPolicy).toBe("preserve");
  });

  it("still advances focusedId for a normal user-initiated grid spawn", async () => {
    const newId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      cwd: "/test",
      location: "grid",
    });

    expect(newId).toBeTruthy();
    const state = usePanelStore.getState();
    expect(state.focusedId).toBe(newId);
    expect(state.previousFocusedId).toBe("incumbent-1");
  });

  it("still advances focusedId for a non-MCP grid spawn even when assistant region is visible but not focused", async () => {
    useMacroFocusStore.getState().setVisibility("assistant", true);
    // Assistant visible but focusedRegion is grid — user is working in grid,
    // not typing into assistant.
    useMacroFocusStore.setState({ focusedRegion: "grid" });

    const newId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      cwd: "/test",
      location: "grid",
    });

    expect(usePanelStore.getState().focusedId).toBe(newId);
  });

  describe("dock activation path", () => {
    it("focus-preserve spawn into dock with activateDockOnCreate adds the panel but does not open or focus it", async () => {
      const newId = await usePanelStore.getState().addPanel({
        kind: "terminal",
        cwd: "/test",
        location: "dock",
        activateDockOnCreate: true,
        focusPolicy: "preserve",
        spawnedBy: "mcp",
      });

      expect(newId).toBeTruthy();
      const state = usePanelStore.getState();
      expect(state.activeDockTerminalId).toBeNull();
      expect(state.focusedId).toBe("incumbent-1");
      expect(state.previousFocusedId).toBeNull();
      expect(state.panelsById[newId!]?.location).toBe("dock");
    });

    it("active MCP dispatch into dock with activateDockOnCreate adds the panel but does not open or focus it", async () => {
      const newId = await runWithMcpSpawnFocusSuppressed(() =>
        usePanelStore.getState().addPanel({
          kind: "terminal",
          cwd: "/test",
          location: "dock",
          activateDockOnCreate: true,
        })
      );

      expect(newId).toBeTruthy();
      const state = usePanelStore.getState();
      expect(state.activeDockTerminalId).toBeNull();
      expect(state.focusedId).toBe("incumbent-1");
      expect(state.previousFocusedId).toBeNull();
      expect((state.panelsById[newId!] as PtyPanelData | undefined)?.focusPolicy).toBe("preserve");
      expect(state.panelsById[newId!]?.location).toBe("dock");
    });

    it("focus-preserve spawn of a non-PTY (browser) panel into the dock does not steal focus", async () => {
      const newId = await usePanelStore.getState().addPanel({
        kind: "browser",
        location: "dock",
        activateDockOnCreate: true,
        focusPolicy: "preserve",
        spawnedBy: "mcp",
      });

      expect(newId).toBeTruthy();
      const state = usePanelStore.getState();
      expect(state.activeDockTerminalId).toBeNull();
      expect(state.focusedId).toBe("incumbent-1");
      expect(state.panelsById[newId!]?.location).toBe("dock");
    });

    it("rolls focus back to the incumbent when assistant is focused and a non-MCP dock activation lands", async () => {
      // The registry's atomic set() commits focusedId: id alongside the panel,
      // so the wrapper has to issue a corrective set() to honor the assistant
      // guard. Verify that path.
      useMacroFocusStore.setState({ focusedRegion: "assistant" });

      const newId = await usePanelStore.getState().addPanel({
        kind: "terminal",
        cwd: "/test",
        location: "dock",
        activateDockOnCreate: true,
      });

      expect(newId).toBeTruthy();
      const state = usePanelStore.getState();
      expect(state.activeDockTerminalId).toBe(newId);
      expect(state.focusedId).toBe("incumbent-1");
    });

    it("user-initiated dock activation still advances focus normally when assistant is not focused", async () => {
      // Positive control for the dock path — make sure we didn't break the
      // happy path while patching the guard.
      const newId = await usePanelStore.getState().addPanel({
        kind: "terminal",
        cwd: "/test",
        location: "dock",
        activateDockOnCreate: true,
      });

      expect(newId).toBeTruthy();
      const state = usePanelStore.getState();
      expect(state.activeDockTerminalId).toBe(newId);
      expect(state.focusedId).toBe(newId);
      expect(state.previousFocusedId).toBe("incumbent-1");
    });
  });
});
