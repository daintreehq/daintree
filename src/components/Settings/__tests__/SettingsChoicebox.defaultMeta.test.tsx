// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsChoicebox } from "../SettingsChoicebox";
import { SettingsGroup } from "../SettingsGroup";

afterEach(cleanup);

describe("SettingsChoicebox default annotation (#16598)", () => {
  it("shows Default beside the label without making it part of the name", () => {
    render(
      <SettingsGroup>
        <SettingsChoicebox
          label="Tool set"
          value="core"
          onChange={() => {}}
          options={[
            { value: "core", label: "Core", isDefault: true, description: "Smaller" },
            { value: "full", label: "Full" },
          ]}
        />
      </SettingsGroup>
    );
    const core = screen.getByRole("radio", { name: "Core" });
    const ids = (core.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Default",
      "Smaller",
    ]);
    expect(screen.getByRole("radio", { name: "Full" }).getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps the name plain outside a group too", () => {
    render(
      <SettingsChoicebox
        label="Tool set"
        value="core"
        onChange={() => {}}
        options={[
          { value: "core", label: "Core", isDefault: true, description: "Smaller" },
          { value: "full", label: "Full" },
        ]}
      />
    );
    const core = screen.getByRole("radio", { name: "Core" });
    const ids = (core.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Default",
      "Smaller",
    ]);
  });
});
