// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { QuickSwitcherItem as QuickSwitcherItemData } from "@/hooks/useQuickSwitcher";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useEscapeStack: () => {},
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "",
  useEffectiveCombo: () => undefined,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-testid="terminal-icon" />,
}));

vi.mock("@/components/icons", () => ({
  FolderGit2: () => <span data-testid="folder-icon" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { QuickSwitcher } from "./QuickSwitcher";

const terminalItem: QuickSwitcherItemData = {
  id: "terminal:t1",
  type: "terminal",
  title: "zsh",
  subtitle: "main",
  terminalKind: "shell",
};

const worktreeItem: QuickSwitcherItemData = {
  id: "worktree:wt1",
  type: "worktree",
  title: "feature-branch",
  subtitle: "/path/to/wt",
};

interface RenderArgs {
  results: QuickSwitcherItemData[];
  selectedIndex: number;
}

function renderQuickSwitcher({ results, selectedIndex }: RenderArgs) {
  return render(
    <QuickSwitcher
      isOpen
      query=""
      results={results}
      totalResults={results.length}
      selectedIndex={selectedIndex}
      isLoading={false}
      close={() => {}}
      setQuery={() => {}}
      setSelectedIndex={() => {}}
      selectPrevious={() => {}}
      selectNext={() => {}}
      selectItem={() => {}}
      confirmSelection={() => {}}
    />
  );
}

describe("QuickSwitcher dynamic footer hint", () => {
  it("shows 'to switch terminal' when a terminal row is selected", () => {
    renderQuickSwitcher({ results: [terminalItem, worktreeItem], selectedIndex: 0 });

    expect(screen.getByText("to switch terminal")).toBeTruthy();
    expect(screen.queryByText("to switch worktree")).toBeNull();
  });

  it("shows 'to switch worktree' when a worktree row is selected", () => {
    renderQuickSwitcher({ results: [terminalItem, worktreeItem], selectedIndex: 1 });

    expect(screen.getByText("to switch worktree")).toBeTruthy();
    expect(screen.queryByText("to switch terminal")).toBeNull();
  });

  it("drops the footer entirely when results are empty", () => {
    renderQuickSwitcher({ results: [], selectedIndex: -1 });

    // Nothing is selected, so there is no action to name — and a footer with
    // nothing contextual to say has no reason to occupy a bordered band.
    //
    // Asserted on the contextual text rather than on `kbd` anywhere in the
    // document: this palette also renders a header shortcut chip, which only
    // stays invisible here because the keybinding hooks are mocked empty. The
    // wrapper's own absence is covered directly in AppPaletteDialog.test.tsx.
    expect(screen.queryByText("to select")).toBeNull();
    expect(screen.queryByText("to switch terminal")).toBeNull();
    expect(screen.queryByText("to switch worktree")).toBeNull();
  });

  it("updates the footer when selection moves between item types", () => {
    const props = {
      isOpen: true,
      query: "",
      results: [terminalItem, worktreeItem],
      totalResults: 2,
      isLoading: false,
      close: () => {},
      setQuery: () => {},
      setSelectedIndex: () => {},
      selectPrevious: () => {},
      selectNext: () => {},
      selectItem: () => {},
      confirmSelection: () => {},
    };

    const { rerender } = render(<QuickSwitcher {...props} selectedIndex={0} />);
    expect(screen.getByText("to switch terminal")).toBeTruthy();

    rerender(<QuickSwitcher {...props} selectedIndex={1} />);
    expect(screen.getByText("to switch worktree")).toBeTruthy();
    expect(screen.queryByText("to switch terminal")).toBeNull();
  });

  it("removes the footer when results transition from populated to empty", () => {
    const baseProps = {
      isOpen: true,
      query: "",
      totalResults: 0,
      isLoading: false,
      close: () => {},
      setQuery: () => {},
      setSelectedIndex: () => {},
      selectPrevious: () => {},
      selectNext: () => {},
      selectItem: () => {},
      confirmSelection: () => {},
    };

    const { rerender } = render(
      <QuickSwitcher {...baseProps} results={[terminalItem]} selectedIndex={0} />
    );
    expect(screen.getByText("to switch terminal")).toBeTruthy();

    rerender(<QuickSwitcher {...baseProps} results={[]} selectedIndex={-1} />);
    expect(screen.queryByText("to switch terminal")).toBeNull();
    expect(screen.queryByText("to select")).toBeNull();
  });

  it("wires aria-describedby on each row to the footer hint id", () => {
    renderQuickSwitcher({ results: [terminalItem, worktreeItem], selectedIndex: 0 });

    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(2);

    const describedBy = options[0]!.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(options[1]!.getAttribute("aria-describedby")).toBe(describedBy);

    const hintEl = document.getElementById(describedBy!);
    expect(hintEl).not.toBeNull();
    expect(hintEl?.textContent).toContain("to switch terminal");
  });

  it("does not render an aria-live region", () => {
    renderQuickSwitcher({
      results: [terminalItem, worktreeItem],
      selectedIndex: 0,
    });

    // Scope the assertion to the footer container — the dialog itself mounts
    // an AccessibilityAnnouncer with two aria-live sr-only divs (intentional;
    // VoiceOver suppresses aria-live outside the focused aria-modal subtree).
    const listbox = screen.getByRole("listbox");
    const firstOption = within(listbox).getAllByRole("option")[0]!;
    const footerHintId = firstOption.getAttribute("aria-describedby");
    expect(footerHintId).toBeTruthy();
    const footerContainer = document.getElementById(footerHintId!);
    expect(footerContainer).not.toBeNull();
    expect(footerContainer?.querySelector("[aria-live]")).toBeNull();
  });
});
