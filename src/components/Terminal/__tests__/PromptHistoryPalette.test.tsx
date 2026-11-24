// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { PromptHistoryEntry } from "@/store/commandHistoryStore";
import type { PromptHistoryItem } from "@/hooks/usePromptHistoryPalette";
import {
  PREVIEW_MAX_CHARS,
  mapPreviewRangesToPrompt,
  toPromptPreview,
} from "@/utils/promptHistoryPreview";
import { setPluginCustomIcons } from "@/components/icons/pluginCustomIconStore";
import { setPluginAgentRegistry } from "@shared/config/pluginAgentRegistry";

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

function renderPalette(
  props: { projectId?: string; draftProjectId?: string } = { projectId: PROJECT }
) {
  // The scope segments carry tooltips; the app root supplies the provider.
  render(
    <TooltipProvider>
      <PromptHistoryPalette
        terminalId="t1"
        projectId={props.projectId}
        draftProjectId={props.draftProjectId}
      />
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

  it("counts itself as a host for the action palette's `:` for as long as it is mounted", () => {
    const hosts = () => usePaletteStore.getState().promptHistoryHosts;
    expect(hosts()).toBe(0);

    // Closed: a mounted palette can answer an opening, which is all `:` asks.
    // StrictMode replays the effect, which must not leave a second count.
    const view = render(
      <StrictMode>
        <TooltipProvider>
          <PromptHistoryPalette terminalId="t1" projectId={PROJECT} />
        </TooltipProvider>
      </StrictMode>
    );
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
    expect(hosts()).toBe(1);

    view.rerender(
      <StrictMode>
        <TooltipProvider>
          <PromptHistoryPalette terminalId="t1" projectId={OTHER} />
        </TooltipProvider>
      </StrictMode>
    );
    expect(hosts()).toBe(1);

    view.unmount();
    expect(hosts()).toBe(0);
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

  it("opens the global assistant's history on every project's, naming its own prompts", async () => {
    const { GLOBAL_ASSISTANT_HISTORY_ID } = await import("@/store/commandHistoryStore");
    useProjectStore.setState({
      projects: [{ id: PROJECT, name: "Daintree", path: "/a", emoji: "🌳", lastOpened: 0 }],
    });
    seed({
      [PROJECT]: [entry("a", "summarise the diff", 1)],
      [GLOBAL_ASSISTANT_HISTORY_ID]: [entry("b", "which agents are waiting on me", 2)],
    });
    const input = renderPalette({ projectId: GLOBAL_ASSISTANT_HISTORY_ID });

    const texts = optionTexts();
    expect(texts.find((t) => t.includes("summarise"))).toContain("Daintree");
    expect(texts.find((t) => t.includes("agents are waiting"))).toContain("Global assistant");
    // No project of its own, so no "This project" to switch to, by click or chord.
    expect(document.querySelector('[aria-label="History scope"]')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(input, { key: "r", metaKey: true });
    });
    expect(optionTexts()).toHaveLength(2);
  });

  it("recalls into the composer's own draft when it isn't the history's project", async () => {
    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    useTerminalInputStore.setState({ draftInputs: new Map() });
    seed({ [OTHER]: [entry("a", "rebase onto develop", 1)] });
    renderPalette({ projectId: OTHER, draftProjectId: "isolated-composer" });

    await act(async () => {
      fireEvent.click(document.querySelector('[role="option"]')!);
    });

    const inputs = useTerminalInputStore.getState();
    expect(inputs.getDraftInput("t1", "isolated-composer")).toBe("rebase onto develop");
    expect(inputs.getDraftInput("t1", OTHER)).toBe("");
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
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    const before = describe();
    expect(before).toMatch(/R/);
    await act(async () => {
      fireEvent.keyDown(input, { key: "r", metaKey: true });
    });
    expect(describe()).not.toBe(before);
    expect(announce).toHaveBeenCalledTimes(1);
    announce.mockRestore();
  });

  describe("selected prompt preview", () => {
    const brief =
      "Fix the flaky retry test\n\n- check the backoff\n- run it ten times\n\n" +
      `${"Keep the diff small and leave the backoff alone. ".repeat(6)}final backoff sentinel`;
    const history = {
      [PROJECT]: [
        entry("a", "summarise the diff", 1),
        entry("b", brief, 2),
        entry("c", "add a dark mode toggle", 3),
      ],
    };

    function preview(): HTMLElement | null {
      return document.querySelector<HTMLElement>('[role="region"][aria-label="Selected prompt"]');
    }
    function previewText(): string | undefined {
      return preview()?.querySelector("p")?.textContent;
    }
    function marks(): string[] {
      return [...preview()!.querySelectorAll("[data-highlight]")].map((el) => el.textContent ?? "");
    }
    function selectedOptionId(): string | null {
      return document.querySelector('[role="option"][aria-selected="true"]')?.id ?? null;
    }

    it("shows the selected prompt in full with its line breaks, and follows the arrow keys", async () => {
      seed(history);
      const input = renderPalette();
      expect(previewText()).toBe("summarise the diff");

      const key = (k: string) =>
        act(async () => {
          fireEvent.keyDown(input, { key: k });
        });
      await key("ArrowDown");
      expect(previewText()).toBe(brief);
      await key("ArrowDown");
      expect(previewText()).toBe("add a dark mode toggle");
      await key("ArrowUp");
      expect(previewText()).toBe(brief);
      expect(selectedOptionId()).toBe(input.getAttribute("aria-activedescendant"));
    });

    it("follows the pointer too", async () => {
      seed(history);
      renderPalette();
      const hover = (i: number) =>
        act(async () => {
          fireEvent.pointerMove(document.querySelectorAll('[role="option"]')[i]!);
        });
      await hover(2);
      expect(previewText()).toBe("add a dark mode toggle");
      await hover(1);
      expect(previewText()).toBe(brief);
      await hover(0);
      expect(previewText()).toBe("summarise the diff");
    });

    it("marks every match of the query in the full text, and none once it is cleared", async () => {
      seed(history);
      const input = renderPalette();
      await type(input, "backoff");
      expect(previewText()).toBe(brief);
      expect(marks()).toEqual(Array(8).fill("backoff"));
      await type(input, "sentinel");
      expect(marks()).toEqual(["sentinel"]);
      await type(input, "");
      expect(marks()).toEqual([]);
    });

    it("marks where a typo'd search matched, in the raw text", async () => {
      seed({ [PROJECT]: [entry("a", brief, 1)] });
      const input = renderPalette();
      await type(input, "bakoff");
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
      expect(marks().length).toBeGreaterThan(0);
      // Each marked fragment lies wholly inside one "backoff", never spilling over a break.
      const text = previewText()!;
      const occurrences = [...text.matchAll(/backoff/gi)].map((m) => [m.index, m.index + 7]);
      let offset = 0;
      for (const node of preview()!.querySelector("p")!.childNodes) {
        const length = node.textContent?.length ?? 0;
        if (node instanceof HTMLElement && node.hasAttribute("data-highlight")) {
          expect(occurrences.some(([from, to]) => offset >= from! && offset + length <= to!)).toBe(
            true
          );
        }
        offset += length;
      }
    });

    it("scrolls to the first match when the search starts, and back to the top on a new selection", async () => {
      const offsetTop = vi
        .spyOn(HTMLElement.prototype, "offsetTop", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this.hasAttribute("data-highlight") ? 400 : 0;
        });
      try {
        seed(history);
        const input = renderPalette();
        const scroller = document.getElementById("prompt-history-preview-scroll")!;
        scroller.scrollTop = 0;
        await type(input, "sentinel");
        expect(scroller.scrollTop).toBeGreaterThan(300);
        await type(input, "");
        expect(scroller.scrollTop).toBe(0);
      } finally {
        offsetTop.mockRestore();
      }
    });

    it("starts a newly selected prompt at the top, with the query unchanged", async () => {
      seed(history);
      const input = renderPalette();
      const scroller = document.getElementById("prompt-history-preview-scroll")!;
      scroller.scrollTop = 250;
      await act(async () => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
      });
      expect(scroller.scrollTop).toBe(0);
    });

    it("pages the preview with Page Up and Page Down from the search field", async () => {
      seed(history);
      const input = renderPalette();
      const scroller = document.getElementById("prompt-history-preview-scroll")!;
      Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
      const scrollBy = vi.fn();
      scroller.scrollBy = scrollBy;
      let notCancelled = true;
      await act(async () => {
        notCancelled = fireEvent.keyDown(input, { key: "PageDown" });
      });
      expect(notCancelled).toBe(false);
      await act(async () => {
        fireEvent.keyDown(input, { key: "PageUp" });
      });
      expect(scrollBy.mock.calls.map(([arg]) => Math.sign(arg.top))).toEqual([1, -1]);
    });

    it("names the selected prompt's own project across all projects, and how many terminals it went to", async () => {
      useProjectStore.setState({
        projects: [
          { id: PROJECT, name: "Daintree", path: "/a", emoji: "🌳", lastOpened: 0 },
          { id: OTHER, name: "Helios", path: "/b", emoji: "☀️", lastOpened: 0 },
        ],
      });
      seed({
        [PROJECT]: [{ ...entry("a", "summarise the diff", 1), armedIds: ["t1", "t2", "t3"] }],
        [OTHER]: [{ ...entry("b", "add a dark mode toggle", 2), armedIds: ["t1"] }],
      });
      const input = renderPalette();
      expect(preview()?.textContent).not.toMatch(/Daintree|Helios/);
      expect(preview()?.textContent).toContain("3 terminals");
      await act(async () => {
        fireEvent.keyDown(input, { key: "r", metaKey: true });
      });
      expect(preview()?.textContent).toContain("Daintree");
      await act(async () => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
      });
      expect(preview()?.textContent).toContain("Helios");
      expect(preview()?.textContent).not.toMatch(/Daintree|terminals|Sent to/);
    });

    it("keeps the project and counts in the option's accessible name", async () => {
      useProjectStore.setState({
        projects: [{ id: PROJECT, name: "Daintree", path: "/a", emoji: "🌳", lastOpened: 0 }],
      });
      seed({ [PROJECT]: [{ ...entry("a", brief, 1), armedIds: ["t1", "t2"] }] });
      const input = renderPalette();
      await act(async () => {
        fireEvent.keyDown(input, { key: "r", metaKey: true });
      });
      const option = document.querySelector('[role="option"]')!;
      expect(option.textContent).toMatch(/Daintree.*4 lines.*2 terminals/);
    });

    it("describes the preview from the search field, with and without a scope hint", async () => {
      const describedBy = () =>
        document
          .querySelector('[role="combobox"]')!
          .getAttribute("aria-describedby")!
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent);
      seed(history);
      renderPalette();
      expect(describedBy()).toHaveLength(2);
      expect(describedBy().every((text) => text)).toBe(true);
      expect(describedBy().join(" ")).toMatch(/Page Down/);
      cleanup();

      const { GLOBAL_ASSISTANT_HISTORY_ID } = await import("@/store/commandHistoryStore");
      seed({ [GLOBAL_ASSISTANT_HISTORY_ID]: [entry("g", "which agents are waiting on me", 1)] });
      renderPalette({ projectId: GLOBAL_ASSISTANT_HISTORY_ID });
      expect(describedBy()).toHaveLength(1);
      expect(describedBy()[0]).toMatch(/Page Down/);
    });

    it("is absent when nothing matches, and back once the query clears", async () => {
      seed(history);
      const input = renderPalette();
      expect(preview()).not.toBeNull();
      await type(input, "zzzzqqqq");
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
      expect(preview()).toBeNull();
      await type(input, "");
      expect(preview()).not.toBeNull();
    });

    it("recalls the selected prompt on Enter", async () => {
      const { useTerminalInputStore } = await import("@/store/terminalInputStore");
      useTerminalInputStore.setState({ draftInputs: new Map() });
      seed(history);
      const input = renderPalette();
      await act(async () => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
      });
      expect(previewText()).toBe(brief);
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      expect(useTerminalInputStore.getState().getDraftInput("t1", PROJECT)).toBe(brief);
      expect(usePaletteStore.getState().activePaletteId).toBeNull();
    });
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

  it("gives a plugin agent's own mark the agent treatment (#16467)", () => {
    const key = "plugin-icon:acme.agents:./icons/pi.svg";
    setPluginCustomIcons([
      {
        key,
        pluginId: "acme.agents",
        pluginName: "Acme",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
      },
    ]);
    setPluginAgentRegistry({
      pi: {
        id: "pi",
        name: "Pi",
        command: "pi",
        color: "#3366ff",
        iconId: key,
        supportsContextInjection: false,
      },
    });
    try {
      const { container } = renderRow(makeEntry({ agentId: "pi" }));
      const mark = container.querySelector(`[data-plugin-icon="${key}"]`);
      expect(mark?.getAttribute("class")).toContain("brand-mark");
    } finally {
      setPluginCustomIcons([]);
      setPluginAgentRegistry({});
    }
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

describe("mapPreviewRangesToPrompt", () => {
  it("carries a range across the line break and dropped fences it was collapsed over", () => {
    const prompt = "```ts\nretry the\nbackoff job\n```";
    const { text } = toPromptPreview(prompt);
    const at = text.indexOf("the backoff");
    expect(mapPreviewRangesToPrompt(prompt, text, [[at, at + 10]])).toEqual([[12, 22]]);
  });

  it("puts the space for a line break on the break, not on the next line's first character", () => {
    const prompt = "backoff\njob";
    const { text } = toPromptPreview(prompt);
    expect(mapPreviewRangesToPrompt(prompt, text, [[3, 7]])).toEqual([[3, 7]]);
  });

  it("handles CRLF breaks and leading blank lines", () => {
    const prompt = "\r\n\r\nfix  the\r\nlogin bug";
    const { text } = toPromptPreview(prompt);
    const at = text.indexOf("login");
    const [range] = mapPreviewRangesToPrompt(prompt, text, [[at, at + 4]])!;
    const [from, to] = range!;
    expect(prompt.slice(from, to + 1)).toBe("login");
  });

  it("marks a prompt that is nothing but fences", () => {
    const prompt = "```\n```";
    const { text } = toPromptPreview(prompt);
    expect(mapPreviewRangesToPrompt(prompt, text, [[0, 2]])).toEqual([[0, 2]]);
  });

  it("returns exactly the ranges it was given, in linear time, however repetitive the prompt", () => {
    const prompt = "x y ".repeat(5000).trim();
    const { text } = toPromptPreview(prompt);
    const ranges = Array.from({ length: 2000 }, (_, i): [number, number] => [i * 4, i * 4 + 2]);
    const mapped = mapPreviewRangesToPrompt(prompt, text, ranges)!;
    expect(mapped).toHaveLength(2000);
    expect(mapped[1999]).toEqual([7996, 7998]);
  });

  it("gives up rather than mark the wrong text when the preview isn't this prompt's", () => {
    expect(mapPreviewRangesToPrompt("fix the bug", "something else", [[0, 2]])).toBeUndefined();
    expect(mapPreviewRangesToPrompt("a", "a", undefined)).toBeUndefined();
  });
});
