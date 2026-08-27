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

  it("applies amber color scheme to switch track when enabled", () => {
    const { container } = render(
      <SettingsSwitchCard {...defaultProps} isEnabled={true} colorScheme="amber" />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.className).toContain("data-[state=checked]:bg-status-warning");
  });

  it("applies danger color scheme to switch track when enabled", () => {
    const { container } = render(
      <SettingsSwitchCard {...defaultProps} isEnabled={true} colorScheme="danger" />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.className).toContain("data-[state=checked]:bg-status-error");
  });

  it("applies accent color scheme by default", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} isEnabled={true} />);
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.className).toContain("data-[state=checked]:bg-daintree-text");
  });

  it("points the switch at the subtitle via aria-describedby", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} />);
    const switchEl = container.querySelector('[role="switch"]');
    const describedBy = switchEl?.getAttribute("aria-describedby");
    expect(describedBy, "switch must describe itself with the subtitle").toBeTruthy();
    expect(document.getElementById(describedBy!)).toBe(screen.getByText(defaultProps.subtitle));
  });

  it("gives each card its own description id", () => {
    const { container } = render(
      <>
        <SettingsSwitchCard {...defaultProps} title="First" subtitle="First subtitle" />
        <SettingsSwitchCard {...defaultProps} title="Second" subtitle="Second subtitle" />
      </>
    );
    const ids = Array.from(container.querySelectorAll('[role="switch"]')).map((el) =>
      el.getAttribute("aria-describedby")
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("First subtitle");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("Second subtitle");
  });
});
