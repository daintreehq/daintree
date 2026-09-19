// @vitest-environment jsdom
/**
 * Handing a terminal to an orchestrating pane (#12490): the menu entries, the
 * consent step and the header badge. Main decides every hand-over; what the
 * renderer owns is offering it only where it can succeed, saying plainly what
 * it grants, and showing who is driving.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
  waitFor,
  renderHook,
} from "@testing-library/react";
import type React from "react";

vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={() => onSelect?.()}>{children}</button>
  );
  return {
    ContextMenuItem: Item,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: Passthrough,
    ContextMenuSubTrigger: Passthrough,
  };
});

const panelsById = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/store", () => ({
  usePanelStore: Object.assign(
    (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
      selector({ panelsById: panelsById.current }),
    { getState: () => ({ panelsById: panelsById.current }) }
  ),
  // Read by AppDialog, which the consent step renders through.
  usePortalStore: (selector: (s: { isOpen: boolean; width: number }) => unknown) =>
    selector({ isOpen: false, width: 0 }),
}));

import {
  TerminalDrivenByBadge,
  TerminalHandOverDialog,
  TerminalHandOverMenuItems,
  useOrchestratorCandidates,
} from "../TerminalHandOver";
import { useTerminalAdoptionStore } from "@/store/terminalAdoptionStore";
import { TooltipProvider } from "@/components/ui/tooltip";

const adoptTerminal = vi.fn();
const releaseTerminalAdoption = vi.fn(() => Promise.resolve(true));
const listOrchestratorPanes = vi.fn(() => Promise.resolve([] as string[]));

function panel(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, kind: "terminal", worktreeId: "wt-1", location: "grid", ...extra };
}

beforeEach(() => {
  panelsById.current = {
    "terminal-1": panel("terminal-1", "Worker"),
    "pane-orch": panel("pane-orch", "Coordinator"),
    "pane-other": panel("pane-other", "Reviewer"),
  };
  Object.defineProperty(window, "electron", {
    value: { mcpServer: { adoptTerminal, releaseTerminalAdoption, listOrchestratorPanes } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  adoptTerminal.mockReset();
  releaseTerminalAdoption.mockClear();
  listOrchestratorPanes.mockReset();
  useTerminalAdoptionStore.getState().applyAdoptions([]);
});

function handTo(orchestratorPaneId: string) {
  useTerminalAdoptionStore
    .getState()
    .applyAdoptions([{ terminalId: "terminal-1", orchestratorPaneId, adoptedAt: 1 }]);
}

describe("TerminalHandOverMenuItems", () => {
  it("renders nothing when there is no pane to hand to", () => {
    const { container } = render(
      <TerminalHandOverMenuItems
        terminalId="terminal-1"
        candidateIds={[]}
        onRequestHandOver={vi.fn()}
      />
    );
    expect(container.textContent).toBe("");
  });

  it("lists each candidate by the name its header shows and asks for consent on pick", () => {
    const onRequestHandOver = vi.fn();
    render(
      <TerminalHandOverMenuItems
        terminalId="terminal-1"
        candidateIds={["pane-orch", "pane-other"]}
        onRequestHandOver={onRequestHandOver}
      />
    );

    fireEvent.click(screen.getByText("Reviewer"));

    expect(onRequestHandOver).toHaveBeenCalledWith("pane-other");
    expect(screen.getByText("Coordinator")).toBeTruthy();
  });

  it("offers only the take-back while the terminal is handed over", () => {
    handTo("pane-orch");
    render(
      <TerminalHandOverMenuItems
        terminalId="terminal-1"
        candidateIds={["pane-other"]}
        onRequestHandOver={vi.fn()}
      />
    );

    expect(screen.queryByText("Reviewer")).toBeNull();
    fireEvent.click(screen.getByText("Take back from Coordinator"));

    expect(releaseTerminalAdoption).toHaveBeenCalledWith({ terminalId: "terminal-1" });
  });
});

describe("useOrchestratorCandidates", () => {
  it("keeps only live panes in this view, never the terminal itself", async () => {
    panelsById.current["pane-trashed"] = panel("pane-trashed", "Old", { location: "trash" });
    listOrchestratorPanes.mockResolvedValue([
      "pane-orch",
      "terminal-1",
      "pane-trashed",
      "pane-in-another-view",
    ]);
    const { result } = renderHook(() => useOrchestratorCandidates("terminal-1"));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.candidateIds).toEqual(["pane-orch"]));
  });
});

describe("TerminalHandOverDialog", () => {
  it("names both panes and says the orchestrator's input is not filtered", () => {
    render(
      <TerminalHandOverDialog
        terminalId="terminal-1"
        orchestratorPaneId="pane-orch"
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Hand 'Worker' to 'Coordinator'?")).toBeTruthy();
    expect(document.body.textContent).toContain("Daintree doesn't filter what it sends");
    expect(document.body.textContent).toContain("can't close the terminal");
  });

  it("hands over and closes on confirm", async () => {
    adoptTerminal.mockResolvedValue({
      status: "handed-over",
      adoption: { terminalId: "terminal-1", orchestratorPaneId: "pane-orch", adoptedAt: 1 },
    });
    const onClose = vi.fn();
    render(
      <TerminalHandOverDialog
        terminalId="terminal-1"
        orchestratorPaneId="pane-orch"
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Hand over terminal" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(adoptTerminal).toHaveBeenCalledWith({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-orch",
    });
  });

  it("stays open with the reason when main refuses, and names who holds the terminal", async () => {
    adoptTerminal.mockResolvedValue({
      status: "refused",
      reason: "already-handed",
      heldByPaneId: "pane-other",
    });
    const onClose = vi.fn();
    render(
      <TerminalHandOverDialog
        terminalId="terminal-1"
        orchestratorPaneId="pane-orch"
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Hand over terminal" }));

    await waitFor(() =>
      expect(document.body.textContent).toContain("Already handed to Reviewer. Take it back first.")
    );
    expect(onClose).not.toHaveBeenCalled();
    // Nothing about asking again would change the answer, so it can't be sent.
    const confirm = screen.getByRole("button", { name: "Hand over terminal" });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(confirm);
    expect(adoptTerminal).toHaveBeenCalledTimes(1);
  });

  it("reports a failed call instead of throwing it away", async () => {
    adoptTerminal.mockRejectedValue(new Error("ipc down"));
    render(
      <TerminalHandOverDialog
        terminalId="terminal-1"
        orchestratorPaneId="pane-orch"
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Hand over terminal" }));

    await waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't hand the terminal over")
    );
  });
});

describe("TerminalDrivenByBadge", () => {
  it("renders nothing for a terminal nobody was handed", () => {
    const { container } = render(<TerminalDrivenByBadge terminalId="terminal-1" />);
    expect(container.textContent).toBe("");
  });

  it("names the pane driving the terminal, and goes when it is taken back", () => {
    handTo("pane-orch");
    render(
      <TooltipProvider>
        <TerminalDrivenByBadge terminalId="terminal-1" />
      </TooltipProvider>
    );

    expect(screen.getByTestId("terminal-driven-by-badge").textContent).toBe(
      "Driven by Coordinator"
    );

    act(() => useTerminalAdoptionStore.getState().applyAdoptions([]));
    expect(screen.queryByTestId("terminal-driven-by-badge")).toBeNull();
  });
});
