// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BehavioralControls } from "../BehavioralControls";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof BehavioralControls>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    scopeKind: "default",
    scopeLabel: "Claude",
    dangerousMode: "inherit",
    effectiveSkipPerms: false,
    inheritResolvesToOn: true,
    inheritHint: "Inherited from global setting",
    customArgsValue: "",
    customArgsPlaceholder: "--flag",
    customArgsDescription: "Extra CLI flags",
    customFlagsOverride: undefined,
    defaultDangerousArg: "--dangerously-skip-permissions",
    onDangerousModeChange: vi.fn(),
    onCustomFlagsChange: vi.fn(),
    onCustomFlagsOverrideReset: vi.fn(),
    ...overrides,
  };
}

describe("BehavioralControls — skip permissions control", () => {
  it("renders the skip-permissions control as three radios, not text inputs (issue #10530)", () => {
    const { container } = render(<BehavioralControls {...makeProps()} />);
    const region = container.querySelector("#agents-skip-permissions");
    if (!(region instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    const scoped = within(region);
    expect(scoped.getAllByRole("radio")).toHaveLength(3);
    expect(scoped.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("puts the choice on the row's rail as a segmented control, not a column of tiles", () => {
    const { container } = render(<BehavioralControls {...makeProps()} />);
    const region = container.querySelector("#agents-skip-permissions");
    if (!(region instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    expect(region.getAttribute("data-settings-row")).toBe("inline");
    const group = within(region).getByRole("radiogroup", { name: "Skip permissions" });
    const describedBy = group.getAttribute("aria-describedby") ?? "";
    const described = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain("Inherited from global setting");
  });

  it("names the dangerous flag in the row once bypass is in effect", () => {
    const { container } = render(
      <BehavioralControls {...makeProps({ effectiveSkipPerms: true })} />
    );
    const region = container.querySelector("#agents-skip-permissions");
    if (!(region instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    expect(within(region).getByText("--dangerously-skip-permissions")).toBeTruthy();
  });

  it("surfaces the inherited resolved value inline on the Default option and updates with the parent", () => {
    const { rerender } = render(
      <BehavioralControls {...makeProps({ inheritResolvesToOn: true })} />
    );
    expect(screen.getByRole("radio", { name: /Default \(On\)/ })).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ inheritResolvesToOn: false })} />);
    expect(screen.getByRole("radio", { name: /Default \(Off\)/ })).toBeTruthy();
  });

  it("shows the inherit provenance hint only while Default is selected", () => {
    // Scope to the skip-permissions region — the alt-screen control renders its
    // own identical "Inherited from …" hint when it is also on Default.
    const region = (container: HTMLElement) => {
      const el = container.querySelector("#agents-skip-permissions");
      if (!(el instanceof HTMLElement)) throw new Error("skip-permissions region not found");
      return within(el);
    };
    const { container, rerender } = render(
      <BehavioralControls {...makeProps({ dangerousMode: "inherit" })} />
    );
    expect(region(container).getByText("Inherited from global setting")).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ dangerousMode: "on" })} />);
    expect(region(container).queryByText("Inherited from global setting")).toBeNull();
  });

  it("renders whichever inherit hint the scope supplies, and none once a choice is explicit", () => {
    const region = (container: HTMLElement) => {
      const el = container.querySelector("#agents-skip-permissions");
      if (!(el instanceof HTMLElement)) throw new Error("skip-permissions region not found");
      return within(el);
    };
    for (const inheritHint of [
      "The global setting doesn't apply to this agent",
      "Inherited from agent default",
    ]) {
      const { container, rerender, unmount } = render(
        <BehavioralControls {...makeProps({ inheritHint })} />
      );
      expect(region(container).getByText(inheritHint)).toBeTruthy();
      expect(region(container).queryByText("Inherited from global setting")).toBeNull();
      for (const dangerousMode of ["on", "off"] as const) {
        rerender(<BehavioralControls {...makeProps({ inheritHint, dangerousMode })} />);
        expect(region(container).queryByText(inheritHint), dangerousMode).toBeNull();
      }
      unmount();
    }
  });
});

describe("BehavioralControls — no screen-mode choice (#16356)", () => {
  it("offers no alt-screen control, leaving only the radios for skip permissions", () => {
    const { container } = render(<BehavioralControls {...makeProps()} />);
    expect(screen.queryByText(/alt.screen/i)).toBeNull();
    expect(screen.queryByRole("radio", { name: "Inline" })).toBeNull();
    const skip = container.querySelector("#agents-skip-permissions");
    if (!(skip instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    expect(screen.getAllByRole("radio")).toEqual(within(skip).getAllByRole("radio"));
  });
});
