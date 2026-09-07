// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PanelPalette } from "../PanelPalette";
import type { PanelKindOption } from "@/hooks/usePanelPalette";

// jsdom lacks ResizeObserver (used by the palette's scroll-shadow hook) and
// scrollIntoView (called when the selected option changes).
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (
    selector: (s: { panelIds: string[]; panelsById: Record<string, unknown> }) => unknown
  ) => selector({ panelIds: [], panelsById: {} }),
}));

vi.mock("@/store/panelLimitStore", () => ({
  usePanelLimitStore: (selector: (s: { hardLimit: number }) => unknown) =>
    selector({ hardLimit: 0 }),
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useEffectiveCombo: () => undefined,
}));

const baseProps = {
  isOpen: true,
  totalResults: undefined,
  selectedIndex: 0,
  matchesById: new Map(),
  onQueryChange: vi.fn(),
  onSelectPrevious: vi.fn(),
  onSelectNext: vi.fn(),
  onSelect: vi.fn(),
  onConfirm: vi.fn(),
  onClose: vi.fn(),
};

const resumeResults: PanelKindOption[] = [
  { id: "agent:claude", name: "Claude", iconId: "claude", color: "#f80", category: "agent" },
  {
    id: "resume:a",
    name: "Resume: Fixing auth",
    iconId: "terminal",
    color: "#fff",
    category: "resume",
    worktreeName: "Feature X",
    isStale: false,
  },
  {
    id: "resume:b",
    name: "Resume: Old work",
    iconId: "terminal",
    color: "#fff",
    category: "resume",
    isStale: true,
  },
];

describe("PanelPalette resume section", () => {
  it("renders a flat resume section (no per-worktree sub-headers) when browsing", () => {
    render(<PanelPalette {...baseProps} query="" results={resumeResults} />);
    expect(screen.getByText("Resume Sessions")).toBeTruthy();
    // Rows render in journal order with no location headers between them.
    expect(screen.getByText("Resume: Fixing auth")).toBeTruthy();
    expect(screen.getByText("Resume: Old work")).toBeTruthy();
    expect(screen.queryByText("Feature X")).toBeNull();
  });

  it("shows a 'Worktree removed' badge on stale entries", () => {
    render(<PanelPalette {...baseProps} query="" results={resumeResults} />);
    expect(screen.getByText("Worktree removed")).toBeTruthy();
  });

  it("never uses role=group for headers (VoiceOver regression guard, #9006)", () => {
    // The palette renders through a portal, so query document.body, not the
    // render container.
    render(<PanelPalette {...baseProps} query="" results={resumeResults} />);
    const listbox = document.body.querySelector('[role="listbox"]')!;
    expect(listbox).toBeTruthy();
    expect(listbox.querySelectorAll('[role="group"]').length).toBe(0);
    // Section headers stay aria-hidden so they don't enter the option index.
    expect(listbox.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it("flattens the list (no section headers) while searching", () => {
    render(<PanelPalette {...baseProps} query="fix" results={resumeResults} />);
    expect(screen.queryByText("Resume Sessions")).toBeNull();
    // The options themselves still render.
    expect(screen.getByText("Resume: Fixing auth")).toBeTruthy();
  });
});

describe("PanelPalette results region (#11431)", () => {
  it("forwards navigation from the region and resolves its active option", () => {
    const onSelectNext = vi.fn();
    const onConfirm = vi.fn();
    render(
      <PanelPalette
        {...baseProps}
        query=""
        results={resumeResults}
        onSelectNext={onSelectNext}
        onConfirm={onConfirm}
      />
    );
    const region = screen.getByRole("group", { name: "Panel types" });

    fireEvent.keyDown(region, { key: "ArrowDown" });
    fireEvent.keyDown(region, { key: "Enter" });

    expect(onSelectNext).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // A wrong id prefix here would silently break the announcement.
    const activeDescendant = region.getAttribute("aria-activedescendant");
    expect(activeDescendant).toBe(`panel-option-${resumeResults[0]!.id}`);
    expect(document.getElementById(activeDescendant!)).not.toBeNull();
  });
});

describe("PanelPalette panel origin (#12272)", () => {
  const toolResults: PanelKindOption[] = [
    {
      id: "browser",
      name: "Browser",
      iconId: "browser",
      color: "#aaa",
      category: "tool",
      description: "Cmd+B",
      origin: "builtin",
    },
    {
      id: "vendor.kind",
      name: "Vendor",
      iconId: "package",
      color: "#aaa",
      category: "tool",
      origin: "plugin",
    },
    {
      id: "project:proj-1/vendor/local",
      name: "Local",
      iconId: "package",
      color: "#aaa",
      category: "tool",
      description: "Cmd+L",
      origin: "project-plugin",
    },
  ];

  function optionNamed(name: string): HTMLElement {
    const node = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (el) => el.textContent?.startsWith(name)
    );
    if (!node) throw new Error(`no option named ${name}`);
    return node;
  }

  it("names a plugin tier on its own, and beside a shortcut when there is one", () => {
    render(<PanelPalette {...baseProps} query="" results={toolResults} />);

    expect(optionNamed("Vendor").textContent).toContain("Plugin");
    // Origin leads, so it is the half that survives a truncated line.
    expect(optionNamed("Local").textContent).toContain("Project plugin · Cmd+L");
  });

  it("leaves a built-in row showing only its shortcut", () => {
    render(<PanelPalette {...baseProps} query="" results={toolResults} />);

    // Exactly the shortcut, not merely containing it: a "Built-in · Cmd+B"
    // regression is the shape this has to reject, and it is the one the rule
    // against marking the default exists to prevent.
    const browser = optionNamed("Browser");
    expect(browser.textContent).toBe("BrowserCmd+B");
  });

  it("puts the origin in the option's computed accessible name", () => {
    // Through the role query, not textContent: an `aria-hidden` on the marker
    // would leave the text intact and silently take the origin away from the
    // only users who cannot see it.
    render(<PanelPalette {...baseProps} query="" results={toolResults} />);

    expect(screen.getByRole("option", { name: /Project plugin/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /\bPlugin\b/ })).toBeTruthy();
  });

  it("keeps the trailing badge for state, which outranks provenance", () => {
    render(
      <PanelPalette {...baseProps} query="" results={[{ ...toolResults[2]!, installed: false }]} />
    );

    const row = optionNamed("Local");
    expect(row.textContent).toContain("Not installed");
    expect(row.textContent).toContain("Project plugin");
  });

  it("still names the origin while searching", () => {
    render(<PanelPalette {...baseProps} query="loc" results={toolResults} />);

    expect(optionNamed("Local").textContent).toContain("Project plugin");
  });
});
