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
    name: `Session ${id}`,
    iconId: "claude",
    color: "#fff",
    description: "model · agent · location",
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
    const items = [makeItem("a"), makeItem("b"), makeItem("c", { isStale: true })];
    paletteState.results = items;
    paletteState.visibleResults = items;
    paletteState.totalResults = items.length;
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
  });
});
