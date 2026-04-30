// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSection } from "../SettingsSection";

function TestIcon({ className }: { className?: string }) {
  return <svg data-testid="test-icon" className={className} />;
}

describe("SettingsSection", () => {
  it("renders title and description", () => {
    render(
      <SettingsSection icon={TestIcon} title="My Section" description="Section description">
        <div>child</div>
      </SettingsSection>
    );
    expect(screen.getByText("My Section")).toBeTruthy();
    expect(screen.getByText("Section description")).toBeTruthy();
  });

  it("renders badge when provided", () => {
    render(
      <SettingsSection icon={TestIcon} title="My Section" description="desc" badge="New Terminals">
        <div>child</div>
      </SettingsSection>
    );
    expect(screen.getByText("New Terminals")).toBeTruthy();
  });

  it("does not render badge when not provided", () => {
    render(
      <SettingsSection icon={TestIcon} title="My Section" description="desc">
        <div>child</div>
      </SettingsSection>
    );
    expect(screen.queryByText("New Terminals")).toBeNull();
  });

  it("uses grid layout with single-column track", () => {
    const { container } = render(
      <SettingsSection icon={TestIcon} title="My Section" description="desc">
        <div>child</div>
      </SettingsSection>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("grid")).toBe(true);
    expect(root.classList.contains("grid-cols-[minmax(0,1fr)]")).toBe(true);
    expect(root.classList.contains("gap-3")).toBe(true);
  });
});
