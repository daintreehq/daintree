// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { SendToAgentItem } from "@/hooks/useSendToAgentPalette";
import type { TerminalChromeDescriptor } from "@/utils/terminalChrome";

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "Cmd+T",
  useEffectiveCombo: () => "Cmd+Shift+A",
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => null,
}));

// jsdom ships neither, and the palette body's scroll-shadow hook and the
// dialog's motion query both reach for them on mount. Stubbed through vitest so
// they do not survive environment teardown into the next file in this worker.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function matchMediaStub(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
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

const { SendToAgentPalette } = await import("@/components/Terminal/SendToAgentPalette");

const CHROME: TerminalChromeDescriptor = {
  iconId: "claude",
  label: "Claude Code",
  isAgent: true,
  agentId: "claude",
  processId: null,
  runtimeKind: "agent",
  hasExited: false,
};

function item(id: string, overrides: Partial<SendToAgentItem> = {}): SendToAgentItem {
  return {
    id,
    title: "Claude",
    subtitle: CHROME.label,
    terminalKind: "terminal",
    chrome: CHROME,
    ...overrides,
  };
}

function renderPalette(
  results: SendToAgentItem[],
  { selectedIndex = 0, setSelectedIndex = vi.fn() } = {}
) {
  return render(
    <SendToAgentPalette
      isOpen
      query=""
      results={results}
      totalResults={results.length}
      selectedIndex={selectedIndex}
      close={vi.fn()}
      setQuery={vi.fn()}
      selectPrevious={vi.fn()}
      selectNext={vi.fn()}
      selectItem={vi.fn()}
      confirmSelection={vi.fn()}
      setSelectedIndex={setSelectedIndex}
    />
  );
}

function rowFor(id: string): HTMLElement {
  const row = document.getElementById(`send-to-agent-option-${id}`);
  if (row === null) throw new Error(`no row rendered for ${id}`);
  return row;
}

describe("SendToAgentPalette rows", () => {
  it("gives identically titled rows distinct accessible names", () => {
    renderPalette([
      item("a", { subtitle: `${CHROME.label} · main` }),
      item("b", { subtitle: `${CHROME.label} · fix-auth` }),
    ]);

    expect(rowFor("a").getAttribute("aria-label")).toBe("Claude, Claude Code · main");
    expect(rowFor("b").getAttribute("aria-label")).toBe("Claude, Claude Code · fix-auth");
  });

  it("draws each row's worktree, not just announces it", () => {
    renderPalette([
      item("a", { subtitle: `${CHROME.label} · main` }),
      item("b", { subtitle: `${CHROME.label} · fix-auth` }),
    ]);

    expect(rowFor("a").textContent).toContain("main");
    expect(rowFor("a").textContent).not.toContain("fix-auth");
    expect(rowFor("b").textContent).toContain("fix-auth");
  });

  it("says worktrees are searchable on the search field", () => {
    renderPalette([item("a")]);

    const search = document.querySelector("input");
    if (search === null) throw new Error("no search field rendered");
    expect(search.getAttribute("placeholder")).toContain("worktree");
    expect(search.getAttribute("aria-label")).toContain("worktree");
  });

  it("keeps the accessible name to the title when there is no subtitle", () => {
    renderPalette([item("a", { subtitle: undefined })]);

    expect(rowFor("a").getAttribute("aria-label")).toBe("Claude");
  });

  it("does not leak the worktree into the accessible name while it stays undrawn", () => {
    renderPalette([item("a", { worktreeName: "peregrine" })]);

    const label = rowFor("a").getAttribute("aria-label") ?? "";
    expect(label).toBe("Claude, Claude Code");
    expect(rowFor("a").textContent).not.toContain("peregrine");
  });
});

describe("SendToAgentPalette locked rows", () => {
  const locked = (id: string) =>
    item(id, {
      title: "Codex: write the migration",
      subtitle: "Input locked",
      isInputLocked: true,
    });

  it("keeps a locked row legible rather than fading it", () => {
    renderPalette([item("a"), locked("b")]);

    // Opacity dims the reason line with the title; the row family steps the
    // title down instead, so nothing on any row may carry an opacity utility.
    for (const el of [rowFor("b"), ...rowFor("b").querySelectorAll("*")]) {
      expect(el.getAttribute("class") ?? "").not.toMatch(/(^|\s)opacity-/);
    }
    expect(rowFor("b").textContent).toContain("Input locked");
    expect(rowFor("b").getAttribute("aria-label")).toContain("Input locked");
    expect(rowFor("b").getAttribute("aria-disabled")).toBe("true");
  });

  it("never marks a locked row as the one Enter acts on", () => {
    renderPalette([locked("a"), locked("b")], { selectedIndex: 0 });

    expect(document.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(0);
    expect(document.body.textContent).toMatch(/unlock/i);
  });

  it("offers the unlock hint only when nothing can receive", () => {
    renderPalette([item("a"), locked("b")]);

    expect(document.body.textContent).not.toMatch(/unlock/i);
  });
});

describe("SendToAgentPalette footer", () => {
  it("names the pane Enter will paste into", () => {
    renderPalette([item("a", { title: "Codex: write the migration" }), item("b")]);

    expect(document.body.textContent).toMatch(/into Codex: write the migration/);
  });

  it("offers no Enter hint for a locked selection", () => {
    renderPalette(
      [
        item("a", {
          title: "Codex: write the migration",
          isInputLocked: true,
          subtitle: "Input locked",
        }),
      ],
      { selectedIndex: 0 }
    );

    expect(document.body.textContent).not.toMatch(/into /);
  });
});

describe("SendToAgentPalette pointer and Home/End", () => {
  it("moves the cursor to the row under the pointer, but never onto a locked one", () => {
    const setSelectedIndex = vi.fn();
    renderPalette([item("a"), item("b", { isInputLocked: true }), item("c")], { setSelectedIndex });

    fireEvent.pointerMove(rowFor("c"));
    expect(setSelectedIndex).toHaveBeenLastCalledWith(2);

    setSelectedIndex.mockClear();
    fireEvent.pointerMove(rowFor("b"));
    expect(setSelectedIndex).not.toHaveBeenCalled();
  });

  it("lands Home and End on the nearest row that can receive", () => {
    const setSelectedIndex = vi.fn();
    renderPalette(
      [
        item("a", { isInputLocked: true }),
        item("b"),
        item("c"),
        item("d", { isInputLocked: true }),
      ],
      { setSelectedIndex, selectedIndex: 1 }
    );
    const search = document.querySelector("input")!;

    fireEvent.keyDown(search, { key: "Home" });
    expect(setSelectedIndex).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(search, { key: "End" });
    expect(setSelectedIndex).toHaveBeenLastCalledWith(2);
  });
});
