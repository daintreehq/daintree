// @vitest-environment jsdom
import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";
import {
  CONTEXT_MENU_AVAILABILITY_CHANNEL,
  type ContextMenuContribution,
} from "@shared/types/plugin";

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

// The real Radix context-menu primitives require an open portal to render
// items; stub them with plain elements so the section's own logic (separator
// gating, key, onSelect → dispatch) is what's under test.
// The stub item never sets the native `disabled` attribute, so a click still
// reaches `onSelect` and the section's own guard is what's under test, not
// Radix withholding the event.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" data-disabled={disabled ? "" : undefined} onClick={onSelect}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr data-testid="separator" />,
  ContextMenuMeta: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="meta" aria-hidden="true">
      {children}
    </span>
  ),
}));

import { PluginContextMenuSection } from "../PluginContextMenuSection";
import { MenuActionSourceContext } from "@/components/ui/menu-source";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";

function entry(pluginId: string, label: string, actionId: string): PluginContextMenuItemEntry {
  return { pluginId, item: { pluginId, label, actionId, location: "worktree" } as never };
}

function checked(
  label: string,
  actionId: string,
  location: ContextMenuContribution["location"] = "terminal"
): PluginContextMenuItemEntry {
  return { pluginId: "acme", item: { label, actionId, location, availability: "continue" } };
}

const invokeMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockReset();
  (window as unknown as { electron: unknown }).electron = { plugin: { invoke: invokeMock } };
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

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

  it("dispatches with the surface's dispatchArgs instead of undefined", () => {
    const args = { path: "/repo/src/index.ts", worktreePath: "/repo", status: "modified" };
    render(
      <MenuActionSourceContext.Provider value="context-menu">
        <PluginContextMenuSection
          items={[entry("acme", "Open", "file.openDiff")]}
          dispatchArgs={args}
        />
      </MenuActionSourceContext.Provider>
    );
    fireEvent.click(screen.getByText("Open"));
    expect(dispatchMock).toHaveBeenCalledWith("file.openDiff", args, { source: "context-menu" });
    // The dispatched args carry the clicked subject, not `undefined`.
    expect(dispatchMock.mock.calls[0]![1]).not.toBeUndefined();
  });

  it.each([
    ["worktree", { worktreeId: "wt-1" }],
    ["terminal", { panelId: "p-1", panelKind: "terminal", worktreeId: "wt-1" }],
    ["browser", { panelId: "p-2", panelKind: "dev-preview", url: "http://localhost:3000/" }],
  ])("hands a %s item its clicked subject", (_location, args) => {
    render(
      <PluginContextMenuSection items={[entry("acme", "Go", "acme.go")]} dispatchArgs={args} />
    );
    fireEvent.click(screen.getByText("Go"));
    expect(dispatchMock).toHaveBeenCalledWith("acme.go", args, { source: "user" });
  });

  it("renders through injected components so a dropdown surface gets the same section", () => {
    const DropdownItem = ({
      children,
      onSelect,
    }: {
      children: React.ReactNode;
      onSelect: () => void;
    }) => (
      <button type="button" data-surface="dropdown" onClick={onSelect}>
        {children}
      </button>
    );
    const DropdownSeparator = () => <hr data-testid="dropdown-separator" />;
    render(
      <MenuActionSourceContext.Provider value="menu">
        <PluginContextMenuSection
          items={[entry("acme", "Do A", "acme.a")]}
          components={{ Item: DropdownItem, Separator: DropdownSeparator }}
        />
      </MenuActionSourceContext.Provider>
    );
    // The default context-menu primitives (stubbed above as `separator`) must
    // not appear — the injected pair replaces both item and separator.
    expect(screen.getByTestId("dropdown-separator")).toBeTruthy();
    expect(screen.queryByTestId("separator")).toBeNull();
    expect(screen.getByText("Do A").closest("[data-surface]")?.getAttribute("data-surface")).toBe(
      "dropdown"
    );
    fireEvent.click(screen.getByText("Do A"));
    expect(dispatchMock).toHaveBeenCalledWith("acme.a", undefined, { source: "menu" });
  });

  it("omits the leading separator when leadingSeparator is false", () => {
    render(
      <PluginContextMenuSection
        items={[entry("acme", "Open", "file.openDiff")]}
        leadingSeparator={false}
      />
    );
    expect(screen.queryByTestId("separator")).toBeNull();
    expect(screen.getByText("Open")).toBeTruthy();
  });

  it("never asks a plugin about an item that doesn't check availability", async () => {
    render(
      <PluginContextMenuSection
        items={[entry("acme", "Do A", "acme.a")]}
        dispatchArgs={{ panelId: "p-1" }}
      />
    );
    await flush();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.getByText("Do A").closest("button")?.hasAttribute("data-disabled")).toBe(false);
  });
});

describe("PluginContextMenuSection availability", () => {
  const paneArgs = { panelId: "p-1", panelKind: "terminal", worktreeId: "wt-1" };

  it("keeps an unavailable item visible and disabled, with the plugin's reason beside it", async () => {
    invokeMock.mockResolvedValue("Session file unknown");
    render(
      <MenuActionSourceContext.Provider value="context-menu">
        <PluginContextMenuSection
          items={[checked("Continue in another agent…", "acme.continue")]}
          dispatchArgs={paneArgs}
        />
      </MenuActionSourceContext.Provider>
    );
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("acme", CONTEXT_MENU_AVAILABILITY_CHANNEL, {
      availability: "continue",
      location: "terminal",
      ...paneArgs,
    });

    const row = screen.getByText("Continue in another agent…").closest("button")!;
    expect(row.hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByTestId("meta").textContent).toBe("Session file unknown");
    // The visible reason is aria-hidden, so the row's name carries it once.
    expect(row.textContent).toContain(", Session file unknown");

    fireEvent.click(row);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("can't be invoked while the answer is pending", () => {
    invokeMock.mockReturnValue(new Promise(() => {}));
    render(
      <PluginContextMenuSection
        items={[checked("Continue", "acme.continue")]}
        dispatchArgs={paneArgs}
      />
    );
    const row = screen.getByText("Continue").closest("button")!;
    expect(row.hasAttribute("data-disabled")).toBe(true);
    // Inside the inline loading gate the row shows no "Checking…".
    expect(screen.queryByTestId("meta")).toBeNull();
    fireEvent.click(row);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("says it's checking once the answer outlasts the inline loading gate", () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockReturnValue(new Promise(() => {}));
      render(
        <PluginContextMenuSection
          items={[checked("Continue", "acme.continue")]}
          dispatchArgs={paneArgs}
        />
      );
      act(() => {
        vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS);
      });
      expect(screen.getByTestId("meta").textContent).toBe("Checking…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches exactly as an unchecked item once the plugin answers null", async () => {
    invokeMock.mockResolvedValue(null);
    render(
      <MenuActionSourceContext.Provider value="context-menu">
        <PluginContextMenuSection
          items={[checked("Continue", "acme.continue")]}
          dispatchArgs={paneArgs}
        />
      </MenuActionSourceContext.Provider>
    );
    await flush();
    const row = screen.getByText("Continue").closest("button")!;
    expect(row.hasAttribute("data-disabled")).toBe(false);
    expect(screen.queryByTestId("meta")).toBeNull();
    fireEvent.click(row);
    expect(dispatchMock).toHaveBeenCalledWith("acme.continue", paneArgs, {
      source: "context-menu",
    });
  });

  it("offers the item when the check fails", async () => {
    invokeMock.mockRejectedValue(new Error('No handler registered for channel "x"'));
    render(
      <PluginContextMenuSection
        items={[checked("Continue", "acme.continue")]}
        dispatchArgs={paneArgs}
      />
    );
    await flush();
    fireEvent.click(screen.getByText("Continue"));
    expect(dispatchMock).toHaveBeenCalledWith("acme.continue", paneArgs, { source: "user" });
  });

  it("shows the reason in an injected surface's Meta", async () => {
    invokeMock.mockResolvedValue("Not supported for this page");
    const DropdownItem = ({
      children,
      onSelect,
      disabled,
    }: {
      children: React.ReactNode;
      onSelect: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" data-disabled={disabled ? "" : undefined} onClick={onSelect}>
        {children}
      </button>
    );
    const DropdownMeta = ({ children }: { children: React.ReactNode }) => (
      <span data-testid="dropdown-meta">{children}</span>
    );
    render(
      <PluginContextMenuSection
        items={[checked("Capture", "acme.capture", "browser")]}
        components={{ Item: DropdownItem, Separator: () => <hr />, Meta: DropdownMeta }}
        dispatchArgs={{ panelId: "p-2", panelKind: "browser", url: "https://example.com/" }}
      />
    );
    await flush();
    // The page URL stays on the dispatch, not on every menu opening.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("acme", CONTEXT_MENU_AVAILABILITY_CHANNEL, {
      availability: "continue",
      location: "browser",
      panelId: "p-2",
      panelKind: "browser",
    });
    expect(screen.getByTestId("dropdown-meta").textContent).toBe("Not supported for this page");
    expect(screen.queryByTestId("meta")).toBeNull();
    const row = screen.getByText("Capture").closest("button")!;
    expect(row.hasAttribute("data-disabled")).toBe(true);
    fireEvent.click(row);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
