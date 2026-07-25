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
