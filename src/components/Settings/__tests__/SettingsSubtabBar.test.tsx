// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsSubtabBar } from "../SettingsSubtabBar";

const SUBTABS = [
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "codex", label: "Codex" },
];

describe("SettingsSubtabBar", () => {
  it("renders all subtab buttons", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={onChange} />);
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Gemini")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("calls onChange with the clicked subtab id", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={onChange} />);
    fireEvent.click(screen.getByText("Gemini").closest("button")!);
    expect(onChange).toHaveBeenCalledWith("gemini");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("renders icons via renderIcon with isActive flag", () => {
    const renderIcon = vi.fn((isActive: boolean) => (
      <span data-testid={isActive ? "active-icon" : "inactive-icon"} />
    ));
    const subtabs = [
      { id: "a", label: "A", renderIcon },
      { id: "b", label: "B", renderIcon },
    ];
    render(<SettingsSubtabBar subtabs={subtabs} activeId="a" onChange={vi.fn()} />);
    // renderIcon called once per subtab; only one active at a time
    expect(screen.getAllByTestId("active-icon")).toHaveLength(1);
    expect(screen.getAllByTestId("inactive-icon")).toHaveLength(1);
  });

  it("does not render trailing wrapper when trailing is undefined", () => {
    const subtabs = [{ id: "a", label: "A" }];
    const { container } = render(
      <SettingsSubtabBar subtabs={subtabs} activeId="a" onChange={vi.fn()} />
    );
    // No span wrapper for trailing content when trailing is undefined
    const button = container.querySelector("button")!;
    expect(button.querySelector(".flex.items-center.gap-1")).toBeNull();
  });

  it("renders trailing content", () => {
    const subtabs = [
      {
        id: "a",
        label: "A",
        trailing: <span data-testid="trailing-dot" />,
      },
    ];
    render(<SettingsSubtabBar subtabs={subtabs} activeId="a" onChange={vi.fn()} />);
    expect(screen.getByTestId("trailing-dot")).toBeTruthy();
  });

  it("renders a nav element", () => {
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
    expect(screen.getByRole("navigation")).toBeTruthy();
  });

  it("returns null when subtabs list is empty", () => {
    const { container } = render(<SettingsSubtabBar subtabs={[]} activeId="" onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("marks active button with aria-current", () => {
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="gemini" onChange={vi.fn()} />);
    const geminiBtn = screen.getByText("Gemini").closest("button")!;
    expect(geminiBtn.getAttribute("aria-current")).toBe("true");
    const claudeBtn = screen.getByText("Claude").closest("button")!;
    expect(claudeBtn.getAttribute("aria-current")).toBeNull();
  });
});
