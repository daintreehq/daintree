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
    maximizeTarget: null,
    preMaximizeLayout: null,
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

  // #11506 — the suppression guards gate the exit from fullscreen as well as
  // the focus grab, so a panel opened under either one lands buried behind the
  // maximized cell.
  //
  // These characterize the store contract rather than the fix: `take` already
  // cleared both gates. `file.openPanel` is what changed, and its own suite has
  // to mock the store to observe the options it sends — so the two halves only
  // add up to a fix if this side is pinned too. If any of these ever go red,
  // the action-level tests are still green and still meaningless.
  describe("explicit take policy vs. a live maximize (#11506)", () => {
    const snapshot = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    function maximizeIncumbent() {
      usePanelStore.setState({
        maximizedId: "incumbent-1",
        maximizeTarget: { type: "panel", id: "incumbent-1" },
        preMaximizeLayout: snapshot,
      });
    }

    it("leaves fullscreen and takes focus even while the assistant owns focus", async () => {
      useMacroFocusStore.setState({ focusedRegion: "assistant" });
      maximizeIncumbent();

      const newId = await usePanelStore.getState().addPanel({
        kind: "terminal",
        cwd: "/test",
        location: "grid",
        focusPolicy: "take",
      });

      const state = usePanelStore.getState();
      expect(state.focusedId).toBe(newId);
      expect(state.maximizedId).toBeNull();
      expect(state.maximizeTarget).toBeNull();
      // The grid still restores its column count — this is exitMaximize, not
      // clearMaximize.
      expect(state.preMaximizeLayout).toBe(snapshot);
    });

    it("leaves fullscreen and takes focus even under a live MCP suppression lease", async () => {
      maximizeIncumbent();

      const newId = await runWithMcpSpawnFocusSuppressed(() =>
        usePanelStore.getState().addPanel({
          kind: "terminal",
          cwd: "/test",
          location: "grid",
          focusPolicy: "take",
        })
      );

      const state = usePanelStore.getState();
      expect(state.focusedId).toBe(newId);
      expect(state.maximizedId).toBeNull();
      expect(state.maximizeTarget).toBeNull();
    });

    it("stays fullscreen for a suppressed spawn, which is the half of this that is deliberate", async () => {
      // A background spawn must not yank the layout out from under the user —
      // that is why the exit is gated at all. Pinned so a future widening of the
      // #11506 fix can't quietly take this with it.
      maximizeIncumbent();

      await runWithMcpSpawnFocusSuppressed(() =>
        usePanelStore.getState().addPanel({
          kind: "terminal",
          cwd: "/test",
          location: "grid",
        })
      );

      const state = usePanelStore.getState();
      expect(state.focusedId).toBe("incumbent-1");
      expect(state.maximizedId).toBe("incumbent-1");
      expect(state.maximizeTarget).toEqual({ type: "panel", id: "incumbent-1" });
    });
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

    it("focus-preserve spawn of a non-PTY (file) panel into the dock does not steal focus", async () => {
      // Uses `file` (a dockable non-PTY kind) so the panel actually lands in
      // the dock: since #11054, `addPanel` redirects a dock request for a
      // non-dockable kind (e.g. dev-preview) to the grid, which would bypass the
      // non-PTY dock-spawn focus path this test exercises.
      const newId = await usePanelStore.getState().addPanel({
        kind: "file",
        filePath: "/test/readme.md",
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
