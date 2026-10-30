// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EnvironmentRadioGroup } from "../EnvironmentRadioGroup";

describe("EnvironmentRadioGroup", () => {
  it("offers a saved environment named local only as the Local pill", () => {
    render(
      <EnvironmentRadioGroup
        worktreeMode="local"
        onChange={vi.fn()}
        resourceEnvironments={{ local: {}, staging: {} }}
        hasAnyEnvironments
      />
    );

    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["Local", "staging"]);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("keeps an environment named Local, which is a different key from Local mode", () => {
    const onChange = vi.fn();
    render(
      <EnvironmentRadioGroup
        worktreeMode="local"
        onChange={onChange}
        resourceEnvironments={{ Local: {} }}
        hasAnyEnvironments
      />
    );

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    fireEvent.click(radios[1]!);
    expect(onChange).toHaveBeenCalledWith("Local");
  });
});
