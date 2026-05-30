// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

// The real Radix context-menu primitives require an open portal to render
// items; stub them with plain elements so the section's own logic (separator
// gating, key, onSelect → dispatch) is what's under test.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr data-testid="separator" />,
}));

import { PluginContextMenuSection } from "../PluginContextMenuSection";
import { MenuActionSourceContext } from "@/components/ui/menu-source";

function entry(pluginId: string, label: string, actionId: string): PluginContextMenuItemEntry {
  return { pluginId, item: { pluginId, label, actionId, location: "worktree" } as never };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PluginContextMenuSection", () => {
  it("renders nothing when there are no items", () => {
    const { container } = render(<PluginContextMenuSection items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a leading separator and one item per entry", () => {
    render(
      <PluginContextMenuSection
        items={[entry("acme", "Do A", "acme.a"), entry("acme", "Do B", "acme.b")]}
      />
    );
    expect(screen.getByTestId("separator")).toBeTruthy();
    expect(screen.getByText("Do A")).toBeTruthy();
    expect(screen.getByText("Do B")).toBeTruthy();
  });

  it("dispatches the item's actionId with the source from context", () => {
    render(
      <MenuActionSourceContext.Provider value="context-menu">
        <PluginContextMenuSection items={[entry("acme", "Do A", "acme.a")]} />
      </MenuActionSourceContext.Provider>
    );
    fireEvent.click(screen.getByText("Do A"));
    expect(dispatchMock).toHaveBeenCalledWith("acme.a", undefined, { source: "context-menu" });
  });

  it("falls back to source 'user' outside a context-menu provider", () => {
    render(<PluginContextMenuSection items={[entry("acme", "Do A", "acme.a")]} />);
    fireEvent.click(screen.getByText("Do A"));
    expect(dispatchMock).toHaveBeenCalledWith("acme.a", undefined, { source: "user" });
  });
});
