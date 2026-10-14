// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act, render, fireEvent } from "@testing-library/react";
import { dispatchEscape, registerEscape } from "@/lib/escapeStack";
import { describe, expect, it, vi } from "vitest";

// The app root supplies the TooltipProvider. The trigger renders its child
// as-is; the content is dropped so tooltip text can't collide with queries.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

// Same pass-through mock as PanelHeader.test.tsx — the Radix dropdown is
// lazily loaded (radix-loader) and irrelevant here; these tests cover the
// header's own wiring (which items render, what they invoke), not Radix.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div data-testid="menu-root" data-open={open ? "true" : "false"}>
      <button type="button" data-testid="menu-open" onClick={() => onOpenChange?.(true)} />
      {children}
    </div>
  ),
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
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    disabled,
    onCheckedChange,
    "aria-describedby": describedBy,
    "aria-labelledby": labelledBy,
  }: {
    children: ReactNode;
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    "aria-describedby"?: string;
    "aria-labelledby"?: string;
  }) => (
    <button
      role="menuitemcheckbox"
      aria-describedby={describedBy}
      aria-labelledby={labelledBy}
      aria-checked={checked ? "true" : "false"}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
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
      canRestartConversation={false}
      canEndSession={false}
      onRestartConversation={vi.fn()}
      onEndSession={vi.fn()}
      onResumePastSession={vi.fn()}
      onOpenDocs={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

describe("HelpPanelHeader", () => {
  it("closes an open overflow menu, not the panel beneath it, on Escape", () => {
    const { getByTestId } = renderHeader();
    // The assistant panel registers its own close on the stack first.
    const closePanel = vi.fn();
    const panelEntry = registerEscape(closePanel);
    try {
      fireEvent.click(getByTestId("menu-open"));
      expect(getByTestId("menu-root").getAttribute("data-open")).toBe("true");
      act(() => {
        dispatchEscape();
      });
      expect(getByTestId("menu-root").getAttribute("data-open")).toBe("false");
      expect(closePanel).not.toHaveBeenCalled();
    } finally {
      panelEntry.unregister();
    }
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

  it("carries no control that could be read as adding a session", () => {
    // The header's "+" restarted the current conversation while the strip a row below
    // opened a new one. Two plus-shaped affordances a few pixels apart doing different
    // things is the confusion this header now exists without.
    const { container } = renderHeader({ canRestartConversation: true, canEndSession: true });
    const labels = [...container.firstElementChild!.children]
      .filter((el) => el.tagName === "BUTTON")
      .map((el) => el.getAttribute("aria-label"));

    expect(labels).toEqual(["Hide Daintree Assistant"]);
  });

  it("draws no state marker of its own — the strip owns per-lane state", () => {
    // The header and the active tab used to draw the same 14px glyph for the same lane,
    // one row apart. The state is still ANNOUNCED here, because a description on a tab
    // is read when the tab takes focus and not when the state changes.
    const { container, getByTestId } = renderHeader({ agentState: "working" });

    expect(container.querySelector(".animate-spin-slow")).toBeNull();
    const announcer = getByTestId("assistant-header-state-announcer");
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.className).toContain("sr-only");
    expect(announcer.textContent).toBe("Assistant is working");
  });

  it("names the restart item for the conversation it discards", () => {
    const onRestartConversation = vi.fn();
    const { getByText, queryByText } = renderHeader({
      canRestartConversation: true,
      onRestartConversation,
    });

    // Never "new session" — that is the strip's "+", and it does close to the opposite.
    expect(queryByText("Start new session")).toBeNull();
    // And never mirrored here: the strip's "+" is that action's single home.
    expect(queryByText("Open parallel session")).toBeNull();

    fireEvent.click(getByText("Restart conversation"));
    expect(onRestartConversation).toHaveBeenCalledTimes(1);
  });

  it("hides the restart item when there is no conversation to restart", () => {
    const { queryByText } = renderHeader({ canRestartConversation: false });
    expect(queryByText("Restart conversation")).toBeNull();
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

  it("offers resuming a past session from the overflow menu, not the header row", () => {
    const onResumePastSession = vi.fn();
    const { container, getByText } = renderHeader({ onResumePastSession });

    const overflow = container.querySelector("[data-testid='overflow-menu']")!;
    const item = [...overflow.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Resume a past session…")
    );
    expect(item).toBeDefined();

    fireEvent.click(getByText("Resume a past session…"));
    expect(onResumePastSession).toHaveBeenCalledTimes(1);
  });

  describe("messaging between machines", () => {
    const controls = (
      overrides: Partial<NonNullable<ComponentProps<typeof HelpPanelHeader>["messaging"]>> = {}
    ) => ({
      enrolled: false,
      canChangeEnrollment: true,
      enrollmentHint: null,
      paused: false,
      canPause: true,
      pauseHint: null,
      onEnrolledChange: vi.fn(),
      onPausedChange: vi.fn(),
      ...overrides,
    });
    const items = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[role="menuitemcheckbox"]')) as HTMLButtonElement[];

    it("offers nothing while there's no host or the platform has no messaging", () => {
      const { container } = renderHeader({ messaging: null });
      expect(items(container)).toHaveLength(0);
    });

    it("keeps both labels the same whatever the state, carrying it in the check", () => {
      const off = renderHeader({ messaging: controls() });
      const offLabels = items(off.container).map((item) => item.textContent);
      const offChecks = items(off.container).map((item) => item.getAttribute("aria-checked"));
      off.unmount();
      const on = renderHeader({ messaging: controls({ enrolled: true, paused: true }) });
      expect(items(on.container).map((item) => item.textContent)).toEqual(offLabels);
      expect(offChecks).toEqual(["false", "false"]);
      expect(items(on.container).map((item) => item.getAttribute("aria-checked"))).toEqual([
        "true",
        "true",
      ]);
    });

    it("hands each toggle's new value to its own handler", () => {
      const messaging = controls({ paused: true });
      const { container } = renderHeader({ messaging });
      const [accept, pause] = items(container);
      fireEvent.click(accept!);
      fireEvent.click(pause!);
      expect(messaging.onEnrolledChange).toHaveBeenCalledWith(true);
      expect(messaging.onPausedChange).toHaveBeenCalledWith(false);
    });

    it("disables what this window can't change, and says why under the unchanged label", () => {
      const { container } = renderHeader({
        messaging: controls({
          canChangeEnrollment: false,
          enrollmentHint: "Start this assistant first",
          canPause: false,
          pauseHint: "Change this on the machine running it",
        }),
      });
      const toggles = items(container);
      expect(toggles.map((item) => item.disabled)).toEqual([true, true]);
      for (const [item, hint] of [
        [toggles[0]!, "Start this assistant first"],
        [toggles[1]!, "Change this on the machine running it"],
      ] as const) {
        const describedBy = item.getAttribute("aria-describedby");
        expect(describedBy).toBeTruthy();
        expect(container.querySelector(`[id="${describedBy}"]`)?.textContent).toBe(hint);
        // The hint describes the toggle; its name stays the fixed label.
        const labelledBy = item.getAttribute("aria-labelledby");
        expect(container.querySelector(`[id="${labelledBy}"]`)?.textContent).not.toContain(hint);
      }
    });
  });
});
