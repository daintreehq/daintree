// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSwitchCard } from "../SettingsSwitchCard";

const defaultProps = {
  title: "Test Setting",
  subtitle: "A test subtitle",
  isEnabled: false,
  onChange: vi.fn(),
  ariaLabel: "Test toggle",
};

describe("SettingsSwitchCard", () => {
  it("renders title and subtitle", () => {
    render(<SettingsSwitchCard {...defaultProps} />);
    expect(screen.getByText("Test Setting")).toBeTruthy();
    expect(screen.getByText("A test subtitle")).toBeTruthy();
  });

  it("renders lifecycle badge when provided", () => {
    render(<SettingsSwitchCard {...defaultProps} lifecycleBadge="New Terminals" />);
    expect(screen.getByText("New Terminals")).toBeTruthy();
  });

  it("does not render lifecycle badge when not provided", () => {
    render(<SettingsSwitchCard {...defaultProps} />);
    expect(screen.queryByText("New Terminals")).toBeNull();
  });

  it("hides reset button when disabled even if modified", () => {
    const onReset = vi.fn();
    render(
      <SettingsSwitchCard {...defaultProps} isModified={true} onReset={onReset} disabled={true} />
    );
    expect(screen.queryByLabelText("Reset Test Setting to default")).toBeNull();
  });

  it("shows reset button when modified and not disabled", () => {
    const onReset = vi.fn();
    render(
      <SettingsSwitchCard {...defaultProps} isModified={true} onReset={onReset} disabled={false} />
    );
    expect(screen.getByLabelText("Reset Test Setting to default")).toBeTruthy();
  });
});
