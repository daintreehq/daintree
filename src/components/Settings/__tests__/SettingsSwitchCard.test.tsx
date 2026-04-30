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

  const getThumb = (container: HTMLElement) => {
    const switchEl = container.querySelector('[role="switch"]');
    return switchEl?.querySelector("span") ?? null;
  };

  it("uses bg-daintree-text on the thumb in the OFF state for WCAG 1.4.11 contrast", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} isEnabled={false} />);
    const thumb = getThumb(container);
    expect(thumb).not.toBeNull();
    const classes = thumb?.className.split(/\s+/) ?? [];
    expect(classes).toContain("bg-daintree-text");
    expect(classes).toContain("data-[state=checked]:bg-text-inverse");
  });

  it("uses bg-text-inverse on the thumb in the ON state (sits on accent track)", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} isEnabled={true} />);
    const thumb = getThumb(container);
    expect(thumb).not.toBeNull();
    const classes = thumb?.className.split(/\s+/) ?? [];
    expect(classes).toContain("bg-daintree-text");
    expect(classes).toContain("data-[state=checked]:bg-text-inverse");
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
    expect(switchEl?.className).toContain("data-[state=checked]:bg-daintree-accent");
  });

  it("wraps content in subgrid container", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.classList.contains("grid-cols-subgrid")).toBe(true);
  });
});
