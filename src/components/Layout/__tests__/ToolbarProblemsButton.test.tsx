// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { ToolbarProblemsButton } from "../ToolbarProblemsButton";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
  }) => (
    <div role="menuitem" onClick={(e) => onSelect?.(e as unknown as Event)}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
}));

vi.mock("@/components/ui/ShortcutRevealChip", () => ({
  ShortcutRevealChip: () => null,
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  Unplug: () => <span data-testid="icon-unplug" />,
}));

function getIconHostClassName(container: HTMLElement): string {
  const button = container.querySelector("button");
  if (!button) throw new Error("button not rendered");
  return button.className;
}

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => "",
  useKeybindingDisplay: () => "",
  useShortcutHintHover: () => ({}),
}));

vi.mock("@/lib/tooltipShortcut", () => ({
  createTooltipContent: () => null,
}));

describe("ToolbarProblemsButton — aria-expanded / aria-controls", () => {
  beforeEach(() => {
    useDiagnosticsStore.setState({ isOpen: false });
  });

  it("exposes aria-expanded=false and aria-controls when the dock is closed", () => {
    const { container } = render(<ToolbarProblemsButton errorCount={0} />);
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-controls")).toBe("diagnostics-dock-region");
  });

  it("flips aria-expanded to true when the dock opens", () => {
    const { container } = render(<ToolbarProblemsButton errorCount={2} />);
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      useDiagnosticsStore.setState({ isOpen: true });
    });

    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.getAttribute("aria-controls")).toBe("diagnostics-dock-region");
  });
});

describe("ToolbarProblemsButton — single-signal error treatment", () => {
  beforeEach(() => {
    useDiagnosticsStore.setState({ isOpen: false });
  });

  it("does not recolor the icon host when errorCount > 0 (badge dot is the only signal)", () => {
    const { container } = render(<ToolbarProblemsButton errorCount={3} />);
    expect(getIconHostClassName(container)).not.toMatch(/text-status-error/);
  });

  it("shows the badge as visible when errorCount > 0", () => {
    const { container } = render(<ToolbarProblemsButton errorCount={1} />);
    const badge = container.querySelector(".toolbar-problems-badge");
    expect(badge?.getAttribute("data-visible")).toBe("true");
  });

  it("hides the badge when errorCount is 0", () => {
    const { container } = render(<ToolbarProblemsButton errorCount={0} />);
    const badge = container.querySelector(".toolbar-problems-badge");
    expect(badge?.getAttribute("data-visible")).toBe("false");
  });
});

describe("ToolbarProblemsButton — watcher-degraded pip", () => {
  beforeEach(() => {
    useDiagnosticsStore.setState({ isOpen: false });
  });

  it("keeps the watcher pip hidden by default", () => {
    const { getByTestId } = render(<ToolbarProblemsButton errorCount={0} />);
    expect(getByTestId("watcher-degraded-badge").getAttribute("data-visible")).toBe("false");
  });

  it("shows the watcher pip when watcherDegraded is true", () => {
    const { getByTestId } = render(<ToolbarProblemsButton errorCount={0} watcherDegraded />);
    expect(getByTestId("watcher-degraded-badge").getAttribute("data-visible")).toBe("true");
  });

  it("is independent of errorCount (both pips can show together)", () => {
    const { container, getByTestId } = render(
      <ToolbarProblemsButton errorCount={2} watcherDegraded />
    );
    expect(container.querySelector(".toolbar-problems-badge")?.getAttribute("data-visible")).toBe(
      "true"
    );
    expect(getByTestId("watcher-degraded-badge").getAttribute("data-visible")).toBe("true");
  });

  it("reflects watcher degradation in the accessible label", () => {
    const { container } = render(<ToolbarProblemsButton errorCount={0} watcherDegraded />);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Problems: 0 errors, file watching degraded"
    );
  });

  it("omits the degraded clause from the label when healthy", () => {
    const { container } = render(<ToolbarProblemsButton errorCount={1} />);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Problems: 1 error");
  });
});
