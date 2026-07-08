// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

// Same pass-through mock as PanelHeader.test.tsx — the Radix dropdown is
// lazily loaded (radix-loader) and irrelevant here; these tests cover the
// header's own wiring (which items render, what they invoke), not Radix.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode; className?: string }) => (
    <div data-testid="overflow-menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    destructive,
  }: {
    children: ReactNode;
    onSelect?: (e: Event) => void;
    destructive?: boolean;
  }) => (
    <button
      data-destructive={destructive || undefined}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

import { HelpPanelHeader } from "../HelpPanelHeader";

function renderHeader(overrides: Partial<ComponentProps<typeof HelpPanelHeader>> = {}) {
  return render(
    <HelpPanelHeader
      agentState={null}
      canStartNewSession={false}
      canEndSession={false}
      onNewSession={vi.fn()}
      onEndSession={vi.fn()}
      onOpenDocs={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

describe("HelpPanelHeader", () => {
  it("renders identically when unfocused and when isFocused is omitted", () => {
    const { container: a } = renderHeader({ isFocused: false });
    const { container: b } = renderHeader({ isFocused: undefined });

    expect(a.firstElementChild!.className).toBe(b.firstElementChild!.className);
  });

  it("applies focused-state styling distinct from unfocused", () => {
    const { container: unfocused } = renderHeader({ isFocused: false });
    const { container: focused } = renderHeader({ isFocused: true });

    // The exact tokens are a design decision and may shift; we only verify
    // that focused vs unfocused render differently and that the focused
    // state stays neutral (no accent — accent is reserved for the macro
    // focus anchor per CLAUDE.md accent-restraint rules).
    expect(focused.firstElementChild!.className).not.toBe(unfocused.firstElementChild!.className);
    expect([...focused.firstElementChild!.classList].some((c) => c.includes("accent"))).toBe(false);
  });

  it("keeps the primary header row to new-session, overflow, and hide", () => {
    const { container, getByLabelText } = renderHeader({
      canStartNewSession: true,
      canEndSession: true,
    });

    expect(getByLabelText("Start new session")).not.toBeNull();
    expect(getByLabelText("More actions")).not.toBeNull();
    expect(getByLabelText("Hide Daintree Assistant")).not.toBeNull();
    // Stop and docs are overflow items, never dedicated header icons — the
    // destructive stop must not sit adjacent to the benign hide chevron.
    const overflow = container.querySelector("[data-testid='overflow-menu']")!;
    const stop = [...overflow.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Stop assistant")
    );
    const docs = [...overflow.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Open docs")
    );
    expect(stop).toBeDefined();
    expect(docs).toBeDefined();
  });

  it("shows the Stop assistant item only when canEndSession is true", () => {
    const { queryByText: without } = renderHeader({ canEndSession: false });
    expect(without("Stop assistant")).toBeNull();

    const { queryByText: withStop } = renderHeader({ canEndSession: true });
    expect(withStop("Stop assistant")).not.toBeNull();
  });

  it("marks the Stop assistant item destructive", () => {
    const { getByText } = renderHeader({ canEndSession: true });
    expect(getByText("Stop assistant").closest("button")!.dataset.destructive).toBe("true");
  });

  it("invokes onEndSession when Stop assistant is selected", () => {
    const onEndSession = vi.fn();
    const { getByText } = renderHeader({ canEndSession: true, onEndSession });

    fireEvent.click(getByText("Stop assistant"));

    expect(onEndSession).toHaveBeenCalledTimes(1);
  });

  it("invokes onOpenDocs when Open docs is selected", () => {
    const onOpenDocs = vi.fn();
    const { getByText } = renderHeader({ onOpenDocs });

    fireEvent.click(getByText("Open docs"));

    expect(onOpenDocs).toHaveBeenCalledTimes(1);
  });
});
