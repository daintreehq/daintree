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
    expect(screen.getAllByTestId("active-icon")).toHaveLength(1);
    expect(screen.getAllByTestId("inactive-icon")).toHaveLength(1);
  });

  it("does not render trailing wrapper when trailing is undefined", () => {
    const subtabs = [{ id: "a", label: "A" }];
    const { container } = render(
      <SettingsSubtabBar subtabs={subtabs} activeId="a" onChange={vi.fn()} />
    );
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

  it("renders a tablist element", () => {
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("returns null when subtabs list is empty", () => {
    const { container } = render(<SettingsSubtabBar subtabs={[]} activeId="" onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("marks active button with aria-selected and role=tab", () => {
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="gemini" onChange={vi.fn()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);

    const geminiTab = screen.getByText("Gemini").closest("button")!;
    expect(geminiTab.getAttribute("aria-selected")).toBe("true");
    expect(geminiTab.getAttribute("tabindex")).toBe("0");

    const claudeTab = screen.getByText("Claude").closest("button")!;
    expect(claudeTab.getAttribute("aria-selected")).toBe("false");
    expect(claudeTab.getAttribute("tabindex")).toBe("-1");
  });

  it("navigates tabs with ArrowRight/ArrowLeft keys", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={onChange} />);
    const tablist = screen.getByRole("tablist");
    const claudeTab = screen.getByText("Claude").closest("button")!;

    claudeTab.focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("gemini");

    onChange.mockClear();
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("claude");
  });

  it("wraps around with ArrowRight on last tab", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="codex" onChange={onChange} />);
    const tablist = screen.getByRole("tablist");
    const codexTab = screen.getByText("Codex").closest("button")!;

    codexTab.focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("claude");
  });

  it("navigates to first/last with Home/End keys", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="gemini" onChange={onChange} />);
    const tablist = screen.getByRole("tablist");
    const geminiTab = screen.getByText("Gemini").closest("button")!;

    geminiTab.focus();
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("claude");

    onChange.mockClear();
    fireEvent.keyDown(tablist, { key: "End" });
    expect(onChange).toHaveBeenCalledWith("codex");
  });
});
