// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalTab } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabButton } from "@/components/Panel/TabButton";
import { PortalToolbar } from "@/components/Portal/PortalToolbar";
import { HelpSessionTabs } from "@/components/HelpPanel/HelpSessionTabs";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { documentTabClassName } from "../document-tab";

// Each tab and session row owns a TerminalContextMenu, which reads the worktree
// store; its scoping is pinned in its own suite, so it is a passthrough here.
vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children?: unknown }) => <>{children as never}</>,
}));

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
  useOverlayClaim: () => {},
}));

/**
 * The document tab family: grid and dock (TabButton), portal and assistant strips.
 *
 * What is pinned is the rule that they are ONE control — every host draws its tabs from
 * the shared module and honours the same keyboard contract — not the tokens the module
 * happens to use today, which are expected to move.
 */

const PORTAL_TABS: PortalTab[] = [
  { id: "a", url: "https://claude.ai/", title: "Claude", icon: "claude" },
  { id: "b", url: "https://chatgpt.com/", title: "ChatGPT", icon: "codex" },
];

const withTooltips = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

const STRIPS: Array<[string, () => HTMLElement]> = [
  [
    "grid/dock (TabButton)",
    () =>
      withTooltips(
        <div role="tablist">
          {[true, false].map((isActive, i) => (
            <TabButton
              key={i}
              id={`t${i}`}
              title={`Tab ${i}`}
              chrome={deriveTerminalChrome()}
              kind="terminal"
              isActive={isActive}
              tabPanelId="body"
              onClick={vi.fn()}
              onClose={vi.fn()}
            />
          ))}
        </div>
      ).container,
  ],
  [
    "portal",
    () =>
      withTooltips(
        <PortalToolbar
          tabs={PORTAL_TABS}
          activeTabId="a"
          onTabClick={vi.fn()}
          onTabClose={vi.fn()}
          onNewTab={vi.fn()}
          defaultNewTabUrl={null}
          onClose={vi.fn()}
          enabledLinks={[]}
        />
      ).container.querySelector<HTMLElement>('[role="tablist"]')!,
  ],
  [
    "assistant",
    () =>
      withTooltips(
        <HelpSessionTabs
          tabs={[
            { slot: 0, label: "Session 1", agentState: undefined },
            { slot: 1, label: "Session 2", agentState: "working" },
          ]}
          activeSlot={0}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onOpenSession={vi.fn()}
          canOpenSession
          idBase="s"
          panelId="body"
        />
      ).container,
  ],
];

afterEach(() => cleanup());

describe.each(STRIPS)("document tab family — %s", (_name, mount) => {
  const tabsIn = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));

  it("draws every tab from the shared look, selected and not", () => {
    const tabs = tabsIn(mount());
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    for (const tab of tabs) {
      expect(tab.hasAttribute("data-document-tab")).toBe(true);
      const selected = tab.getAttribute("aria-selected") === "true";
      for (const cls of documentTabClassName(selected).split(/\s+/)) {
        expect(tab.classList.contains(cls)).toBe(true);
      }
    }
  });

  it("marks only the selected tab, with the family's indicator", () => {
    const tabs = tabsIn(mount());
    const marked = tabs.filter((t) => t.querySelector("[data-document-tab-indicator]"));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps one tab stop, on the selected tab", () => {
    const stops = tabsIn(mount()).filter((t) => t.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("points every tab at the region it switches and advertises Delete", () => {
    for (const tab of tabsIn(mount())) {
      expect(tab.getAttribute("aria-controls")).toBeTruthy();
      expect(tab.getAttribute("aria-keyshortcuts")).toBe("Delete");
    }
  });

  it("gives every tab one pointer-only close control", () => {
    for (const tab of tabsIn(mount())) {
      const closers = tab.querySelectorAll<HTMLElement>("[data-document-tab-close]");
      expect(closers).toHaveLength(1);
      expect(closers[0]!.tabIndex).toBe(-1);
      expect(closers[0]!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("uses the app tooltip, never a native title", () => {
    expect(mount().querySelector("[title]")).toBeNull();
  });
});
