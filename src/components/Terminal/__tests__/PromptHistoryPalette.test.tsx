// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { PromptHistoryEntry } from "@/store/commandHistoryStore";

// jsdom ships neither, and the palette body's scroll-shadow hook and the
// dialog's motion query both reach for them on mount.
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

const { PromptHistoryPalette } = await import("@/components/Terminal/PromptHistoryPalette");
const { useCommandHistoryStore } = await import("@/store/commandHistoryStore");
const { usePaletteStore } = await import("@/store/paletteStore");

const PROJECT = "proj-a";
const OTHER = "proj-b";

function entry(id: string, prompt: string, minutesAgo: number): PromptHistoryEntry {
  return { id, prompt, agentId: "claude", addedAt: Date.now() - minutesAgo * 60_000 };
}

function seed(history: Record<string, PromptHistoryEntry[]>) {
  useCommandHistoryStore.setState({ history });
  usePaletteStore.getState().openPalette("prompt-history");
}

function renderPalette() {
  render(<PromptHistoryPalette terminalId="t1" projectId={PROJECT} />);
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  expect(input).toBeTruthy();
  return input;
}

function optionTexts(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent ?? "");
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

describe("PromptHistoryPalette", () => {
  afterEach(() => {
    cleanup();
    act(() => usePaletteStore.getState().closePalette("prompt-history"));
  });

  it("finds a word that sits deep inside a long prompt", async () => {
    const deep = `${"Go through every forge provider we ship and make the ".repeat(3)}retry backoff use full jitter`;
    seed({ [PROJECT]: [entry("a", "summarise the diff", 1), entry("b", deep, 2)] });
    const input = renderPalette();
    await type(input, "retry");
    const texts = optionTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("retry");
  });

  it("shows the recall hint only while there is a row to recall", async () => {
    seed({ [PROJECT]: [entry("a", "summarise the diff", 1)] });
    const input = renderPalette();
    expect(document.body.textContent).toContain("to recall");
    await type(input, "kubernetes helm chart");
    expect(optionTexts()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("to recall");
  });

  it("switches scope from the search field with the palette's own chord, and back", async () => {
    seed({
      [PROJECT]: [entry("a", "summarise the diff", 1)],
      [OTHER]: [entry("b", "add a dark mode toggle", 2)],
    });
    const input = renderPalette();
    const scopeOf = () =>
      document.querySelector('[aria-label="History scope"] [aria-pressed="true"]')?.textContent;
    const initial = scopeOf();
    const initialCount = optionTexts().length;

    await act(async () => {
      fireEvent.keyDown(input, { key: "r", metaKey: true });
    });
    expect(scopeOf()).not.toBe(initial);
    expect(optionTexts().length).not.toBe(initialCount);

    await act(async () => {
      fireEvent.keyDown(input, { key: "r", ctrlKey: true });
    });
    expect(scopeOf()).toBe(initial);
    expect(optionTexts().length).toBe(initialCount);
  });

  it("keeps the scope switch available when this project has no history", () => {
    seed({ [OTHER]: [entry("b", "add a dark mode toggle", 2)] });
    renderPalette();
    expect(optionTexts()).toHaveLength(0);
    expect(document.querySelector('[aria-label="History scope"]')).toBeTruthy();
  });
});
