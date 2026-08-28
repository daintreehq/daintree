// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { dispatchEscape, _resetForTests } from "@/lib/escapeStack";

const { dispatchMock, useReducedMotionMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(() => Promise.resolve()),
  useReducedMotionMock: vi.fn(() => false),
}));

vi.mock("@/components/ui/radix-loader", () => ({
  useRadixPrimitives: () => null,
  primeOnEvent: () => {},
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("framer-motion", () => ({
  useReducedMotion: useReducedMotionMock,
}));

import { GettingStartedChecklist } from "../GettingStartedChecklist";
import type { ChecklistState } from "@shared/types/ipc/maps";

const allIncomplete: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: {
    openedProject: false,
    launchedAgent: false,
    createdWorktree: false,
    ranSecondParallelAgent: false,
  },
};

const allComplete: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: {
    openedProject: true,
    launchedAgent: true,
    createdWorktree: true,
    ranSecondParallelAgent: true,
  },
};

const mixedState: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: {
    openedProject: true,
    launchedAgent: false,
    createdWorktree: false,
    ranSecondParallelAgent: false,
  },
};

describe("GettingStartedChecklist", () => {
  const defaultProps = {
    collapsed: false,
    onDismiss: vi.fn(),
    onToggleCollapse: vi.fn(),
    onMarkItem: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it("renders incomplete steps as buttons", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    const buttons = screen.getAllByRole("button", {
      name: /open your project|ask ai to help with your code|start a parallel task|run two agents in parallel/i,
    });
    expect(buttons).toHaveLength(4);
  });

  it("renders completed steps as non-interactive divs that still show labels", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allComplete} />);

    const stepButtons = screen.queryAllByRole("button", {
      name: /open your project|ask ai to help with your code|start a parallel task|run two agents in parallel/i,
    });
    expect(stepButtons).toHaveLength(0);

    expect(screen.getByText("Open your project")).toBeTruthy();
    expect(screen.getByText("Ask AI to help with your code")).toBeTruthy();
    expect(screen.getByText("Start a parallel task")).toBeTruthy();
    expect(screen.getByText("Run two agents in parallel")).toBeTruthy();
  });

  it("renders mixed state correctly — only incomplete steps are buttons", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={mixedState} />);

    const stepButtons = screen.getAllByRole("button", {
      name: /ask ai to help with your code|start a parallel task|run two agents in parallel/i,
    });
    expect(stepButtons).toHaveLength(3);

    const completedButton = screen.queryByRole("button", { name: /open your project/i });
    expect(completedButton).toBeNull();
  });

  it("dispatches project.add when 'Open your project' is clicked", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /open your project/i }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("project.add", undefined, { source: "user" });
  });

  it("dispatches panel.palette when 'Ask AI to help with your code' is clicked", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /ask ai to help with your code/i }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("panel.palette", undefined, { source: "user" });
  });

  it("dispatches worktree.createDialog.open when 'Start a parallel task' is clicked", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /start a parallel task/i }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("worktree.createDialog.open", undefined, {
      source: "user",
    });
  });

  it("dispatches panel.palette when 'Run two agents in parallel' is clicked and does NOT mark the item (auto-marked by useGettingStartedChecklist when 2+ agents run concurrently)", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /run two agents in parallel/i }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("panel.palette", undefined, {
      source: "user",
    });
    expect(defaultProps.onMarkItem).not.toHaveBeenCalled();
  });

  it("does not call onMarkItem for non-markOnClick items", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /open your project/i }));
    expect(defaultProps.onMarkItem).not.toHaveBeenCalled();
  });

  it("does not call onDismiss or onToggleCollapse when a step is clicked", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /open your project/i }));
    expect(defaultProps.onDismiss).not.toHaveBeenCalled();
    expect(defaultProps.onToggleCollapse).not.toHaveBeenCalled();
  });

  it("renders the endowed n/n counter while the checklist is incomplete", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={mixedState} />);
    // 1 real item done + the always-complete "Install Daintree" row, over 4+1.
    expect(screen.getByText("2/5")).toBeTruthy();
    expect(screen.queryByText("All set")).toBeNull();
  });

  it("renders the 'All set' milestone label when every item is complete", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allComplete} />);
    expect(screen.getByText("All set")).toBeTruthy();
    expect(screen.queryByText("5/5")).toBeNull();
  });

  it("renders the endowed 'Install Daintree' row as a non-interactive div", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
    expect(screen.getByText("Install Daintree")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /install daintree/i })).toBeNull();
  });

  describe("accessibility", () => {
    it("renders the card as a region landmark with accessible name", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
      const region = screen.getByRole("region", { name: "Getting started checklist" });
      expect(region).toBeTruthy();
    });

    it("collapse button announces expanded state and controls the body", () => {
      const { rerender } = render(
        <GettingStartedChecklist {...defaultProps} checklist={allIncomplete} collapsed={false} />
      );

      const toggle = screen.getByRole("button", { name: /getting started/i });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-controls")).toBe("getting-started-checklist-body");

      rerender(
        <GettingStartedChecklist {...defaultProps} checklist={allIncomplete} collapsed={true} />
      );
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("collapsible body has a stable id matching aria-controls", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
      const body = document.getElementById("getting-started-checklist-body");
      expect(body).toBeTruthy();
      expect(body!.tagName).toBe("DIV");
    });
  });

  describe("collapse toggle", () => {
    it("calls onToggleCollapse when header button is clicked", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
      const toggle = screen.getByRole("button", { name: /getting started/i });
      fireEvent.click(toggle);
      expect(defaultProps.onToggleCollapse).toHaveBeenCalledTimes(1);
    });
  });

  /** The unprefixed text-colour utility on an element, which is what "reads dimmer" means. */
  function textRole(className: string): string | undefined {
    return className.split(/\s+/).find((token) => /^text-text-[a-z]+$/.test(token));
  }

  describe("completed-state surface", () => {
    it("uses neutral elevated surface tokens and drops the accent tint when allComplete is true", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allComplete} />);
      const region = screen.getByRole("region", { name: "Getting started checklist" });
      expect(region.className).toContain("bg-surface-panel");
      expect(region.className).toContain("border-border-default");
      expect(region.className).not.toContain("color-mix");
    });

    it("keeps the accent-tinted surface when not all items are complete", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={mixedState} />);
      const region = screen.getByRole("region", { name: "Getting started checklist" });
      expect(region.className).toContain("color-mix");
      expect(region.className).not.toContain("bg-surface-panel");
    });

    it("accents the counter label on completion and mutes it otherwise", () => {
      const { rerender } = render(
        <GettingStartedChecklist {...defaultProps} checklist={mixedState} />
      );
      // The incomplete counter carries a neutral text role and no accent; the
      // complete one carries the accent and drops the neutral. Naming which
      // neutral would only copy the component, but the counter must have one —
      // deleting it entirely would let the label inherit primary and still
      // satisfy a bare "not accented" check.
      const muted = screen.getByText("2/5");
      expect(textRole(muted.className)).toBeDefined();
      expect(muted.className).not.toContain("text-accent-primary");

      rerender(<GettingStartedChecklist {...defaultProps} checklist={allComplete} />);
      const accented = screen.getByText("All set");
      expect(accented.className).toContain("text-accent-primary");
      expect(textRole(accented.className)).toBeUndefined();
    });
  });

  describe("dismiss button", () => {
    it("calls onDismiss when the dismiss button is clicked", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
      const dismissBtn = screen.getByRole("button", { name: "Dismiss checklist" });
      fireEvent.click(dismissBtn);
      expect(defaultProps.onDismiss).toHaveBeenCalledTimes(1);
    });

    it("does not call onToggleCollapse when dismiss button is clicked", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
      const dismissBtn = screen.getByRole("button", { name: "Dismiss checklist" });
      fireEvent.click(dismissBtn);
      expect(defaultProps.onToggleCollapse).not.toHaveBeenCalled();
    });
  });

  describe("Escape key", () => {
    it("calls onToggleCollapse when Escape is pressed while focus is inside the panel", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
      const region = screen.getByRole("region", { name: "Getting started checklist" });

      act(() => {
        region.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });

      act(() => {
        dispatchEscape();
      });

      expect(defaultProps.onToggleCollapse).toHaveBeenCalledTimes(1);
      expect(defaultProps.onDismiss).not.toHaveBeenCalled();
    });

    it("does nothing when Escape is pressed while focus is outside the panel", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

      act(() => {
        dispatchEscape();
      });

      expect(defaultProps.onToggleCollapse).not.toHaveBeenCalled();
      expect(defaultProps.onDismiss).not.toHaveBeenCalled();
    });

    it("does nothing when Escape is pressed after focus has left the panel", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
      const region = screen.getByRole("region", { name: "Getting started checklist" });

      act(() => {
        region.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });

      act(() => {
        region.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });

      act(() => {
        dispatchEscape();
      });

      expect(defaultProps.onToggleCollapse).not.toHaveBeenCalled();
      expect(defaultProps.onDismiss).not.toHaveBeenCalled();
    });

    it("cleans up its escape handler on unmount", () => {
      const { unmount } = render(
        <GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />
      );
      const region = screen.getByRole("region", { name: "Getting started checklist" });

      act(() => {
        region.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });

      unmount();

      act(() => {
        dispatchEscape();
      });

      expect(defaultProps.onToggleCollapse).not.toHaveBeenCalled();
    });
  });

  describe("tooltip structure", () => {
    it("preserves aria-expanded and aria-controls on the toggle button after tooltip wrapping", () => {
      render(
        <GettingStartedChecklist {...defaultProps} checklist={allIncomplete} collapsed={false} />
      );
      const toggle = screen.getByRole("button", { name: /getting started/i });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-controls")).toBe("getting-started-checklist-body");
    });

    it("preserves aria-label on the dismiss button after tooltip wrapping", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);
      const dismissBtn = screen.getByRole("button", { name: "Dismiss checklist" });
      expect(dismissBtn).toBeTruthy();
      expect(dismissBtn.getAttribute("aria-label")).toBe("Dismiss checklist");
    });
  });

  describe("check badge pop animation", () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(false);
    });

    it("does NOT apply animate-badge-bump on first render for already-complete items", () => {
      render(<GettingStartedChecklist {...defaultProps} checklist={allComplete} />);
      expect(document.body.querySelector(".animate-badge-bump")).toBeNull();
    });

    it("applies animate-badge-bump when an item transitions from incomplete to complete", () => {
      const { rerender } = render(
        <GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />
      );
      expect(document.body.querySelector(".animate-badge-bump")).toBeNull();

      rerender(<GettingStartedChecklist {...defaultProps} checklist={mixedState} />);
      expect(document.body.querySelector(".animate-badge-bump")).not.toBeNull();
    });

    it("skips the pop under prefers-reduced-motion even when an item ticks", () => {
      useReducedMotionMock.mockReturnValue(true);
      const { rerender } = render(
        <GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />
      );
      rerender(<GettingStartedChecklist {...defaultProps} checklist={mixedState} />);
      expect(document.body.querySelector(".animate-badge-bump")).toBeNull();
    });
  });
});
