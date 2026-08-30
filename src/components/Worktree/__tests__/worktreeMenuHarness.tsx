import { Children, cloneElement, isValidElement } from "react";
import type * as React from "react";
import { vi } from "vitest";
import { render } from "@testing-library/react";
import type { WorktreeState } from "../../../types";
import {
  WorktreeMenuItems,
  type WorktreeMenuComponents,
  type WorktreeMenuItemsProps,
} from "../WorktreeMenuItems";
import { MenuActionSourceContext, type MenuActionSourceValue } from "@/components/ui/menu-source";

/**
 * Plain-DOM stand-ins for the Radix menu primitives. `WorktreeMenuItems` is a
 * pure render layer over whatever `components` it is given, so both real
 * surfaces (card right-click and the ⋯ dropdown) exercise this same tree.
 *
 * Submenu triggers render as buttons too, which is what lets a test assert the
 * ROOT hierarchy: every root row — trigger or item — is one button, in order.
 */
export const menuComponents: WorktreeMenuComponents = {
  Item: ({
    children,
    onSelect,
    disabled,
    ...rest
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onSelect} disabled={disabled} data-menu-item {...rest}>
      {children}
    </button>
  ),
  Label: ({ children }: { children?: React.ReactNode }) => <div data-menu-label>{children}</div>,
  Separator: () => <hr data-menu-separator />,
  Shortcut: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Meta: ({ children }: { children?: React.ReactNode }) => (
    <span aria-hidden="true" data-menu-meta>
      {children}
    </span>
  ),
  Sub: ({ children }: { children?: React.ReactNode }) => <div data-menu-sub>{children}</div>,
  SubTrigger: ({ children }: { children?: React.ReactNode }) => (
    <button type="button" data-menu-subtrigger>
      {children}
    </button>
  ),
  SubContent: ({ children }: { children?: React.ReactNode }) => (
    <div data-menu-subcontent>{children}</div>
  ),
  RadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children?: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <div role="group" data-menu-radiogroup data-value={value} data-testid="radio-group">
      {/* The handler is threaded onto each item below via context-free props;
          keeping it here mirrors Radix, where the group owns the callback. */}
      {toRadioChildren(children, value, onValueChange)}
    </div>
  ),
  RadioItem: ({
    children,
    onSelect,
    checked,
  }: {
    children?: React.ReactNode;
    value?: string;
    onSelect?: () => void;
    checked?: boolean;
  }) => (
    <button type="button" role="menuitemradio" aria-checked={Boolean(checked)} onClick={onSelect}>
      {children}
    </button>
  ),
};

/** Wires the group's value/onValueChange onto its RadioItem children, as Radix does. */
function toRadioChildren(
  children: React.ReactNode,
  value: string | undefined,
  onValueChange: ((value: string) => void) | undefined
): React.ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- every child here is a RadioItem; reading its `value` is the whole point of the stand-in.
    const childValue = (child.props as { value?: string }).value;
    return cloneElement(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- cloneElement needs the prop bag widened to inject `checked`/`onSelect`, exactly as Radix's RadioGroup context does.
      child as React.ReactElement<Record<string, unknown>>,
      {
        checked: childValue !== undefined && childValue === value,
        onSelect: () => childValue !== undefined && onValueChange?.(childValue),
      }
    );
  });
}

export function makeWorktree(overrides: Partial<WorktreeState> = {}): WorktreeState {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- WorktreeState has ~60 fields and this render layer reads a handful of them; the repo's other worktree component tests build fixtures the same way.
  return {
    id: "wt-1",
    name: "feature",
    path: "/repo/wt-1",
    branch: "feature",
    ...overrides,
  } as WorktreeState;
}

export const zeroCounts = {
  grid: 0,
  dock: 0,
  active: 0,
  completed: 0,
  all: 0,
  waiting: 0,
  working: 0,
};

type Overrides = Partial<Omit<WorktreeMenuItemsProps, "components">>;

/**
 * Renders the menu with every required callback stubbed, under a real menu
 * source so `useMenuActionSource()` resolves instead of warning.
 */
export function renderWorktreeMenu(
  overrides: Overrides = {},
  source: MenuActionSourceValue = "menu"
) {
  const { worktree, ...rest } = overrides;
  return render(
    <MenuActionSourceContext.Provider value={source}>
      <WorktreeMenuItems
        worktree={worktree ?? makeWorktree()}
        components={menuComponents}
        launchAgents={[]}
        recipes={[]}
        runningRecipeId={null}
        counts={zeroCounts}
        onCopyContextFull={vi.fn()}
        onCopyContextModified={vi.fn()}
        onCopyPath={vi.fn()}
        onCopyBranchName={vi.fn()}
        onOpenEditor={vi.fn()}
        onRevealInFinder={vi.fn()}
        onRunRecipe={vi.fn()}
        onDockAll={vi.fn()}
        onMaximizeAll={vi.fn()}
        onResetRenderers={vi.fn()}
        onSelectAllAgents={vi.fn()}
        onSelectWaitingAgents={vi.fn()}
        onSelectWorkingAgents={vi.fn()}
        onCloseAll={vi.fn()}
        onTerminateAll={vi.fn()}
        onClearHistory={vi.fn()}
        {...rest}
      />
    </MenuActionSourceContext.Provider>
  );
}

/**
 * The root rows in document order: submenu triggers plus the flat destructive
 * item, excluding everything nested inside a submenu's content.
 */
export function rootRowLabels(container: HTMLElement): string[] {
  return Array.from(container.children)
    .flatMap((node) => (node.matches("[data-menu-sub]") ? [node.firstElementChild] : [node]))
    .filter((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === "BUTTON")
    .map((node) => node.textContent?.trim() ?? "");
}

/** Root-level separators only — the ones `joinGroups` inserts. */
export function rootSeparatorCount(container: HTMLElement): number {
  return Array.from(container.children).filter((node) => node.matches("[data-menu-separator]"))
    .length;
}
