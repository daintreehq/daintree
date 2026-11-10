// @vitest-environment jsdom
/**
 * Regression guard for #16622. The scrollback-restore banner says the terminal
 * still works, then offers a restart; with an agent mid-turn that button used to
 * kill the process at once. These tests click the real banner's button through
 * the hook `TerminalPane` wires to it, against the real panel store, and assert
 * on which path the click takes.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
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

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("../../../store/slices/panelRegistry/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("../../../store/slices/panelRegistry/persistence")
  >("../../../store/slices/panelRegistry/persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

const { usePanelStore } = await import("@/store/panelStore");
const { ScrollbackRestoreErrorBanner } = await import("../ScrollbackRestoreErrorBanner");
const { useScrollbackRestoreRestart } = await import("../useScrollbackRestoreRestart");

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
  });
}

function patch(id: string, overrides: Partial<PtyPanelData>) {
  act(() => {
    usePanelStore.setState((state) => ({
      panelsById: { ...state.panelsById, [id]: { ...state.panelsById[id]!, ...overrides } },
    }));
  });
}

// What TerminalPane does: the banner's button goes through the hook, whose
// immediate branch is the pane's own `handleRestart`.
function BannerHarness({
  panelId,
  restartImmediately,
}: {
  panelId: string;
  restartImmediately: () => void;
}) {
  const onRestart = useScrollbackRestoreRestart(panelId, restartImmediately);
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
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("scrollback-restore banner restart", () => {
  it("routes a working agent through terminal.restart and leaves the process alone", () => {
    seed(panel("t-1", { detectedAgentId: "claude", agentState: "working" }));
    const restartImmediately = vi.fn();
    render(<BannerHarness panelId="t-1" restartImmediately={restartImmediately} />);

    clickRestart();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.restart",
      { terminalId: "t-1" },
      { source: "user" }
    );
    expect(restartImmediately).not.toHaveBeenCalled();
  });

  it("keeps the banner's error in place while the confirm is pending", () => {
    seed(panel("t-1", { detectedAgentId: "claude", agentState: "working" }));
    render(<BannerHarness panelId="t-1" restartImmediately={vi.fn()} />);

    clickRestart();

    const stored = usePanelStore.getState().panelsById["t-1"] as PtyPanelData;
    expect(stored.scrollbackRestoreError).toEqual(RESTORE_ERROR);
    expect(screen.getByRole("button", { name: "Restart terminal" })).toBeTruthy();
  });

  it("restarts an idle shell at once, with no confirm", () => {
    seed(panel("t-1"));
    const restartImmediately = vi.fn();
    render(<BannerHarness panelId="t-1" restartImmediately={restartImmediately} />);

    clickRestart();

    expect(restartImmediately).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["waiting", "idle", "completed", "exited"] as const)(
    "restarts an agent that is %s at once, the same split the header menu makes",
    (agentState) => {
      seed(panel("t-1", { detectedAgentId: "claude", agentState }));
      const restartImmediately = vi.fn();
      render(<BannerHarness panelId="t-1" restartImmediately={restartImmediately} />);

      clickRestart();

      expect(restartImmediately).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    }
  );

  it("restarts at once for a pane the store no longer has", () => {
    seed();
    const restartImmediately = vi.fn();
    render(<BannerHarness panelId="gone" restartImmediately={restartImmediately} />);

    clickRestart();

    expect(restartImmediately).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reads the agent's state at the click, not at render", () => {
    seed(panel("t-1", { detectedAgentId: "claude", agentState: "waiting" }));
    const restartImmediately = vi.fn();
    render(<BannerHarness panelId="t-1" restartImmediately={restartImmediately} />);

    patch("t-1", { agentState: "working" });
    clickRestart();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(restartImmediately).not.toHaveBeenCalled();
  });

  it("follows the pane when the same component is reused for another terminal", () => {
    seed(panel("t-1"), panel("t-2", { detectedAgentId: "claude", agentState: "working" }));
    const restartImmediately = vi.fn();
    const { rerender } = render(
      <BannerHarness panelId="t-1" restartImmediately={restartImmediately} />
    );

    rerender(<BannerHarness panelId="t-2" restartImmediately={restartImmediately} />);
    clickRestart();

    expect(dispatch).toHaveBeenCalledWith(
      "terminal.restart",
      { terminalId: "t-2" },
      { source: "user" }
    );
    expect(restartImmediately).not.toHaveBeenCalled();
  });
});
