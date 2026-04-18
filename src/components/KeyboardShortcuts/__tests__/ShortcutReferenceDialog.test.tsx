// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShortcutReferenceDialog } from "../ShortcutReferenceDialog";
import type { KeybindingConfig } from "@/services/KeybindingService";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const mockBindings: Array<KeybindingConfig & { effectiveCombo: string }> = [
  {
    actionId: "terminal.stashInput",
    combo: "Cmd+K Cmd+S",
    scope: "terminal",
    priority: 0,
    description: "Stash Current Input",
    category: "Terminal",
    effectiveCombo: "Cmd+K Cmd+S",
  },
  {
    actionId: "app.toggleSidebar",
    combo: "Cmd+B",
    scope: "global",
    priority: 0,
    description: "Toggle Sidebar",
    category: "System",
    effectiveCombo: "Cmd+B",
  },
  {
    actionId: "terminal.newPanel",
    combo: "Cmd+T",
    scope: "global",
    priority: 0,
    description: "New Terminal Panel",
    category: "Terminal",
    effectiveCombo: "Cmd+T",
  },
  {
    actionId: "app.openSettings",
    combo: "Cmd+,",
    scope: "global",
    priority: 0,
    description: "Open Settings",
    category: "System",
    effectiveCombo: "Cmd+,",
  },
  {
    actionId: "app.commandPalette",
    combo: "Cmd+Shift+P",
    scope: "global",
    priority: 0,
    description: "Command Palette",
    category: "System",
    effectiveCombo: "Cmd+Shift+P",
  },
];

const mockDisplayCombos: Record<string, string> = {
  "terminal.stashInput": "⌘K ⌘S",
  "app.toggleSidebar": "⌘B",
  "terminal.newPanel": "⌘T",
  "app.openSettings": "⌘,",
  "app.commandPalette": "⌘⇧P",
};

vi.mock("@/services/KeybindingService", () => {
  const listeners: Array<() => void> = [];
  return {
    keybindingService: {
      getAllBindingsWithEffectiveCombos: vi.fn(() => mockBindings),
      getDisplayCombo: vi.fn((actionId: string) => mockDisplayCombos[actionId] || actionId),
      subscribe: vi.fn((listener: () => void) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index > -1) listeners.splice(index, 1);
        };
      }),
      notifyListeners: vi.fn(() => listeners.forEach((l) => l())),
    },
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("ShortcutReferenceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all categories with no query", () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Keyboard Shortcuts")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();
    expect(screen.getByText("Stash Current Input")).toBeTruthy();
    expect(screen.getByText("Toggle Sidebar")).toBeTruthy();
    expect(screen.getByText("New Terminal Panel")).toBeTruthy();
    expect(screen.getByText("Open Settings")).toBeTruthy();
  });

  it("shows empty results state for non-matching query", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "nonexistent" } });

    await waitFor(() => {
      expect(screen.getByText('No shortcuts found matching "nonexistent"')).toBeTruthy();
    });
  });

  it("fuzzy search finds binding from partial description match", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "stsh" } });

    await waitFor(() => {
      expect(screen.getByText("Stash Current Input")).toBeTruthy();
    });
  });

  it("fuzzy search finds binding by actionId", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "stashInput" } });

    await waitFor(() => {
      expect(screen.getByText("Stash Current Input")).toBeTruthy();
    });
  });

  it("fuzzy search filters by description", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "settings" } });

    await waitFor(() => {
      expect(screen.getByText("Open Settings")).toBeTruthy();
      expect(screen.queryByText("Toggle Sidebar")).toBeNull();
    });
  });

  it("chord prefix query filters to chord family", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "cmd+k" } });

    await waitFor(() => {
      expect(screen.getByText("Stash Current Input")).toBeTruthy();
      expect(screen.queryByText("Toggle Sidebar")).toBeNull();
      expect(screen.queryByText("New Terminal Panel")).toBeNull();
    });
  });

  it("chord prefix query works with unicode symbol", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "⌘k" } });

    await waitFor(() => {
      expect(screen.getByText("Stash Current Input")).toBeTruthy();
      expect(screen.queryByText("Toggle Sidebar")).toBeNull();
    });
  });

  it("non-chord queries do not collapse list incorrectly", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "toggle" } });

    await waitFor(() => {
      expect(screen.getByText("Toggle Sidebar")).toBeTruthy();
    });
  });

  it("single modifier key is not treated as chord prefix", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "cmd" } });

    await waitFor(() => {
      expect(screen.getByText("Stash Current Input")).toBeTruthy();
      expect(screen.getByText("Toggle Sidebar")).toBeTruthy();
    });
  });

  it("displays scope for non-global bindings", () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Scope: terminal")).toBeTruthy();
  });

  it("does not display scope for global bindings", () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const scopeElements = screen.getAllByText("Scope: terminal");
    expect(scopeElements.length).toBe(1);
  });

  it("shows Esc to close hint in footer", () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const footer = screen.getByText(/Esc/i).closest("div");
    expect(footer?.textContent).toContain("Esc");
    expect(footer?.textContent).toContain("close");
  });

  it("handles space-separated chord query", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "cmd k" } });

    await waitFor(() => {
      expect(screen.getByText("Stash Current Input")).toBeTruthy();
      expect(screen.queryByText("Toggle Sidebar")).toBeNull();
    });
  });

  it("modifier-like words use fuzzy search, not chord prefix", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "commander" } });

    await waitFor(() => {
      // Should find "Command Palette" via fuzzy search, not trigger chord prefix
      expect(screen.getByText("Command Palette")).toBeTruthy();
    });
  });

  it("trailing separator falls back to fuzzy search", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "cmd+" } });

    await waitFor(() => {
      // Should use fuzzy search and find Cmd-related bindings
      expect(screen.getByText("Stash Current Input")).toBeTruthy();
    });
  });

  it("multiple modifier chord prefix works", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "cmd+shift+p" } });

    await waitFor(() => {
      expect(screen.getByText("Command Palette")).toBeTruthy();
      expect(screen.queryByText("Toggle Sidebar")).toBeNull();
    });
  });

  it("unicode multiple modifier chord prefix works", async () => {
    render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText("Search shortcuts...");
    fireEvent.change(searchInput, { target: { value: "⌘⇧p" } });

    await waitFor(() => {
      expect(screen.getByText("Command Palette")).toBeTruthy();
      expect(screen.queryByText("Toggle Sidebar")).toBeNull();
    });
  });
});
