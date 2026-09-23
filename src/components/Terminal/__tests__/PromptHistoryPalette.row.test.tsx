// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptHistoryRow } from "../PromptHistoryPalette";
import type { PromptHistoryItem } from "@/hooks/usePromptHistoryPalette";
import { PREVIEW_MAX_CHARS, toPromptPreview } from "@/utils/promptHistoryPreview";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

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
    ...overrides,
  };
}

describe("PromptHistoryRow", () => {
  it("renders as a <button> with role=option", () => {
    const { container } = render(
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

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("role")).toBe("option");
  });

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
