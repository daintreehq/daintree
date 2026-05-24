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
  it("does not lift the header background when unfocused", () => {
    const { container } = renderHeader(false);
    const root = container.firstElementChild!;

    expect(root.classList.contains("bg-overlay-subtle")).toBe(false);
    expect(root.classList.contains("transition-colors")).toBe(true);
  });

  it("does not lift the header background when isFocused is omitted", () => {
    const { container } = renderHeader(undefined);
    const root = container.firstElementChild!;

    expect(root.classList.contains("bg-overlay-subtle")).toBe(false);
  });

  it("lifts the header background with a neutral overlay when focused", () => {
    const { container } = renderHeader(true);
    const root = container.firstElementChild!;

    expect(root.classList.contains("bg-overlay-subtle")).toBe(true);
    expect(root.classList.contains("transition-colors")).toBe(true);
    // Neutral lift only — the accent ring is reserved for the macro-focus signal.
    expect([...root.classList].some((c) => c.includes("accent"))).toBe(false);
  });
});
