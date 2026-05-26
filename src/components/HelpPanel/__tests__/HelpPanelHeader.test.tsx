// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

import { HelpPanelHeader } from "../HelpPanelHeader";

function renderHeader(isFocused?: boolean) {
  return render(
    <HelpPanelHeader
      agentState={null}
      canStartNewSession={false}
      onNewSession={vi.fn()}
      onOpenDocs={vi.fn()}
      onClose={vi.fn()}
      isFocused={isFocused}
    />
  );
}

describe("HelpPanelHeader", () => {
  it("renders identically when unfocused and when isFocused is omitted", () => {
    const { container: a } = renderHeader(false);
    const { container: b } = renderHeader(undefined);

    expect(a.firstElementChild!.className).toBe(b.firstElementChild!.className);
  });

  it("applies focused-state styling distinct from unfocused", () => {
    const { container: unfocused } = renderHeader(false);
    const { container: focused } = renderHeader(true);

    // The exact tokens are a design decision and may shift; we only verify
    // that focused vs unfocused render differently and that the focused
    // state stays neutral (no accent — accent is reserved for the macro
    // focus anchor per CLAUDE.md accent-restraint rules).
    expect(focused.firstElementChild!.className).not.toBe(unfocused.firstElementChild!.className);
    expect([...focused.firstElementChild!.classList].some((c) => c.includes("accent"))).toBe(false);
  });
});
