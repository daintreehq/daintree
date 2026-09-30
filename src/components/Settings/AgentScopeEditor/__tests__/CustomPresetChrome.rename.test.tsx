// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CustomPresetChrome } from "../CustomPresetChrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentPreset } from "@/config/agents";

const preset: AgentPreset = { id: "user-fast", name: "Fast reviewer" };

function renderChrome(overrides: Partial<React.ComponentProps<typeof CustomPresetChrome>> = {}) {
  const props: React.ComponentProps<typeof CustomPresetChrome> = {
    selectedPreset: preset,
    agentColor: "#888888",
    isEditing: true,
    editName: preset.name,
    onEditNameChange: vi.fn(),
    onCommitEdit: vi.fn(() => true),
    onCancelEdit: vi.fn(),
    renameError: null,
    onStartEdit: vi.fn(),
    onColorChange: vi.fn(),
    onDisplayTitleChange: vi.fn(),
    onDuplicate: vi.fn(),
    ...overrides,
  };
  const view = render(<CustomPresetChrome {...props} />, { wrapper: TooltipProvider });
  return { props, ...view };
}

describe("custom preset rename", () => {
  it("selects the whole name when editing starts, so typing replaces it", () => {
    const { props, rerender } = renderChrome({ isEditing: false });
    rerender(<CustomPresetChrome {...props} isEditing />);

    const input = screen.getByTestId<HTMLInputElement>("preset-edit-input");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(preset.name.length);
  });

  it("does not commit an Enter that confirms an IME composition", () => {
    const { props } = renderChrome();
    fireEvent.keyDown(screen.getByTestId("preset-edit-input"), {
      key: "Enter",
      isComposing: true,
    });
    expect(props.onCommitEdit).not.toHaveBeenCalled();
  });

  it("commits on an ordinary blur", () => {
    const { props } = renderChrome();
    fireEvent.blur(screen.getByTestId("preset-edit-input"));
    expect(props.onCommitEdit).toHaveBeenCalledTimes(1);
  });

  it("commits once for Enter, however the field is blurred after it", () => {
    const { props } = renderChrome();
    const input = screen.getByTestId("preset-edit-input");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(props.onCommitEdit).toHaveBeenCalledTimes(1);
  });

  it("commits nothing for Escape, including from the blur after it", () => {
    const { props } = renderChrome();
    const input = screen.getByTestId("preset-edit-input");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(props.onCancelEdit).toHaveBeenCalledTimes(1);
    expect(props.onCommitEdit).not.toHaveBeenCalled();
  });

  it("stays editable and commits again on blur when Enter's name is refused", () => {
    const { props } = renderChrome({ onCommitEdit: vi.fn(() => false) });
    const input = screen.getByTestId("preset-edit-input");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(props.onCommitEdit).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the rename button after Escape", () => {
    const { props, rerender } = renderChrome();
    fireEvent.keyDown(screen.getByTestId("preset-edit-input"), { key: "Escape" });
    act(() => {
      rerender(<CustomPresetChrome {...props} isEditing={false} />);
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Edit ${preset.name}` })
    );
  });

  it("treats the name as an identifier: no spellcheck or autocorrect", () => {
    renderChrome();
    const input = screen.getByTestId("preset-edit-input");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("autocorrect")).toBe("off");
  });
});
