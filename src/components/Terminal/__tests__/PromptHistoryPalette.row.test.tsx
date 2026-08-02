// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptHistoryRow } from "../PromptHistoryPalette";
import type { PromptHistoryEntry } from "@/store/commandHistoryStore";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

function makeEntry(overrides: Partial<PromptHistoryEntry> = {}): PromptHistoryEntry {
  return {
    id: "entry-1",
    prompt: "fix the login bug",
    agentId: "claude",
    addedAt: Date.now(),
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
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );
    const { container: unselectedContainer } = render(
      <PromptHistoryRow
        item={makeEntry()}
        index={0}
        isSelected={false}
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
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );
    const { container: unselectedContainer } = render(
      <PromptHistoryRow
        item={makeEntry()}
        index={0}
        isSelected={false}
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
        onSelect={onSelect}
        onHoverIndex={vi.fn()}
      />
    );

    fireEvent.click(container.querySelector("button")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(entry);
  });

  it("renders the agentId chip when provided", () => {
    render(
      <PromptHistoryRow
        item={makeEntry({ agentId: "gemini" })}
        index={0}
        isSelected={false}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );

    expect(screen.getByText("gemini")).toBeTruthy();
  });

  it("omits the agentId chip when agentId is null", () => {
    render(
      <PromptHistoryRow
        item={makeEntry({ agentId: null })}
        index={0}
        isSelected={false}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />
    );

    expect(screen.queryByText("claude")).toBeNull();
  });
});
