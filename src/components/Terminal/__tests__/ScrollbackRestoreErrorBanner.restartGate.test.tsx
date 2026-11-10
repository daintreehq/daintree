// @vitest-environment jsdom
/**
 * Regression guard for #16622. The scrollback-restore banner says the terminal
 * still works, then offers a restart; with an agent mid-turn that button used to
 * kill the process at once. These tests click the real banner's button against
 * the real panel store and assert on which path the click takes. The banner owns
 * the gate, so no caller's wiring can route around it.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";
import type { TerminalScrollbackRestoreError } from "@/types";

const dispatch = vi.hoisted(() => vi.fn());

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
  systemClient: { getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }) },
}));

const { usePanelStore } = await import("@/store/panelStore");
const { ScrollbackRestoreErrorBanner } = await import("../ScrollbackRestoreErrorBanner");

const RESTORE_ERROR: TerminalScrollbackRestoreError = {
  type: "timeout",
  message: "simulated timeout",
  timestamp: 1700000000000,
};

function panel(id: string, overrides: Partial<PtyPanelData> = {}): PanelInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    scrollbackRestoreError: RESTORE_ERROR,
    ...overrides,
  } as PanelInstance;
}

function seed(...panels: PanelInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    focusedId: null,
  });
}

function patch(id: string, overrides: Partial<PtyPanelData>) {
  act(() => {
    usePanelStore.setState((state) => {
      const current = state.panelsById[id];
      if (!current || !isPtyPanel(current)) throw new Error(`no PTY panel '${id}' to patch`);
      return { panelsById: { ...state.panelsById, [id]: { ...current, ...overrides } } };
    });
  });
}

function banner(panelId: string, onRestart: (id: string) => void) {
  return (
    <ScrollbackRestoreErrorBanner
      terminalId={panelId}
      error={RESTORE_ERROR}
      onDismiss={vi.fn()}
      onRestart={onRestart}
    />
  );
}

function clickRestart() {
  fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
}

const restartTerminal = vi.fn();

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockResolvedValue({ ok: false });
  restartTerminal.mockReset();
  usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null, restartTerminal });
});

describe("scrollback-restore banner restart gate", () => {
  it("routes a working agent through terminal.restart and does not restart it itself", () => {
    seed(panel("t-1", { detectedAgentId: "claude", agentState: "working" }));
    const onRestart = vi.fn();
    render(banner("t-1", onRestart));

    clickRestart();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.restart",
      { terminalId: "t-1" },
      { source: "user" }
    );
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("touches neither the process nor the restore error before the confirm is answered", () => {
    seed(panel("t-1", { detectedAgentId: "claude", agentState: "working" }));
    render(banner("t-1", vi.fn()));

    clickRestart();

    expect(restartTerminal).not.toHaveBeenCalled();
    const stored = usePanelStore.getState().panelsById["t-1"];
    expect(stored && isPtyPanel(stored) ? stored.scrollbackRestoreError : undefined).toEqual(
      RESTORE_ERROR
    );
  });

  it("restarts an idle shell at once, with no confirm", () => {
    seed(panel("t-1"));
    const onRestart = vi.fn();
    render(banner("t-1", onRestart));

    clickRestart();

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith("t-1");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["idle", "waiting", "directing", "completed", "exited"] as const)(
    "restarts an agent that is %s at once, the same split the header menu makes",
    (agentState) => {
      seed(panel("t-1", { detectedAgentId: "claude", agentState }));
      const onRestart = vi.fn();
      render(banner("t-1", onRestart));

      clickRestart();

      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    }
  );

  it("gates on a working agent, not on a working state alone", () => {
    seed(panel("t-1", { agentState: "working" }));
    const onRestart = vi.fn();
    render(banner("t-1", onRestart));

    clickRestart();

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("restarts at once for a pane the store no longer has", () => {
    seed();
    const onRestart = vi.fn();
    render(banner("gone", onRestart));

    clickRestart();

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reads the agent's state at the click, not at render", () => {
    seed(panel("t-1", { detectedAgentId: "claude", agentState: "waiting" }));
    const onRestart = vi.fn();
    render(banner("t-1", onRestart));

    patch("t-1", { agentState: "working" });
    clickRestart();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("follows the pane when the same banner is reused for another terminal", () => {
    seed(panel("t-1"), panel("t-2", { detectedAgentId: "claude", agentState: "working" }));
    const onRestart = vi.fn();
    const { rerender } = render(banner("t-1", onRestart));

    rerender(banner("t-2", onRestart));
    clickRestart();

    expect(dispatch).toHaveBeenCalledWith(
      "terminal.restart",
      { terminalId: "t-2" },
      { source: "user" }
    );
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("judges the banner's own pane, not whichever pane has focus", () => {
    seed(
      panel("t-1", { detectedAgentId: "claude", agentState: "working" }),
      panel("t-2", { detectedAgentId: "claude", agentState: "idle" })
    );
    usePanelStore.setState({ focusedId: "t-2" });
    const onRestart = vi.fn();
    const { unmount } = render(banner("t-1", onRestart));

    clickRestart();
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.restart",
      { terminalId: "t-1" },
      { source: "user" }
    );
    expect(onRestart).not.toHaveBeenCalled();
    unmount();

    dispatch.mockClear();
    usePanelStore.setState({ focusedId: "t-1" });
    render(banner("t-2", onRestart));

    clickRestart();
    expect(onRestart).toHaveBeenCalledWith("t-2");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
