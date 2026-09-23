// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { AgentSelectorDropdown, type AgentOption } from "../AgentSelectorDropdown";

// Render the popover inline: this asserts the listbox contract, not portal mechanics.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const Icon = () => null;
const agent = (id: string): AgentOption => ({
  id,
  name: id,
  color: "#888",
  Icon,
  selected: true,
  availability: "ready",
  dangerousEnabled: false,
  hasCustomFlags: false,
});

describe("AgentSelectorDropdown", () => {
  it("moves one cursor with the arrows and marks the shown page separately", () => {
    const onSubtabChange = vi.fn();
    render(
      <AgentSelectorDropdown
        agentOptions={[agent("claude"), agent("codex")]}
        activeSubtab="codex"
        onSubtabChange={onSubtabChange}
      />
    );
    const input = screen.getByRole("combobox");
    const cursor = () => document.getElementById(input.getAttribute("aria-activedescendant")!);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // Clamped at the end; exactly one option is the cursor.
    expect(cursor()?.id).toBe("agent-selector-item-codex");
    const options = screen.getAllByRole("option");
    expect(options.filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(cursor()?.getAttribute("aria-selected")).toBe("true");

    // The page being shown is aria-current, independent of the cursor.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const current = options.filter((o) => o.getAttribute("aria-current"));
    expect(current.map((o) => o.id)).toEqual(["agent-selector-item-codex"]);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubtabChange).toHaveBeenCalledWith("claude");
  });
});
