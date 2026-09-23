// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentCard } from "../AgentCard";

function renderCard(overrides: { isChecked?: boolean; isSaving?: boolean } = {}) {
  const onToggle = vi.fn();
  render(
    <AgentCard
      mode="onboarding"
      agentId="claude"
      availability={{ claude: "ready" } as never}
      isChecked={overrides.isChecked ?? false}
      isSaving={overrides.isSaving ?? false}
      onToggle={onToggle}
    />
  );
  return onToggle;
}

/**
 * The row is a <label> around the house Radix checkbox, a <button>. A click
 * anywhere on the row must toggle exactly once — a label forwarding its click
 * to a button that also handles it would toggle twice and cancel out.
 */
describe("AgentCard onboarding row", () => {
  it("toggles once from a click on the row's name", () => {
    const onToggle = renderCard();
    fireEvent.click(screen.getByText("Claude"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("claude", true);
  });

  it("toggles once from the checkbox itself, and unchecks when checked", () => {
    const onToggle = renderCard({ isChecked: true });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("claude", false);
  });

  it("does nothing while the selection is saving", () => {
    const onToggle = renderCard({ isSaving: true });
    fireEvent.click(screen.getByText("Claude"));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
