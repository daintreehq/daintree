// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/react";
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

function renderPalette(results: SendToAgentItem[]) {
  return render(
    <SendToAgentPalette
      isOpen
      query=""
      results={results}
      totalResults={results.length}
      selectedIndex={0}
      close={vi.fn()}
      setQuery={vi.fn()}
      selectPrevious={vi.fn()}
      selectNext={vi.fn()}
      selectItem={vi.fn()}
      confirmSelection={vi.fn()}
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
