// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSwitchCard } from "../SettingsSwitchCard";

// Resolve within the render container rather than `document`, so the assertion
// survives a custom/detached container and doesn't pin the useId format.
function describedElement(container: HTMLElement, id: string | null | undefined) {
  return id ? Array.from(container.querySelectorAll("[id]")).find((el) => el.id === id) : undefined;
}

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
    expect(switchEl?.getAttribute("data-tone")).toBe("warning");
  });

  it("applies danger color scheme to switch track when enabled", () => {
    const { container } = render(
      <SettingsSwitchCard {...defaultProps} isEnabled={true} colorScheme="danger" />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.getAttribute("data-tone")).toBe("danger");
  });

  it("applies accent color scheme by default", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} isEnabled={true} />);
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.getAttribute("data-tone")).toBe("neutral");
  });

  it("points the switch at the subtitle via aria-describedby", () => {
    const { container } = render(<SettingsSwitchCard {...defaultProps} />);
    const switchEl = container.querySelector('[role="switch"]');
    const describedBy = switchEl?.getAttribute("aria-describedby");
    expect(describedBy, "switch must describe itself with the subtitle").toBeTruthy();
    expect(describedElement(container, describedBy)?.textContent).toBe(defaultProps.subtitle);
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
    expect(describedElement(container, ids[0])?.textContent).toBe("First subtitle");
    expect(describedElement(container, ids[1])?.textContent).toBe("Second subtitle");
  });
});
