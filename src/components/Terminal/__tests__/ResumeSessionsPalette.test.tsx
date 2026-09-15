// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import type { ResumeSessionItem } from "@/services/resumeSessionItems";

const paletteState = {
  isOpen: true,
  query: "",
  results: [] as ResumeSessionItem[],
  totalResults: 0,
  selectedIndex: 0,
  matchesById: new Map(),
  setQuery: vi.fn(),
  selectPrevious: vi.fn(),
  selectNext: vi.fn(),
  close: vi.fn(),
  isLoading: false,
  isSearching: false,
  visibleResults: [] as ResumeSessionItem[],
  hiddenCount: 0,
  showMore: vi.fn(),
  removedResults: [] as ResumeSessionItem[],
  removedVisible: false,
  toggleRemoved: vi.fn(),
};

vi.mock("@/hooks/useResumeSessionsPalette", () => ({
  useResumeSessionsPalette: () => paletteState,
  RESUME_PAGE_SIZE: 20,
}));

vi.mock("@/hooks/useResumeAgentSession", () => ({
  useResumeAgentSession: () => vi.fn(),
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useEffectiveCombo: () => "Cmd+K Cmd+R",
}));

// jsdom ships none of these, and the palette body's scroll-shadow hook and the
// dialog's motion query both reach for them on mount. Stubbed through vitest
// rather than assigned onto `globalThis`: neither is a jsdom-owned key, so a
// raw assignment survives environment teardown and leaks into whatever file
// this worker runs next — an always-false motion query is exactly the kind of
// thing that then passes for the wrong reason.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function matchMediaStub(query: string): MediaQueryList {
  const list: MediaQueryList = {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  return list;
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("matchMedia", matchMediaStub);
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

afterAll(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const { ResumeSessionsPalette } = await import("@/components/Terminal/ResumeSessionsPalette");

function makeItem(id: string, overrides: Partial<ResumeSessionItem> = {}): ResumeSessionItem {
  return {
    id,
    // Only forwarded to the resume launcher, which is mocked out here.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- journal-record fixture stub
    session: { sessionId: id } as ResumeSessionItem["session"],
    title: `Session ${id}`,
    hasTitle: true,
    name: `Resume: Session ${id}`,
    iconId: "claude",
    color: "#fff",
    modelName: "Opus 4.8",
    location: "feature-a",
    timeAgo: "5m ago",
    description: "feature-a · Opus 4.8 · 5m ago",
    searchAliases: [],
    isStale: false,
    ...overrides,
  };
}

function rowFor(id: string): HTMLElement {
  const row = document.getElementById(`resume-session-option-${id}`);
  if (row === null) throw new Error(`no row rendered for ${id}`);
  return row;
}

describe("ResumeSessionsPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const live = [makeItem("a"), makeItem("b")];
    const removed = [makeItem("c", { isStale: true }), makeItem("d", { isStale: true })];
    paletteState.results = [...live, ...removed];
    paletteState.visibleResults = live;
    paletteState.removedResults = removed;
    paletteState.removedVisible = true;
    paletteState.isSearching = false;
    paletteState.totalResults = live.length + removed.length;
    paletteState.selectedIndex = 0;
  });

  it("marks exactly one row selected and points the active descendant at it", () => {
    render(<ResumeSessionsPalette />);

    const selected = screen.getAllByRole("option").filter((el) => el.ariaSelected === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe("resume-session-option-a");

    // The referenced element must exist, or assistive tech is pointed at nothing.
    const owner = screen.getByRole("combobox");
    const referenced = owner.getAttribute("aria-activedescendant");
    expect(referenced).not.toBeNull();
    expect(document.getElementById(referenced!)).not.toBeNull();
  });

  it("moves the selected row and the active descendant together", () => {
    const { unmount } = render(<ResumeSessionsPalette />);
    const firstReferenced = screen.getByRole("combobox").getAttribute("aria-activedescendant");
    unmount();

    paletteState.selectedIndex = 1;
    render(<ResumeSessionsPalette />);

    const referenced = screen.getByRole("combobox").getAttribute("aria-activedescendant");
    expect(referenced).not.toBe(firstReferenced);
    expect(rowFor("b").ariaSelected).toBe("true");
    expect(rowFor("a").ariaSelected).toBe("false");
    expect(document.getElementById(referenced!)).not.toBeNull();
  });

  it("styles selection from the attribute, so a row's class list does not depend on it", () => {
    // The regression this guards: the selected treatment used to live inside a
    // JS `isSelected` ternary, which let the rendered attribute and the visible
    // highlight drift apart and left the rail with nothing to transition.
    render(<ResumeSessionsPalette />);
    const selectedClass = rowFor("a").className;
    const unselectedClass = rowFor("b").className;

    expect(rowFor("a").ariaSelected).toBe("true");
    expect(rowFor("b").ariaSelected).toBe("false");
    expect(selectedClass).toBe(unselectedClass);

    // Identical class lists alone would also hold if the row simply stopped
    // carrying any selected treatment, so pin that it still composes the
    // shared definition. Referencing the constant rather than restating its
    // utilities keeps this honest if the recipe itself changes.
    const applied = new Set(selectedClass.split(/\s+/));
    const missing = PALETTE_ROW_CLASS.split(/\s+/).filter((token) => !applied.has(token));
    expect(missing).toEqual([]);
  });

  it("keeps a stale row visually distinct from a merely unselected one", () => {
    render(<ResumeSessionsPalette />);

    // Staleness is still a class-level difference — it is a property of the
    // item, not of the selection, so it must not have been folded away.
    expect(rowFor("c").className).not.toBe(rowFor("b").className);
    expect(rowFor("c").getAttribute("aria-disabled")).toBe("true");
    // And an inert row makes no hover promise a live one keeps.
    const hoverTokens = (el: HTMLElement) =>
      el.className.split(/\s+/).filter((token) => token.startsWith("hover:"));
    expect(hoverTokens(rowFor("b")).length).toBeGreaterThan(0);
    expect(hoverTokens(rowFor("c"))).toEqual([]);
  });

  it("says 'Worktree removed' once for the section, never once per row", () => {
    render(<ResumeSessionsPalette />);
    const list = screen.getByRole("listbox");
    const mentions = (list.textContent ?? "").match(/worktree removed/gi) ?? [];
    expect(mentions).toHaveLength(1);
    // Both removed rows are rendered under it, in a group the heading names.
    const group = screen.getByRole("group", { name: /worktree removed/i });
    expect(group.contains(rowFor("c"))).toBe(true);
    expect(group.contains(rowFor("d"))).toBe(true);
    expect(group.contains(rowFor("a"))).toBe(false);
  });

  it("drops the resume hint when nothing on screen can be resumed", () => {
    paletteState.results = paletteState.removedResults;
    paletteState.visibleResults = [];
    paletteState.selectedIndex = -1;
    render(<ResumeSessionsPalette />);
    expect(document.querySelector('[role="dialog"]')?.textContent ?? "").not.toMatch(/to resume/);
  });

  it("folds the removed rows away while browsing until the heading is opened", () => {
    paletteState.removedVisible = false;
    render(<ResumeSessionsPalette />);

    expect(document.getElementById("resume-session-option-c")).toBeNull();
    const fold = screen.getByRole("button", { name: /worktree removed/i });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toContain("2");
    fold.click();
    expect(paletteState.toggleRemoved).toHaveBeenCalledTimes(1);
  });

  it("labels rather than folds the removed matches while searching", () => {
    paletteState.isSearching = true;
    paletteState.query = "sess";
    render(<ResumeSessionsPalette />);

    expect(screen.queryByRole("button", { name: /worktree removed/i })).toBeNull();
    expect(screen.getByRole("listbox").textContent).toMatch(/worktree removed/i);
    expect(rowFor("c")).not.toBeNull();
  });

  it("renders the bare title with its age beside it, and never stutters the verb", () => {
    render(<ResumeSessionsPalette />);
    const row = rowFor("a");
    expect(row.textContent).not.toMatch(/resume/i);
    expect(row.textContent).toContain("Session a");
    expect(row.textContent).toContain("5m ago");
    // The age is its own element, not the tail of the metadata line.
    const meta = row.querySelector(".truncate:last-child");
    expect(meta?.textContent).not.toContain("5m ago");
    // Location leads the metadata line; the model follows it.
    expect(meta?.textContent).toBe("feature-a · Opus 4.8");

    const footer = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(footer).toMatch(/to resume Session a/);
    expect(footer).not.toMatch(/resume resume/i);
  });
});
