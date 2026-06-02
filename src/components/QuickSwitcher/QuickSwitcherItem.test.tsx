// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickSwitcherItem } from "./QuickSwitcherItem";
import type { QuickSwitcherItem as QuickSwitcherItemData } from "@/hooks/useQuickSwitcher";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
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

function makeWorktreeItem(overrides: Partial<QuickSwitcherItemData> = {}): QuickSwitcherItemData {
  return {
    id: "worktree:wt-1",
    type: "worktree",
    title: "main",
    subtitle: "/path/to/wt",
    ...overrides,
  };
}

describe("QuickSwitcherItem", () => {
  const onSelect = vi.fn();

  it("renders worktree row with title", () => {
    render(<QuickSwitcherItem item={makeWorktreeItem()} isSelected={false} onSelect={onSelect} />);
    expect(screen.getByText("main")).toBeTruthy();
  });

  it("applies selection styling via aria-selected variants", () => {
    const { container } = render(
      <QuickSwitcherItem item={makeWorktreeItem()} isSelected={true} onSelect={onSelect} />
    );

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-selected")).toBe("true");
  });

  it("does not branch styling on isSelected — selection is purely aria-driven", () => {
    const { container: selectedContainer } = render(
      <QuickSwitcherItem item={makeWorktreeItem()} isSelected={true} onSelect={onSelect} />
    );
    const { container: unselectedContainer } = render(
      <QuickSwitcherItem item={makeWorktreeItem()} isSelected={false} onSelect={onSelect} />
    );

    expect(selectedContainer.querySelector("button")?.className).toBe(
      unselectedContainer.querySelector("button")?.className
    );
  });

  it("calls onHover on pointer move", () => {
    const onHover = vi.fn();
    const { container } = render(
      <QuickSwitcherItem
        item={makeWorktreeItem()}
        isSelected={false}
        onSelect={onSelect}
        onHover={onHover}
      />
    );

    fireEvent.pointerMove(container.querySelector("button")!);
    expect(onHover).toHaveBeenCalledTimes(1);
  });

  it("does not throw when onHover is omitted", () => {
    const { container } = render(
      <QuickSwitcherItem item={makeWorktreeItem()} isSelected={false} onSelect={onSelect} />
    );
    expect(() => fireEvent.pointerMove(container.querySelector("button")!)).not.toThrow();
  });
});
