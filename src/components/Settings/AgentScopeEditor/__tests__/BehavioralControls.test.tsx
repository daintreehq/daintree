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
    inheritOriginLabel: "global setting",
    effectiveInlineMode: false,
    agentDefaultInline: false,
    customArgsValue: "",
    customArgsPlaceholder: "--flag",
    customArgsDescription: "Extra CLI flags",
    inlineOverride: undefined,
    customFlagsOverride: undefined,
    supportsInlineMode: true,
    defaultDangerousArg: "--dangerously-skip-permissions",
    onDangerousModeChange: vi.fn(),
    onInlineModeChange: vi.fn(),
    onCustomFlagsChange: vi.fn(),
    onInlineOverrideReset: vi.fn(),
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

  it("surfaces the inherited resolved value inline on the Default option and updates with the parent", () => {
    const { rerender } = render(
      <BehavioralControls {...makeProps({ inheritResolvesToOn: true })} />
    );
    expect(screen.getByRole("radio", { name: /Default \(On\)/ })).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ inheritResolvesToOn: false })} />);
    expect(screen.getByRole("radio", { name: /Default \(Off\)/ })).toBeTruthy();
  });

  it("shows the inherit provenance hint only while Default is selected", () => {
    const { rerender } = render(
      <BehavioralControls {...makeProps({ dangerousMode: "inherit" })} />
    );
    expect(screen.getByText("Inherited from global setting")).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ dangerousMode: "on" })} />);
    expect(screen.queryByText("Inherited from global setting")).toBeNull();
  });
});
