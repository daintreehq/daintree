/**
 * @vitest-environment jsdom
 *
 * The Other band's sort control (#11455).
 *
 * Uses the REAL dropdown and context-menu primitives: the whole feature is that
 * a header control opens a menu whose choice reaches the preference store, and
 * a stub that renders items as plain buttons would pass even if the trigger
 * were never wired to the menu.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});
afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("@/lib/colorUtils", () => ({
  getProjectGradient: () => "linear-gradient(red, blue)",
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "⌘P",
  useEffectiveCombo: () => undefined,
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
  useOverlayClaim: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/store/uiStore", () => ({
  useUIStore: () => 0,
}));

vi.mock("@/components/ui/AppPaletteDialog", () => {
  const Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Input = ({
    inputRef,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    inputRef?: React.Ref<HTMLInputElement>;
  }) => <input ref={inputRef} data-testid="palette-input" {...props} />;
  const Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Footer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;

  const Dialog = ({
    isOpen,
    children,
    ariaLabel,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    ariaLabel: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {children}
      </div>
    ) : null;
  Dialog.Header = Header;
  Dialog.Input = Input;
  Dialog.Body = Body;
  Dialog.Footer = Footer;

  return { AppPaletteDialog: Dialog, KBD_CLASS: "kbd" };
});

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => ({ meta: false, alt: false }),
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: () => "1h ago",
}));

import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { usePreferencesStore } from "@/store/preferencesStore";
import { DEFAULT_OTHER_PROJECTS_SORT_MODE, type OtherProjectsSortMode } from "@/lib/projectSort";
import { primeRadix } from "@/components/ui/radix-loader";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");

beforeAll(async () => {
  // The menu primitives resolve through the lazy Radix loader; without priming
  // the trigger renders as an inert passthrough and never opens.
  await primeRadix();
});

beforeEach(() => {
  usePreferencesStore.getState().setProjectSwitcherOtherSortMode(DEFAULT_OTHER_PROJECTS_SORT_MODE);
});

function makeProject(overrides: Partial<SearchableProject> & { id: string }): SearchableProject {
  return {
    name: overrides.id,
    path: `/repo/${overrides.id}`,
    emoji: "🌲",
    lastOpened: 1_000,
    status: "closed",
    frecencyScore: 1,
    section: "other",
    isActive: false,
    isBackground: false,
    isMissing: false,
    isPinned: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    processCount: 0,
    displayPath: `/repo/${overrides.id}`,
    ...overrides,
  } as SearchableProject;
}

function renderPalette(otherRows: number) {
  const results = Array.from({ length: otherRows }, (_, i) =>
    makeProject({ id: `other-${i}`, lastOpened: 1_000 - i })
  );
  return render(
    <ProjectSwitcherPalette
      isOpen
      mode="modal"
      query=""
      results={results}
      selectedIndex={0}
      onQueryChange={vi.fn()}
      onSelectPrevious={vi.fn()}
      onSelectNext={vi.fn()}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

function trigger(): HTMLElement {
  return screen.getByTestId("other-projects-sort-trigger");
}

/**
 * The header ROW carries the context-menu trigger; the labelling leaf inside it
 * carries the id. Right-clicking the surrounding group would not reach Radix,
 * since events bubble up from the trigger rather than down to it.
 */
function headerRow(): HTMLElement {
  const label = document.getElementById("project-section-other");
  if (!label?.parentElement) throw new Error("Other projects header not found");
  return label.parentElement;
}

/** Radix opens a dropdown on primary-button pointerdown, not on click. */
function openSortMenu(): void {
  fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false, pointerType: "mouse" });
}

function sortMode(): OtherProjectsSortMode {
  return usePreferencesStore.getState().projectSwitcherOtherSortMode;
}

describe("Other projects sort control (#11455)", () => {
  it("names the order the band is currently in", () => {
    renderPalette(4);
    // The control's first job is naming the order — every row shows a
    // timestamp, so an unlabelled frecency sort reads as broken.
    expect(trigger().textContent).toContain("Hottest");
    expect(trigger().getAttribute("aria-label")).toContain("Hottest");
  });

  it("offers every mode as a radio item reflecting the current choice", () => {
    renderPalette(4);
    openSortMenu();

    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((el) => el.textContent?.trim())).toEqual(["Hottest", "Recent", "A to Z"]);
    // Exactly one checked, and it is the mode the trigger advertises.
    const checked = items.filter((el) => el.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.textContent).toContain("Hottest");
  });

  it("writes the chosen mode to the preference and relabels the trigger", () => {
    renderPalette(4);
    openSortMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Recent/ }));

    expect(sortMode()).toBe("recent");
    expect(trigger().textContent).toContain("Recent");
    expect(trigger().getAttribute("aria-label")).toContain("Recent");
  });

  it("keeps the choice reachable by right-click below the visible threshold", () => {
    // Three rows hide the control, but the preference still governs the band,
    // so the options must not become unreachable with it.
    renderPalette(3);
    expect(screen.queryByTestId("other-projects-sort-trigger")).toBeNull();

    fireEvent.contextMenu(headerRow());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /A to Z/ }));

    expect(sortMode()).toBe("alphabetical");
  });

  it("hands focus back to the search box instead of the trigger", async () => {
    // Radix restores focus to the trigger by default, which then swallows
    // ArrowDown and Enter to reopen itself — leaving the palette unable to
    // walk or commit a row.
    renderPalette(4);
    openSortMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Recent/ }));

    // The refocus is deferred a frame to clear Radix's own restore window.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("palette-input"));
    });
    expect(document.activeElement).not.toBe(trigger());
  });

  it("does not lend its label to the band's accessible name", () => {
    renderPalette(4);
    const group = screen.getByRole("group", { name: "Other projects" });
    // The control lives inside the header row but outside the labelling leaf.
    expect(within(group).getByTestId("other-projects-sort-trigger")).toBeTruthy();
  });
});
