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
    disabled,
  }: {
    children: ReactNode;
    onSelect?: (e: Event) => void;
    destructive?: boolean;
    disabled?: boolean;
  }) => (
    <button
      data-destructive={destructive || undefined}
      disabled={disabled}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: ReactNode;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      role="menuitemcheckbox"
      aria-checked={checked === true}
      onClick={() => onCheckedChange?.(!checked)}
    >
      {children}
    </button>
  ),
}));

import { HelpPanelHeader, summarizeLaneActivity } from "../HelpPanelHeader";

function renderHeader(overrides: Partial<ComponentProps<typeof HelpPanelHeader>> = {}) {
  return render(
    <HelpPanelHeader
      agentState={null}
      scope="project"
      onScopeChange={vi.fn()}
      canRestartConversation={false}
      canEndSession={false}
      onRestartConversation={vi.fn()}
      onEndSession={vi.fn()}
      onResumePastSession={vi.fn()}
      onOpenDocs={vi.fn()}
      autoLaunchEnabled={false}
      onAutoLaunchEnabledChange={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

describe("HelpPanelHeader", () => {
  it("switches scope from a named radio group in place of a title", () => {
    const onScopeChange = vi.fn();
    const { getByRole } = renderHeader({ onScopeChange });
    const group = getByRole("radiogroup", { name: "Assistant scope" });
    const [project, global] = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(project!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(global!);
    expect(onScopeChange).toHaveBeenCalledWith("global");
  });

  it("hands the menu slot to the global run while Global is shown", () => {
    const { queryByTestId, getByTestId } = renderHeader({
      scope: "global",
      canRestartConversation: true,
      canEndSession: true,
    });
    expect(queryByTestId("menu-root")).toBeNull();
    expect(getByTestId("assistant-global-controls")).not.toBeNull();
  });

  it("marks the Project option with background lane activity only while Global is shown", () => {
    const activity = summarizeLaneActivity([
      { label: "Session 1", agentState: "working" },
      { label: "Session 2", agentState: "directing" },
      { label: "Session 3", agentState: null },
    ]);
    expect(activity).toEqual({
      agentState: "directing",
      summary: "Session 1 working, Session 2 directing",
    });

    const { getByTestId, rerender } = renderHeader({ scope: "global", projectActivity: activity });
    const project = getByTestId("assistant-scope-project");
    expect(project.getAttribute("aria-label")).toBe(
      "Project, Session 1 working, Session 2 directing"
    );

    rerender(
      <HelpPanelHeader
        agentState={null}
        scope="project"
        onScopeChange={vi.fn()}
        projectActivity={activity}
        canRestartConversation={false}
        canEndSession={false}
        onRestartConversation={vi.fn()}
        onEndSession={vi.fn()}
        onResumePastSession={vi.fn()}
        onOpenDocs={vi.fn()}
        autoLaunchEnabled={false}
        onAutoLaunchEnabledChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(getByTestId("assistant-scope-project").getAttribute("aria-label")).toBeNull();
  });

  it("marks the Global option with the global run's observed state only while Project is shown", () => {
    const activity = summarizeLaneActivity([
      { label: "Global assistant", agentState: "directing" },
    ]);
    const { getByTestId, rerender } = renderHeader({ scope: "project", globalActivity: activity });
    const global = getByTestId("assistant-scope-global");
    expect(global.getAttribute("aria-label")).toBe("Global, Global assistant directing");
    expect(global.querySelector("svg")).not.toBeNull();
    expect(getByTestId("assistant-scope-project").getAttribute("aria-label")).toBeNull();

    rerender(
      <HelpPanelHeader
        agentState={null}
        scope="global"
        onScopeChange={vi.fn()}
        globalActivity={activity}
        canRestartConversation={false}
        canEndSession={false}
        onRestartConversation={vi.fn()}
        onEndSession={vi.fn()}
        onResumePastSession={vi.fn()}
        onOpenDocs={vi.fn()}
        autoLaunchEnabled={false}
        onAutoLaunchEnabledChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(getByTestId("assistant-scope-global").getAttribute("aria-label")).toBeNull();
    expect(getByTestId("assistant-scope-global").querySelector("svg")).toBeNull();
  });

  it("summarizes nothing when no lane reports a state", () => {
    expect(summarizeLaneActivity([{ label: "Session 1", agentState: null }])).toBeNull();
  });

  // No Canopy reading ever covers an assistant, so a lane at its prompt asks
  // nothing: it is neither named waiting nor marked on the other scope (#16059).
  it("never names or marks a lane at its prompt as waiting", () => {
    expect(
      summarizeLaneActivity([
        { label: "Session 1", agentState: "waiting" },
        { label: "Session 2", agentState: "idle" },
      ])
    ).toBeNull();
    expect(
      summarizeLaneActivity([
        { label: "Session 1", agentState: "waiting" },
        { label: "Session 2", agentState: "working" },
      ])
    ).toEqual({ agentState: "working", summary: "Session 2 working" });
  });

  it("announces nothing for a lane at its prompt", () => {
    const { getByTestId } = renderHeader({ agentState: "waiting" });
    const announcer = getByTestId("assistant-header-state-announcer");
    expect(announcer.textContent).toBe("");
    expect(announcer.getAttribute("data-agent-state")).toBe("waiting");
  });

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

  describe("auto-start on open (#14976)", () => {
    it("shows whether opening starts a session, under a label that never changes", () => {
      const onAutoLaunchEnabledChange = vi.fn();
      const off = renderHeader({ autoLaunchEnabled: false, onAutoLaunchEnabledChange });
      const unchecked = off.getByRole("menuitemcheckbox", { name: "Start when the panel opens" });
      expect(unchecked.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(unchecked);
      expect(onAutoLaunchEnabledChange).toHaveBeenLastCalledWith(true);
      off.unmount();

      const on = renderHeader({ autoLaunchEnabled: true, onAutoLaunchEnabledChange });
      const checked = on.getByRole("menuitemcheckbox", { name: "Start when the panel opens" });
      expect(checked.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(checked);
      expect(onAutoLaunchEnabledChange).toHaveBeenLastCalledWith(false);
    });

    it("is there with or without a session, and only in the project scope", () => {
      const idle = renderHeader({ canRestartConversation: false, canEndSession: false });
      expect(idle.queryByRole("menuitemcheckbox")).not.toBeNull();
      idle.unmount();

      const live = renderHeader({ canRestartConversation: true, canEndSession: true });
      expect(live.queryByRole("menuitemcheckbox")).not.toBeNull();
      live.unmount();

      const global = renderHeader({ scope: "global" });
      expect(global.queryByRole("menuitemcheckbox")).toBeNull();
    });
  });

  describe("new session on a named agent (#13442)", () => {
    const menuItems = (container: HTMLElement) => [
      ...container.querySelectorAll<HTMLButtonElement>("[data-testid='overflow-menu'] > button"),
    ];

    it("lists every agent that can run the assistant, ahead of resuming a past session", () => {
      const onNewSessionWithAgent = vi.fn();
      const { container } = renderHeader({
        newSessionAgentIds: ["claude", "codex"],
        canStartNewSession: true,
        onNewSessionWithAgent,
      });
      const names = menuItems(container).map((item) => item.textContent);
      expect(names.slice(0, 3)).toEqual([
        "New session with Claude",
        "New session with Codex",
        "Resume a past session…",
      ]);
      fireEvent.click(menuItems(container)[1]!);
      expect(onNewSessionWithAgent).toHaveBeenCalledWith("codex");
    });

    it("offers nothing to choose with one agent, and parks the items at the ceiling", () => {
      const { container: single } = renderHeader({
        newSessionAgentIds: ["claude"],
        canStartNewSession: true,
        onNewSessionWithAgent: vi.fn(),
      });
      expect(
        menuItems(single).some((item) => item.textContent?.startsWith("New session with"))
      ).toBe(false);

      const { container: full } = renderHeader({
        newSessionAgentIds: ["claude", "codex"],
        canStartNewSession: false,
        onNewSessionWithAgent: vi.fn(),
      });
      const agentItems = menuItems(full).filter((item) =>
        item.textContent?.startsWith("New session with")
      );
      expect(agentItems.map((item) => item.disabled)).toEqual([true, true]);
    });
  });
});
