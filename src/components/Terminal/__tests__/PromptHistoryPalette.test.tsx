// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { PromptHistoryEntry } from "@/store/commandHistoryStore";
import type { PromptHistoryItem } from "@/hooks/usePromptHistoryPalette";
import { PREVIEW_MAX_CHARS, toPromptPreview } from "@/utils/promptHistoryPreview";

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

const { PromptHistoryPalette, PromptHistoryRow } =
  await import("@/components/Terminal/PromptHistoryPalette");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { useCommandHistoryStore } = await import("@/store/commandHistoryStore");
const { usePaletteStore } = await import("@/store/paletteStore");
const { useProjectStore } = await import("@/store/projectStore");
const { useAnnouncerStore } = await import("@/store/accessibilityAnnouncerStore");
const { useGlobalEscapeDispatcher } = await import("@/hooks/useGlobalEscapeDispatcher");

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
  // The scope segments carry tooltips; the app root supplies the provider.
  render(
    <TooltipProvider>
      <PromptHistoryPalette terminalId="t1" projectId={PROJECT} />
    </TooltipProvider>
  );
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
      document.querySelector(
        '[role="radiogroup"][aria-label="History scope"] [role="radio"][aria-checked="true"]'
      )?.textContent;
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

  it("lists a prompt once in this project, however many times it was sent", () => {
    seed({
      [PROJECT]: [
        { ...entry("a", "run the full test suite", 1), armedIds: ["t1", "t2"] },
        { ...entry("b", "run the full test suite", 5), armedIds: ["t3"] },
        entry("c", "summarise the diff", 9),
      ],
    });
    renderPalette();
    const texts = optionTexts();
    const kept = texts.filter((t) => t.includes("run the full test suite"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("1m ago");
    expect(texts).toHaveLength(2);
  });

  it("names each prompt's project across all projects, and no project within one", async () => {
    useProjectStore.setState({
      projects: [
        { id: PROJECT, name: "Daintree", path: "/a", emoji: "🌳", lastOpened: 0 },
        { id: OTHER, name: "Helios", path: "/b", emoji: "☀️", lastOpened: 0 },
      ],
    });
    seed({
      [PROJECT]: [entry("a", "summarise the diff", 1)],
      [OTHER]: [entry("b", "add a dark mode toggle", 2)],
    });
    const input = renderPalette();
    expect(optionTexts().join(" ")).not.toMatch(/Daintree|Helios/);
    await act(async () => {
      fireEvent.keyDown(input, { key: "r", metaKey: true });
    });
    const texts = optionTexts();
    expect(texts.find((t) => t.includes("dark mode"))).toContain("Helios");
    expect(texts.find((t) => t.includes("summarise"))).toContain("Daintree");
  });

  describe("in a remote host's view", () => {
    afterEach(() => {
      delete window.__DAINTREE_HOST_ID__;
    });

    it("lists this project's prompts from the host-scoped bucket, not a same-id local one", () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      seed({
        [`studio-01:${PROJECT}`]: [entry("a", "tail the remote build log", 1)],
        [PROJECT]: [entry("b", "a local prompt with the same project id", 2)],
      });
      renderPalette();
      const texts = optionTexts();
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("tail the remote build log");
    });

    it("never fills an empty remote bucket from a same-id local one", () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      seed({ [PROJECT]: [entry("a", "a local prompt with the same project id", 1)] });
      renderPalette();
      expect(optionTexts()).toHaveLength(0);
    });

    it("lists only this host's projects across all projects, named by their bare ids", async () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      useProjectStore.setState({
        projects: [
          { id: PROJECT, name: "Daintree", path: "/a", emoji: "🌳", lastOpened: 0 },
          { id: OTHER, name: "Helios", path: "/b", emoji: "☀️", lastOpened: 0 },
        ],
      });
      seed({
        [`studio-01:${PROJECT}`]: [entry("a", "tail the remote build log", 1)],
        [`studio-01:${OTHER}`]: [entry("b", "add a dark mode toggle", 2)],
        [`devbox:${PROJECT}`]: [entry("c", "a prompt from another host", 3)],
        [PROJECT]: [entry("d", "a prompt from this machine", 4)],
      });
      const input = renderPalette();
      await act(async () => {
        fireEvent.keyDown(input, { key: "r", metaKey: true });
      });
      const texts = optionTexts();
      expect(texts).toHaveLength(2);
      expect(texts.find((t) => t.includes("dark mode"))).toContain("Helios");
      expect(texts.find((t) => t.includes("remote build log"))).toContain("Daintree");
    });
  });

  it("keeps remote hosts' buckets out of a local view's all-projects list", async () => {
    seed({
      [PROJECT]: [entry("a", "summarise the diff", 1)],
      [`studio-01:${OTHER}`]: [entry("b", "tail the remote build log", 2)],
    });
    const input = renderPalette();
    await act(async () => {
      fireEvent.keyDown(input, { key: "r", metaKey: true });
    });
    const texts = optionTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("summarise the diff");
  });

  it("describes the scope and its chord from the search field, and announces a switch", async () => {
    const announce = vi.spyOn(useAnnouncerStore.getState(), "announce");
    seed({ [PROJECT]: [entry("a", "summarise the diff", 1)] });
    const input = renderPalette();
    const describe = () =>
      document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    const before = describe();
    expect(before).toMatch(/R/);
    await act(async () => {
      fireEvent.keyDown(input, { key: "r", metaKey: true });
    });
    expect(describe()).not.toBe(before);
    expect(announce).toHaveBeenCalledTimes(1);
    announce.mockRestore();
  });

  it("clears the query on the first Escape and closes on the second", async () => {
    function EscapeDispatcher() {
      useGlobalEscapeDispatcher();
      return null;
    }
    seed({ [PROJECT]: [entry("a", "summarise the diff", 1)] });
    render(<EscapeDispatcher />);
    const input = renderPalette();
    await type(input, "diff");
    const escape = () =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });

    await escape();
    expect(input.value).toBe("");
    expect(usePaletteStore.getState().activePaletteId).toBe("prompt-history");

    await escape();
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });
});

function makeEntry(overrides: Partial<PromptHistoryItem> = {}): PromptHistoryItem {
  const prompt = overrides.prompt ?? "fix the login bug";
  const { text, lineCount } = toPromptPreview(prompt);
  return {
    id: "entry-1",
    prompt,
    agentId: "claude",
    addedAt: Date.now(),
    preview: text,
    lineCount,
    projectId: "proj-a",
    ...overrides,
  };
}

describe("PromptHistoryRow", () => {
  it("sets aria-selected from isSelected prop", () => {
    const { container: selectedContainer } = render(
      <PromptHistoryRow
        item={makeEntry()}
        index={0}
        isSelected={true}
        query=""
        matches={undefined}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );
    const { container: unselectedContainer } = render(
      <PromptHistoryRow
        item={makeEntry()}
        index={0}
        isSelected={false}
        query=""
        matches={undefined}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );

    expect(selectedContainer.querySelector("button")?.getAttribute("aria-selected")).toBe("true");
    expect(unselectedContainer.querySelector("button")?.getAttribute("aria-selected")).toBe(
      "false"
    );
  });

  it("does not branch styling on isSelected — selection is purely aria-driven", () => {
    const { container: selectedContainer } = render(
      <PromptHistoryRow
        item={makeEntry()}
        index={0}
        isSelected={true}
        query=""
        matches={undefined}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );
    const { container: unselectedContainer } = render(
      <PromptHistoryRow
        item={makeEntry()}
        index={0}
        isSelected={false}
        query=""
        matches={undefined}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );

    expect(selectedContainer.querySelector("button")?.className).toBe(
      unselectedContainer.querySelector("button")?.className
    );
  });

  it("calls onHoverIndex with the row's index on pointer move", () => {
    const onHoverIndex = vi.fn();
    const { container } = render(
      <PromptHistoryRow
        item={makeEntry()}
        index={3}
        isSelected={false}
        query=""
        matches={undefined}
        onSelect={vi.fn()}
        onHoverIndex={onHoverIndex}
      />
    );

    fireEvent.pointerMove(container.querySelector("button")!);
    expect(onHoverIndex).toHaveBeenCalledTimes(1);
    expect(onHoverIndex).toHaveBeenCalledWith(3);
  });

  it("calls onSelect with the item when clicked", () => {
    const onSelect = vi.fn();
    const entry = makeEntry();
    const { container } = render(
      <PromptHistoryRow
        item={entry}
        index={0}
        isSelected={false}
        query=""
        matches={undefined}
        onSelect={onSelect}
        onHoverIndex={vi.fn()}
      />
    );

    fireEvent.click(container.querySelector("button")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(entry);
  });

  function renderRow(item: PromptHistoryItem, query = "") {
    return render(
      <PromptHistoryRow
        item={item}
        index={0}
        isSelected={false}
        query={query}
        matches={undefined}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );
  }

  function optionText(container: HTMLElement): string {
    return container.querySelector('[role="option"]')?.textContent ?? "";
  }

  it("names the recorded agent after the prompt, so the option's name starts with the visible text", () => {
    const { container } = renderRow(makeEntry({ agentId: "gemini" }));
    const text = optionText(container);
    expect(text.startsWith("fix the login bug")).toBe(true);
    expect(text).toMatch(/sent to gemini/i);
  });

  it("names no agent when none was recorded", () => {
    const { container } = renderRow(makeEntry({ agentId: null }));
    expect(optionText(container)).not.toMatch(/sent to/i);
  });

  it("shows words from every line of a prompt that opens with blank lines or a code fence", () => {
    for (const prompt of [
      "\n\n   rebase onto develop",
      "```ts\nconst retry = 1;\n```\nwhy does this overflow?",
    ]) {
      const { container, unmount } = renderRow(makeEntry({ prompt }));
      const text = optionText(container);
      const words = prompt.match(/[a-z]{4,}/g)!;
      for (const word of words) expect(text).toContain(word);
      expect(text).not.toMatch(/```|\n/);
      unmount();
    }
  });

  it("bounds the option's text so a long prompt is not read out in full", () => {
    const prompt = "word ".repeat(2000);
    const { container } = renderRow(makeEntry({ prompt }));
    expect(optionText(container).length).toBeLessThan(PREVIEW_MAX_CHARS + 60);
  });

  it("starts a search result near its match when the match is past the visible start", () => {
    const prompt = `${"lead ".repeat(40)}the retry backoff jitter`;
    const { container } = renderRow(makeEntry({ prompt }), "retry");
    const text = optionText(container);
    expect(text.indexOf("retry")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("retry")).toBeLessThan(40);
    const highlighted = [...container.querySelectorAll("span span")].map((el) => el.textContent);
    expect(highlighted).toContain("retry");
  });

  it("starts from the prompt's beginning while browsing", () => {
    const prompt = `${"lead ".repeat(40)}the retry backoff jitter`;
    const { container } = renderRow(makeEntry({ prompt }));
    expect(optionText(container).startsWith("lead")).toBe(true);
  });

  it("opens a phrase search on the phrase, not on an earlier stray word", () => {
    const prompt = `the ${"lead ".repeat(40)}and then the retry backoff jitter`;
    const { container } = renderRow(makeEntry({ prompt }), "the retry");
    const text = optionText(container);
    expect(text.indexOf("the retry")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("the retry")).toBeLessThan(40);
  });

  it("keeps the match on screen when a long unbroken token precedes it", () => {
    const prompt = `see https://example.com/${"a".repeat(400)} then fix the retry loop`;
    const { container } = renderRow(makeEntry({ prompt }), "retry");
    const text = optionText(container);
    expect(text.indexOf("retry")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("retry")).toBeLessThan(60);
  });
});
