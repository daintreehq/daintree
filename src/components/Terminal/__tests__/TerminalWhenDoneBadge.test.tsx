// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTerminalWhenDoneStore } from "@/store/terminalWhenDoneStore";
import { TerminalWhenDoneBadge } from "../TerminalWhenDoneBadge";

function renderBadge(terminalId = "terminal-1") {
  return render(
    <TooltipProvider>
      <TerminalWhenDoneBadge terminalId={terminalId} />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  useTerminalWhenDoneStore.setState({ choices: {} });
});

describe("TerminalWhenDoneBadge (#16171)", () => {
  it("shows nothing on a pane that isn't armed", () => {
    useTerminalWhenDoneStore.setState({ choices: { "terminal-2": "close" } });
    renderBadge();
    expect(screen.queryByTestId("terminal-when-done-badge")).toBeNull();
  });

  it("names what the pane will do, and goes when main disarms it", () => {
    useTerminalWhenDoneStore.setState({ choices: { "terminal-1": "background" } });
    renderBadge();
    expect(screen.getByTestId("terminal-when-done-badge").dataset.whenDone).toBe("background");

    act(() =>
      useTerminalWhenDoneStore.getState().applyChange({ terminalId: "terminal-1", choice: "close" })
    );
    expect(screen.getByTestId("terminal-when-done-badge").dataset.whenDone).toBe("close");

    act(() =>
      useTerminalWhenDoneStore.getState().applyChange({ terminalId: "terminal-1", choice: "keep" })
    );
    expect(screen.queryByTestId("terminal-when-done-badge")).toBeNull();
  });
});
