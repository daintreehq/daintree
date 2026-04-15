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
    const track = container.querySelector('[role="switch"]')?.querySelector("[aria-hidden]");
    return track?.firstElementChild ?? null;
  };

  it("uses bg-daintree-text on the thumb in the OFF state for WCAG 1.4.11 contrast", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} isEnabled={false} />);
    const thumb = getThumb(container);
    expect(thumb).not.toBeNull();
    const classes = thumb?.className.split(/\s+/) ?? [];
    expect(classes).toContain("bg-daintree-text");
    expect(classes).not.toContain("bg-text-inverse");
  });

  it("uses bg-text-inverse on the thumb in the ON state (sits on accent track)", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} isEnabled={true} />);
    const thumb = getThumb(container);
    expect(thumb).not.toBeNull();
    const classes = thumb?.className.split(/\s+/) ?? [];
    expect(classes).toContain("bg-text-inverse");
    expect(classes).not.toContain("bg-daintree-text");
  });
});
