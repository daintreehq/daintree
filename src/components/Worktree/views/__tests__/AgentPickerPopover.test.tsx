// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { AgentPickerPopover } from "../AgentPickerPopover";
import type { FirstAgentOption } from "../../hooks/useFirstAgentOptions";

const AGENTS: FirstAgentOption[] = [
  { id: "claude", name: "Claude", iconId: "claude" },
  { id: "gemini", name: "Gemini", iconId: "gemini" },
  { id: "codex", name: "Codex", iconId: "codex" },
];

function pickerElement(overrides: Partial<React.ComponentProps<typeof AgentPickerPopover>> = {}) {
  return (
    <AgentPickerPopover
      agents={AGENTS}
      selectedAgentId={null}
      open={true}
      onOpenChange={vi.fn()}
      onSelectAgent={vi.fn()}
      listId="agent-list"
      {...overrides}
    />
  );
}

function rows() {
  return within(screen.getByRole("listbox")).getAllByRole("option");
}

/** The one row the cursor is on. Fails loudly if the list ever lights two. */
function cursorRow() {
  const lit = rows().filter((row) => row.getAttribute("aria-selected") === "true");
  expect(lit).toHaveLength(1);
  return lit[0]!;
}

afterEach(cleanup);

describe("AgentPickerPopover — where the cursor starts", () => {
  it("opens on the first row when no agent is chosen", () => {
    render(pickerElement({ selectedAgentId: null }));

    expect(rows().indexOf(cursorRow())).toBe(0);
    expect(cursorRow().getAttribute("aria-current")).toBe("true");
  });

  it("opens on the chosen agent, which is also the row carrying the check", () => {
    render(pickerElement({ selectedAgentId: "gemini" }));

    const cursor = cursorRow();
    expect(cursor.textContent).toContain("Gemini");
    expect(cursor.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("combobox").getAttribute("aria-activedescendant")).toBe(cursor.id);
  });

  it("commits the existing pick when Enter is the first key after opening", () => {
    const onSelectAgent = vi.fn<(id: string | null) => void>();
    render(pickerElement({ selectedAgentId: "codex", onSelectAgent }));

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(onSelectAgent).toHaveBeenCalledWith("codex");
  });

  it("steps from the chosen agent, not from the top", () => {
    render(pickerElement({ selectedAgentId: "claude" }));

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });

    expect(cursorRow().textContent).toContain("Gemini");
  });

  it("falls back to the first row when the chosen agent is no longer offered", () => {
    render(pickerElement({ selectedAgentId: "removed-agent" }));

    expect(rows().indexOf(cursorRow())).toBe(0);
  });

  it("reopens on the new pick rather than where the cursor wandered", () => {
    const { rerender } = render(pickerElement({ selectedAgentId: "claude" }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "End" });
    expect(cursorRow().textContent).toContain("Codex");

    rerender(pickerElement({ selectedAgentId: "gemini", open: false }));
    rerender(pickerElement({ selectedAgentId: "gemini", open: true }));

    expect(cursorRow().textContent).toContain("Gemini");
  });
});
