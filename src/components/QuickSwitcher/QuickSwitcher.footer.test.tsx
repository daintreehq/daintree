// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
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
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
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

vi.mock("@/components/icons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/icons")>()),
  FolderGit2: () => <span data-testid="folder-icon" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/PanelPalette/PanelKindIcon", () => ({
  PanelKindIcon: ({ iconId }: { iconId: string }) => <span data-testid={`kind-icon-${iconId}`} />,
}));

import { QuickSwitcher } from "./QuickSwitcher";
import type { PluginSearchProviderInfo } from "@shared/types/plugin";

const NO_SCOPE = {
  scopedProvider: null,
  keywordProvider: null,
  scopedStatus: "idle" as const,
  enterScope: () => {},
  exitScope: () => {},
};

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
      matchesById={new Map()}
      close={() => {}}
      setQuery={() => {}}
      setSelectedIndex={() => {}}
      selectPrevious={() => {}}
      selectNext={() => {}}
      selectItem={() => {}}
      confirmSelection={() => {}}
      {...NO_SCOPE}
    />
  );
}

describe("QuickSwitcher dynamic footer hint", () => {
  it("updates the footer when selection moves between item types", () => {
    const props = {
      isOpen: true,
      query: "",
      results: [terminalItem, worktreeItem],
      totalResults: 2,
      isLoading: false,
      matchesById: new Map(),
      close: () => {},
      setQuery: () => {},
      setSelectedIndex: () => {},
      selectPrevious: () => {},
      selectNext: () => {},
      selectItem: () => {},
      confirmSelection: () => {},
      ...NO_SCOPE,
    };

    const { rerender } = render(<QuickSwitcher {...props} selectedIndex={0} />);
    expect(screen.getByText("to switch panel")).toBeTruthy();

    rerender(<QuickSwitcher {...props} selectedIndex={1} />);
    expect(screen.getByText("to switch worktree")).toBeTruthy();
    expect(screen.queryByText("to switch panel")).toBeNull();
  });

  it("removes the footer when results transition from populated to empty", () => {
    const baseProps = {
      isOpen: true,
      query: "",
      totalResults: 0,
      isLoading: false,
      matchesById: new Map(),
      close: () => {},
      setQuery: () => {},
      setSelectedIndex: () => {},
      selectPrevious: () => {},
      selectNext: () => {},
      selectItem: () => {},
      confirmSelection: () => {},
      ...NO_SCOPE,
    };

    const { rerender } = render(
      <QuickSwitcher {...baseProps} results={[terminalItem]} selectedIndex={0} />
    );
    expect(screen.getByText("to switch panel")).toBeTruthy();

    rerender(<QuickSwitcher {...baseProps} results={[]} selectedIndex={-1} />);
    expect(screen.queryByText("to switch panel")).toBeNull();
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
    expect(hintEl?.textContent).toContain("to switch panel");
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

const notesProvider: PluginSearchProviderInfo = {
  key: "acme.notes.notes",
  pluginId: "acme.notes",
  pluginName: "Acme Notes",
  title: "Notes",
  keyword: "notes",
  iconId: "notebook",
  blend: false,
  kind: "declarative",
  shown: true,
};

const pluginItem: QuickSwitcherItemData = {
  id: "plugin:acme.notes.notes:n1",
  type: "plugin",
  title: "Groceries",
  subtitle: "Shopping list",
  pluginHit: {
    id: "plugin:acme.notes.notes:n1",
    providerKey: "acme.notes.notes",
    providerTitle: "Notes",
    pluginId: "acme.notes",
    pluginName: "Acme Notes",
    row: {
      id: "n1",
      label: "Groceries",
      description: "Shopping list",
      iconId: "notebook",
      target: { type: "panel", panelKindId: "acme.notes.notes", args: { id: "n1" } },
    },
  },
};

function renderScoped(overrides: Partial<React.ComponentProps<typeof QuickSwitcher>>) {
  return render(
    <QuickSwitcher
      isOpen
      query=""
      results={[]}
      totalResults={0}
      selectedIndex={0}
      isLoading={false}
      matchesById={new Map()}
      close={() => {}}
      setQuery={() => {}}
      setSelectedIndex={() => {}}
      selectPrevious={() => {}}
      selectNext={() => {}}
      selectItem={() => {}}
      confirmSelection={() => {}}
      {...NO_SCOPE}
      {...overrides}
    />
  );
}

describe("QuickSwitcher plugin search scope", () => {
  it("scopes to the provider whose keyword the query spells when Tab is pressed", () => {
    const enterScope = vi.fn();
    const selectNext = vi.fn();
    renderScoped({
      query: "notes",
      results: [terminalItem],
      totalResults: 1,
      keywordProvider: notesProvider,
      enterScope,
      selectNext,
    });
    expect(screen.getByText("to search Notes")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });
    expect(enterScope).toHaveBeenCalledWith("acme.notes.notes");
    expect(selectNext).not.toHaveBeenCalled();
  });

  it("keeps Tab moving the selection without a keyword match, and Shift+Tab even with one", () => {
    const enterScope = vi.fn();
    const selectNext = vi.fn();
    const selectPrevious = vi.fn();
    const { rerender } = renderScoped({
      query: "zsh",
      results: [terminalItem, worktreeItem],
      totalResults: 2,
      enterScope,
      selectNext,
    });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });
    expect(selectNext).toHaveBeenCalledTimes(1);

    rerender(
      <QuickSwitcher
        isOpen
        query="notes"
        results={[terminalItem, worktreeItem]}
        totalResults={2}
        selectedIndex={0}
        isLoading={false}
        matchesById={new Map()}
        close={() => {}}
        setQuery={() => {}}
        setSelectedIndex={() => {}}
        selectPrevious={selectPrevious}
        selectNext={selectNext}
        selectItem={() => {}}
        confirmSelection={() => {}}
        {...NO_SCOPE}
        keywordProvider={notesProvider}
        enterScope={enterScope}
      />
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab", shiftKey: true });
    expect(selectPrevious).toHaveBeenCalledTimes(1);
    expect(enterScope).not.toHaveBeenCalled();
  });

  it("steps out of the scope on Backspace in an empty field and on Escape with no query", () => {
    const exitScope = vi.fn();
    const close = vi.fn();
    renderScoped({ scopedProvider: notesProvider, scopedStatus: "done", exitScope, close });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.placeholder).toBe("Search Notes");

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(exitScope).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(exitScope).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });

  it("names the provider when it didn't answer in time", () => {
    renderScoped({ query: "gro", scopedProvider: notesProvider, scopedStatus: "timeout" });
    expect(screen.getByText("Notes didn't answer in time")).toBeTruthy();
  });

  it("offers to type when the scoped provider has nothing for an empty query", () => {
    renderScoped({ scopedProvider: notesProvider, scopedStatus: "done" });
    expect(screen.getByText("Type to search Notes")).toBeTruthy();
    expect(screen.queryByText(/create a terminal/i)).toBeNull();
  });

  it("renders a plugin row under its provider's band, with its icon and an open hint", () => {
    renderScoped({ query: "gro", results: [pluginItem], totalResults: 1 });
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    // The provider names the band once, as an inert head the arrow keys skip.
    const head = options.find((el) => el.getAttribute("aria-disabled") === "true");
    expect(head?.textContent).toBe("Notes");
    const option = options.find((el) => el.getAttribute("aria-disabled") !== "true")!;
    expect(option.textContent).toContain("Groceries");
    // Still attributed in the row's own name, for a reader who lands on it directly.
    expect(option.textContent).toContain("from Notes");
    expect(option.querySelector('[data-testid="kind-icon-notebook"]')).not.toBeNull();
    expect(screen.getByText("to open")).toBeTruthy();
  });
});
