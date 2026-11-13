// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";

const exits = vi.hoisted(() => ({ exited: new Set<string>() }));
const mounts = vi.hoisted(() => ({ panel: 0 }));

vi.mock("@/components/Panel", () => ({
  ContentPanel: ({ children }: { children: ReactNode }) => {
    useEffect(() => {
      mounts.panel += 1;
    }, []);
    return <div>{children}</div>;
  },
}));

vi.mock("@/hooks/useWorktreeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useWorktreeStore")>()),
  useWorktreeStore: (selector: (state: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/terminal/useForceResumeCycleWatchdog", () => ({
  useForceResumeCycleWatchdog: () => ({ showBanner: false, isRetrying: false, retry: vi.fn() }),
}));

vi.mock("../XtermAdapter", () => ({ XtermAdapter: () => null }));
vi.mock("../HybridInputBar", () => ({ HybridInputBar: () => null }));

vi.mock("@/hooks/useTerminalLogic", () => ({
  useTerminalLogic: ({ id }: { id: string }) => ({
    isExited: exits.exited.has(id),
    exitCode: exits.exited.has(id) ? 1 : null,
    handleExit: vi.fn(),
    handleErrorRetry: vi.fn(),
  }),
}));

vi.mock("../TerminalRestartStatusBanner", () => ({
  TerminalRestartStatusBanner: ({ onDismiss }: { onDismiss: () => void }) => (
    <button type="button" onClick={onDismiss}>
      Dismiss exit banner
    </button>
  ),
}));

vi.mock("../TerminalSearchBar", () => ({
  TerminalSearchBar: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="search-bar">{terminalId}</div>
  ),
}));

function LocalToggle({ label, terminalId }: { label: string; terminalId: string }) {
  const [on, setOn] = useState(false);
  return (
    <button type="button" data-testid={label} onClick={() => setOn(true)}>
      {`${terminalId}:${on ? "on" : "off"}`}
    </button>
  );
}

vi.mock("../ArtifactOverlay", () => ({
  ArtifactOverlay: ({ terminalId }: { terminalId: string }) => (
    <LocalToggle label="artifacts" terminalId={terminalId} />
  ),
}));

vi.mock("../MissingCliGate", () => ({
  MissingCliGate: () => <LocalToggle label="missing-cli" terminalId="gate" />,
}));

import { TerminalPane } from "../TerminalPane";
import { usePanelStore } from "@/store/panelStore";

// The pane's hooks subscribe across many IPC namespaces on mount; none of them
// bears on what a tab switch resets, so every call is inert: a subscription
// hands back a callable unsubscribe, and a request never settles.
function inertBridge(): unknown {
  const pending = () => new Promise(() => {});
  const inert: unknown = new Proxy(() => inert, {
    get: (_target, prop) => (prop === "then" ? pending : inert),
    apply: () => inert,
  });
  return inert;
}

function ptyPanel(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/repo",
    location: "grid",
    ...extra,
  };
}

function seedPanels(extra: Record<string, unknown> = {}) {
  usePanelStore.setState({
    panelsById: {
      a: ptyPanel("a", extra),
      b: ptyPanel("b", extra),
    } as unknown as ReturnType<typeof usePanelStore.getState>["panelsById"],
  });
}

function Pane({ id, agentId }: { id: string; agentId?: string }) {
  return (
    <TerminalPane
      id={id}
      title={id}
      agentId={agentId}
      cwd="/repo"
      isFocused
      onFocus={() => {}}
      onClose={() => {}}
    />
  );
}

describe("TerminalPane reused across a tab group's tabs (#16878)", () => {
  beforeEach(() => {
    vi.stubGlobal("electron", inertBridge());
    exits.exited.clear();
    mounts.panel = 0;
    seedPanels();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("closes the search opened on one tab when the pane moves to the next", async () => {
    const view = render(<Pane id="a" />);
    await act(async () => {
      window.dispatchEvent(new Event("daintree:find-in-panel"));
    });
    expect(screen.getByTestId("search-bar").textContent).toBe("a");

    view.rerender(<Pane id="b" />);
    expect(screen.queryByTestId("search-bar")).toBeNull();

    view.rerender(<Pane id="a" />);
    expect(screen.queryByTestId("search-bar")).toBeNull();
    expect(mounts.panel).toBe(1);
  });

  it("shows the next tab's exit banner after the last tab's was dismissed", async () => {
    exits.exited.add("a");
    exits.exited.add("b");
    const view = render(<Pane id="a" />);
    fireEvent.click(await screen.findByText("Dismiss exit banner"));
    await waitFor(() => expect(screen.queryByText("Dismiss exit banner")).toBeNull());

    view.rerender(<Pane id="b" />);
    expect(await screen.findByText("Dismiss exit banner")).toBeTruthy();
    expect(mounts.panel).toBe(1);
  });

  it("starts the next tab's artifact overlay fresh", () => {
    const view = render(<Pane id="a" />);
    fireEvent.click(screen.getByTestId("artifacts"));
    expect(screen.getByTestId("artifacts").textContent).toBe("a:on");

    view.rerender(<Pane id="b" />);
    expect(screen.getByTestId("artifacts").textContent).toBe("b:off");
    expect(mounts.panel).toBe(1);
  });

  it("starts the next tab's missing-CLI gate fresh, even for the same agent", () => {
    seedPanels({ spawnStatus: "missing-cli" });
    const view = render(<Pane id="a" agentId="claude" />);
    fireEvent.click(screen.getByTestId("missing-cli"));
    expect(screen.getByTestId("missing-cli").textContent).toBe("gate:on");

    view.rerender(<Pane id="b" agentId="claude" />);
    expect(screen.getByTestId("missing-cli").textContent).toBe("gate:off");
    expect(mounts.panel).toBe(1);
  });

  it("takes the last tab's banner away at once rather than fading it over the next", async () => {
    exits.exited.add("a");
    const view = render(<Pane id="a" />);
    expect(await screen.findByText("Dismiss exit banner")).toBeTruthy();

    view.rerender(<Pane id="b" />);
    expect(screen.queryByText("Dismiss exit banner")).toBeNull();
  });

  describe("auto-restart", () => {
    const restartTerminal = vi.fn();
    const realRestartTerminal = usePanelStore.getState().restartTerminal;

    beforeEach(() => {
      vi.useFakeTimers();
      restartTerminal.mockClear();
      seedPanels({ exitBehavior: "restart" });
      usePanelStore.setState({ restartTerminal });
      exits.exited.add("a");
      exits.exited.add("b");
    });

    afterEach(() => {
      vi.useRealTimers();
      usePanelStore.setState({ restartTerminal: realRestartTerminal });
    });

    it("restarts the tab the pane moved to, not the one it left", () => {
      const view = render(<Pane id="a" />);
      view.rerender(<Pane id="b" />);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(restartTerminal.mock.calls).toEqual([["b"]]);
    });
  });
});
