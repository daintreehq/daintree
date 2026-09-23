// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSection } from "../SettingsSection";

describe("SettingsSection", () => {
  it("names its group from the visible heading", () => {
    render(
      <SettingsSection title="My section" description="Section description">
        <div>child</div>
      </SettingsSection>
    );
    const group = screen.getByRole("group", { name: "My section" });
    expect(group.textContent).toContain("Section description");
  });

  it("renders the badge only when one is given", () => {
    const { rerender } = render(
      <SettingsSection title="My section" badge="New terminals">
        <div>child</div>
      </SettingsSection>
    );
    expect(screen.getByText("New terminals")).toBeTruthy();
    rerender(
      <SettingsSection title="My section">
        <div>child</div>
      </SettingsSection>
    );
    expect(screen.queryByText("New terminals")).toBeNull();
  });

  it("omits the description paragraph when there is nothing to add", () => {
    const { container } = render(
      <SettingsSection title="My section">
        <div>child</div>
      </SettingsSection>
    );
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("keeps the heading in the flow of the page rather than pinned over it", () => {
    const { container } = render(
      <SettingsSection title="My section" id="my-section">
        <div>child</div>
      </SettingsSection>
    );
    expect(container.querySelector("#my-section")).toBeTruthy();
    expect(container.querySelector(".sticky")).toBeNull();
  });

  it("puts a section action outside the heading so it is not part of the group's name", () => {
    render(
      <SettingsSection title="Agents" action={<button type="button">Run setup wizard</button>}>
        <div>child</div>
      </SettingsSection>
    );
    expect(screen.getByRole("group", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run setup wizard" })).toBeTruthy();
  });
});
