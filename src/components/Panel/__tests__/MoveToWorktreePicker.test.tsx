// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";
import type { OrderBy } from "@/store/worktreeFilterStore";

const { worktreesRef, colorMapRef, prefsRef, dispatchMock, content } = vi.hoisted(() => ({
  worktreesRef: { current: [] as unknown[] },
  colorMapRef: { current: null as Record<string, string> | null },
  prefsRef: {
    current: {
      orderBy: "alpha" as OrderBy,
      groupByType: false,
      pinnedWorktrees: [] as string[],
      manualOrder: [] as string[],
    },
  },
  dispatchMock: vi.fn(),
  content: {
    props: {} as {
      onEscapeKeyDown?: (event: KeyboardEvent) => void;
      onCloseAutoFocus?: (event: Event) => void;
      [key: string]: unknown;
    },
    rootOpenChange: null as ((open: boolean) => void) | null,
  },
}));

vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({
  useSidebarWorktreeOrder: () => worktreesRef.current,
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => colorMapRef.current,
}));

vi.mock("@/store/worktreeFilterStore", () => ({
  useWorktreeFilterStore: (selector: (state: unknown) => unknown) => selector(prefsRef.current),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

// Radix is stubbed below the shell, as in the shell's own suite: the content
// renders unconditionally and its handlers are captured so Escape and
// close-autofocus can be driven exactly as Radix would drive them.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    content.rootOpenChange = onOpenChange ?? null;
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    className,
    onKeyDown,
    ...rest
  }: {
    children: ReactNode;
    className?: string;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    [key: string]: unknown;
  }) => {
    content.props = rest;
    return (
      <div
        role="dialog"
        aria-label={typeof rest["aria-label"] === "string" ? rest["aria-label"] : undefined}
        data-dock-popover-child={
          typeof rest["data-dock-popover-child"] === "string"
            ? rest["data-dock-popover-child"]
            : undefined
        }
        className={className}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    );
  },
}));

import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { DockPopoverChildProvider } from "@/components/ui/DockPopoverChildContext";
import { MoveToWorktreePicker } from "../MoveToWorktreePicker";

const createWorktree = (
  overrides: Partial<WorktreeState> & Pick<WorktreeState, "id" | "name">
): WorktreeState => ({
  worktreeId: overrides.id,
  path: `/repo/${overrides.name}`,
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: null,
  ...overrides,
});

const main = createWorktree({
  id: "w-main",
  name: "daintree",
  branch: "main",
  isMainWorktree: true,
});
const current = createWorktree({
  id: "w-current",
  name: "issue-12431",
  branch: "feature/issue-12431-add-systemprompt",
  issueNumber: 12431,
  issueTitle: "Add systemPrompt to agent launch",
});
const fromPr = createWorktree({
  id: "w-pr",
  name: "pr-12389",
  branch: "feature/issue-12389-panel-glyph",
  sourcePrNumber: 12389,
  prTitle: "Panel header agent glyph",
  linked: {
    providerId: "github",
    pr: {
      ref: {
        providerId: "github",
        owner: "daintreehq",
        repo: "daintree",
        number: 12389,
        rawData: null,
      },
      title: "Panel header agent glyph",
      url: "https://github.com/daintreehq/daintree/pull/12389",
      state: "open",
    },
  },
});
const restore = createWorktree({
  id: "w-restore",
  name: "restore-recovery-cwd",
  branch: "fix/restore-recovery-cwd",
});
const bump = createWorktree({
  id: "w-bump",
  name: "bump-electron-42",
  branch: "chore/bump-electron-42",
});
// Carries the issue's number in its branch without being linked to it.
const lookalike = createWorktree({
  id: "w-lookalike",
  name: "lookalike",
  branch: "chore/12431-lookalike",
});

const SIDEBAR_ORDER = [main, current, fromPr, restore, bump, lookalike];

interface HarnessProps {
  currentWorktreeId?: string;
  onOpenChange?: (open: boolean) => void;
  onPanelKeyDown?: (event: React.KeyboardEvent) => void;
  onPanelClick?: (event: React.MouseEvent) => void;
}

function Harness({
  currentWorktreeId = "w-current",
  onOpenChange,
  onPanelKeyDown,
  onPanelClick,
}: HarnessProps) {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    // Stands in for the panel the picker is a React child of.
    <div onKeyDown={onPanelKeyDown} onClick={onPanelClick}>
      <AppPalettePopover isOpen={open} onOpenChange={handleOpenChange} modal={true}>
        <button ref={anchorRef} type="button">
          More panel actions
        </button>
        <MoveToWorktreePicker
          panelId="panel-1"
          currentWorktreeId={currentWorktreeId}
          isOpen={open}
          onOpenChange={handleOpenChange}
          returnFocusRef={anchorRef}
        />
      </AppPalettePopover>
    </div>
  );
}

function searchInput(): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>('input[aria-label="Search worktrees"]');
  if (!element) throw new Error("search input not found");
  return element;
}

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function optionLabels(): string[] {
  return options().map((option) => option.querySelector("span.truncate")?.textContent ?? "");
}

function option(label: string): HTMLElement {
  const match = options().find(
    (candidate) => candidate.querySelector("span.truncate")?.textContent === label
  );
  if (!match) throw new Error(`option "${label}" not found`);
  return match;
}

function selectedLabel(): string | null {
  const selected = options().find(
    (candidate) => candidate.getAttribute("aria-selected") === "true"
  );
  return selected?.querySelector("span.truncate")?.textContent ?? null;
}

function type(value: string) {
  fireEvent.change(searchInput(), { target: { value } });
}

function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(searchInput(), { key, ...init });
}

/** Radix's dismissal, including the shell's veto: an unprevented Escape closes. */
function pressEscape() {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  act(() => {
    content.props.onEscapeKeyDown?.(event);
    if (!event.defaultPrevented) content.rootOpenChange?.(false);
  });
}

function fireCloseAutoFocus() {
  const event = new Event("closeAutoFocus", { cancelable: true });
  act(() => content.props.onCloseAutoFocus?.(event));
  return event;
}

function liveRegion(): string {
  return document.querySelector('[data-testid="move-picker-count"]')?.textContent ?? "";
}

beforeEach(() => {
  worktreesRef.current = SIDEBAR_ORDER;
  colorMapRef.current = null;
  prefsRef.current = { orderBy: "alpha", groupByType: false, pinnedWorktrees: [], manualOrder: [] };
  dispatchMock.mockReset();
  content.props = {};
  content.rootOpenChange = null;
});

describe("MoveToWorktreePicker", () => {
  describe("rows", () => {
    it("lists every worktree in the sidebar's order under the sidebar's titles", () => {
      render(<Harness />);

      expect(optionLabels()).toEqual([
        "daintree",
        "#12431 Add systemPrompt to agent launch",
        "#12389 Panel header agent glyph",
        "fix/restore-recovery-cwd",
        "chore/bump-electron-42",
        "chore/12431-lookalike",
      ]);
    });

    it("names the dialog and the search box", () => {
      render(<Harness />);

      expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
        "Move to worktree"
      );
      expect(searchInput().getAttribute("placeholder")).toBe("Search worktrees");
    });

    it("adds the branch under a title, and nothing under a branch", () => {
      render(<Harness />);

      const detail = (label: string) =>
        option(label).querySelector("span.font-mono")?.textContent ?? null;

      expect(detail("#12431 Add systemPrompt to agent launch")).toBe(
        "feature/issue-12431-add-systemprompt"
      );
      expect(detail("#12389 Panel header agent glyph")).toBe("feature/issue-12389-panel-glyph");
      expect(detail("daintree")).toBe("main");
      expect(detail("fix/restore-recovery-cwd")).toBeNull();
    });

    it("keeps the current worktree in place, disabled and marked current", () => {
      render(<Harness />);

      const row = option("#12431 Add systemPrompt to agent launch");
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.getAttribute("aria-current")).toBe("true");
      expect(row.textContent).toContain("Current");
      expect(option("daintree").getAttribute("aria-current")).toBeNull();
    });

    it("draws the worktree's colour beside it, and the main glyph for main", () => {
      colorMapRef.current = { "w-main": "red", "w-restore": "rgb(1, 2, 3)" };
      render(<Harness />);

      const dot = option("fix/restore-recovery-cwd").querySelector<HTMLElement>(
        "span.rounded-full"
      );
      expect(dot?.style.backgroundColor).toBe("rgb(1, 2, 3)");
      expect(option("daintree").querySelector("span.rounded-full")).toBeNull();
      expect(option("daintree").querySelector("svg")).not.toBeNull();
    });

    it("draws no dot when there are no worktree colours", () => {
      render(<Harness />);

      expect(document.querySelector('[role="option"] span.rounded-full')).toBeNull();
    });

    it("marks its content as part of a dock preview when opened from one", () => {
      render(
        <DockPopoverChildProvider>
          <Harness />
        </DockPopoverChildProvider>
      );

      expect(
        document.querySelector('[role="dialog"]')?.getAttribute("data-dock-popover-child")
      ).toBe("");
    });
  });

  describe("search", () => {
    it("matches a number only against the issue and linked PR numbers", () => {
      render(<Harness />);

      type("12389");
      expect(optionLabels()).toEqual(["#12389 Panel header agent glyph"]);

      // The lookalike carries 12431 in its branch but is not linked to it.
      type("#12431");
      expect(optionLabels()).toEqual(["#12431 Add systemPrompt to agent launch"]);
    });

    it("matches text against the branch", () => {
      render(<Harness />);

      type("restore");

      expect(optionLabels()).toEqual(["fix/restore-recovery-cwd"]);
    });

    it("keeps main first however the rest rank", () => {
      render(<Harness />);

      // "restore-recovery-cwd" starts with the query and outranks "daintree",
      // which only contains it — but main still leads, as its card does.
      type("re");

      expect(optionLabels()[0]).toBe("daintree");
      expect(optionLabels()[1]).toBe("fix/restore-recovery-cwd");
    });

    it("treats a query of spaces as no query", () => {
      render(<Harness />);

      type("   ");

      expect(options()).toHaveLength(SIDEBAR_ORDER.length);
    });

    it("says what found nothing and offers to clear it", () => {
      render(<Harness />);

      type("zzzz");

      expect(options()).toHaveLength(0);
      expect(document.body.textContent).toContain('No matches for "zzzz"');

      const clear = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Clear search"
      );
      expect(clear).toBeDefined();
      fireEvent.click(clear!);

      expect(searchInput().value).toBe("");
      expect(options()).toHaveLength(SIDEBAR_ORDER.length);
      expect(document.activeElement).toBe(searchInput());
    });

    it("announces the count while a search is narrowing the list", () => {
      render(<Harness />);
      expect(liveRegion()).toBe("");

      type("chore");
      expect(liveRegion()).toBe("2 worktrees");

      type("restore");
      expect(liveRegion()).toBe("1 worktree");
    });
  });

  describe("keyboard", () => {
    it("starts on the first row it can move to", () => {
      render(<Harness currentWorktreeId="w-main" />);

      expect(selectedLabel()).toBe("#12431 Add systemPrompt to agent launch");
    });

    it("steps over the current worktree", () => {
      render(<Harness />);
      expect(selectedLabel()).toBe("daintree");

      press("ArrowDown");

      expect(selectedLabel()).toBe("#12389 Panel header agent glyph");
      expect(searchInput().getAttribute("aria-activedescendant")).toBe(
        option("#12389 Panel header agent glyph").id
      );
    });

    it("wraps at both ends and jumps with Home and End", () => {
      render(<Harness />);

      press("ArrowUp");
      expect(selectedLabel()).toBe("chore/12431-lookalike");

      press("ArrowDown");
      expect(selectedLabel()).toBe("daintree");

      press("End");
      expect(selectedLabel()).toBe("chore/12431-lookalike");

      press("Home");
      expect(selectedLabel()).toBe("daintree");
    });

    it("rewinds to the first row when the query changes", () => {
      render(<Harness />);
      press("ArrowDown");
      press("ArrowDown");
      expect(selectedLabel()).toBe("fix/restore-recovery-cwd");

      type("chore");

      expect(selectedLabel()).toBe("chore/bump-electron-42");
    });

    it("keeps the cursor on its worktree when the list reorders underneath it", () => {
      const { rerender } = render(<Harness />);
      press("ArrowDown");
      press("ArrowDown");
      expect(selectedLabel()).toBe("fix/restore-recovery-cwd");

      // Recent activity moved it to the bottom while the picker was open.
      worktreesRef.current = [main, current, fromPr, bump, lookalike, restore];
      rerender(<Harness />);

      expect(selectedLabel()).toBe("fix/restore-recovery-cwd");
    });

    it("leaves the keys alone mid-composition", () => {
      render(<Harness />);

      press("ArrowDown", { isComposing: true });
      press("ArrowDown", { keyCode: 229 });
      press("Enter", { isComposing: true });

      expect(selectedLabel()).toBe("daintree");
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("keeps the keys it uses from reaching the panel behind it", () => {
      const onPanelKeyDown = vi.fn();
      render(<Harness onPanelKeyDown={onPanelKeyDown} />);

      press("ArrowDown");
      press("End");

      expect(onPanelKeyDown).not.toHaveBeenCalled();
    });

    it("moves the panel to the cursor's worktree on Enter, once, and closes", () => {
      const onOpenChange = vi.fn();
      render(<Harness onOpenChange={onOpenChange} />);
      press("ArrowDown");

      press("Enter");

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(
        "terminal.moveToWorktree",
        { terminalId: "panel-1", worktreeId: "w-pr" },
        { source: "menu" }
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("does nothing on Enter when only the current worktree matches", () => {
      render(<Harness />);
      type("12431");

      press("Enter");

      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("clears a query with the first Escape and closes with the second", () => {
      const onOpenChange = vi.fn();
      render(<Harness onOpenChange={onOpenChange} />);
      type("chore");

      pressEscape();
      expect(searchInput().value).toBe("");
      expect(onOpenChange).not.toHaveBeenCalled();

      pressEscape();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe("pointer", () => {
    it("moves the cursor with the pointer", () => {
      render(<Harness />);

      fireEvent.pointerMove(option("chore/bump-electron-42"));

      expect(selectedLabel()).toBe("chore/bump-electron-42");
    });

    it("moves the panel to a clicked row", () => {
      render(<Harness />);

      fireEvent.click(option("fix/restore-recovery-cwd"));

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(
        "terminal.moveToWorktree",
        { terminalId: "panel-1", worktreeId: "w-restore" },
        { source: "menu" }
      );
    });

    it("keeps the activating click from reaching the panel behind it", () => {
      // Panes focus themselves on any click that reaches them, prevented or
      // not, and focusing the pane that just moved switches the view to its
      // new worktree.
      const onPanelClick = vi.fn();
      render(<Harness onPanelClick={onPanelClick} />);

      fireEvent.click(option("fix/restore-recovery-cwd"));

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(onPanelClick).not.toHaveBeenCalled();
    });

    it("moves nothing from a row clicked while the picker is closing", () => {
      render(<Harness />);
      pressEscape();

      fireEvent.click(option("fix/restore-recovery-cwd"));

      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("ignores the current worktree's row", () => {
      render(<Harness />);
      const row = option("#12431 Add systemPrompt to agent launch");

      fireEvent.pointerMove(row);
      fireEvent.click(row);

      expect(selectedLabel()).toBe("daintree");
      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });

  describe("focus on close", () => {
    it("does not send focus back to the header after a move", () => {
      render(<Harness />);
      const anchor = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "More panel actions"
      )!;

      press("Enter");
      const event = fireCloseAutoFocus();

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).not.toBe(anchor);
    });

    it("returns a keyboard dismissal to the header's button", () => {
      render(<Harness />);
      const anchor = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "More panel actions"
      )!;

      pressEscape();
      fireCloseAutoFocus();

      expect(document.activeElement).toBe(anchor);
    });
  });
});
