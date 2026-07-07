// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

import { HelpPanelHeader } from "../HelpPanelHeader";

function renderHeader(overrides: Partial<ComponentProps<typeof HelpPanelHeader>> = {}) {
  return render(
    <HelpPanelHeader
      agentState={null}
      canStartNewSession={false}
      canEndSession={false}
      onNewSession={vi.fn()}
      onEndSession={vi.fn()}
      onOpenDocs={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

describe("HelpPanelHeader", () => {
  it("renders identically when unfocused and when isFocused is omitted", () => {
    const { container: a } = renderHeader({ isFocused: false });
    const { container: b } = renderHeader({ isFocused: undefined });

    expect(a.firstElementChild!.className).toBe(b.firstElementChild!.className);
  });

  it("applies focused-state styling distinct from unfocused", () => {
    const { container: unfocused } = renderHeader({ isFocused: false });
    const { container: focused } = renderHeader({ isFocused: true });

    // The exact tokens are a design decision and may shift; we only verify
    // that focused vs unfocused render differently and that the focused
    // state stays neutral (no accent — accent is reserved for the macro
    // focus anchor per CLAUDE.md accent-restraint rules).
    expect(focused.firstElementChild!.className).not.toBe(unfocused.firstElementChild!.className);
    expect([...focused.firstElementChild!.classList].some((c) => c.includes("accent"))).toBe(false);
  });

  it("shows the stop button only when canEndSession is true", () => {
    const { queryByLabelText: withoutStop } = renderHeader({ canEndSession: false });
    expect(withoutStop("Stop Daintree Assistant")).toBeNull();

    const { queryByLabelText: withStop } = renderHeader({ canEndSession: true });
    expect(withStop("Stop Daintree Assistant")).not.toBeNull();
  });

  it("uses a stop label distinct from the hide (close) affordance", () => {
    const { getByLabelText } = renderHeader({ canEndSession: true });
    // Distinct aria-labels keep the stop and hide buttons independently
    // targetable — the hide button is "Hide Daintree Assistant".
    expect(getByLabelText("Stop Daintree Assistant")).not.toBe(
      getByLabelText("Hide Daintree Assistant")
    );
  });

  it("invokes onEndSession when the stop button is clicked", () => {
    const onEndSession = vi.fn();
    const { getByLabelText } = renderHeader({ canEndSession: true, onEndSession });

    fireEvent.click(getByLabelText("Stop Daintree Assistant"));

    expect(onEndSession).toHaveBeenCalledTimes(1);
  });
});
