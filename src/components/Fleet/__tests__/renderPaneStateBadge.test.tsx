// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderPaneStateBadge } from "../renderPaneStateBadge";

function renderBadge(...args: Parameters<typeof renderPaneStateBadge>) {
  const el = renderPaneStateBadge(...args);
  if (el) render(el);
  return el;
}

describe("renderPaneStateBadge", () => {
  it("renders nothing for states outside working/waiting/exited", () => {
    expect(renderPaneStateBadge("p1", "idle")).toBeNull();
    expect(renderPaneStateBadge("p1", "completed")).toBeNull();
    expect(renderPaneStateBadge("p1", "directing")).toBeNull();
    expect(renderPaneStateBadge("p1", undefined)).toBeNull();
  });

  it("labels a waiting pane with the classified reason when evidence exists", () => {
    renderBadge("p1", "waiting", "approval");
    const badge = screen.getByTestId("fleet-pane-state-p1-waiting");
    expect(badge.textContent).toBe("Approval");
    expect(badge.getAttribute("data-waiting-reason")).toBe("approval");
    expect(badge.getAttribute("data-state")).toBe("waiting");
  });

  it("keeps the generic Waiting label for the prompt fallback and missing reasons", () => {
    renderBadge("p1", "waiting", "prompt");
    const badge = screen.getByTestId("fleet-pane-state-p1-waiting");
    expect(badge.textContent).toBe("Waiting");
    expect(badge.hasAttribute("data-waiting-reason")).toBe(false);
  });

  it("tints waiting panes with the waiting state color while working stays muted", () => {
    renderBadge("w", "waiting", "question");
    renderBadge("k", "working");
    const waiting = screen.getByTestId("fleet-pane-state-w-waiting");
    const working = screen.getByTestId("fleet-pane-state-k-working");
    expect(waiting.className).toContain("text-state-waiting");
    expect(working.className).not.toContain("text-state-waiting");
  });

  // The exited badge reads at the same text contrast as the live states, so the
  // "dead pane recedes" signal rides the chip fill instead. Pinned as a relation
  // between the states rather than against whichever fill class is in use.
  it("drops the chip fill on exited panes while live states keep it", () => {
    renderBadge("x", "exited");
    renderBadge("w", "waiting", "question");
    renderBadge("k", "working");
    const fill = (id: string) =>
      screen
        .getByTestId(id)
        .className.split(/\s+/)
        .filter((c) => c.startsWith("bg-"))
        .join(" ");
    expect(fill("fleet-pane-state-w-waiting")).toBe(fill("fleet-pane-state-k-working"));
    expect(fill("fleet-pane-state-x-exited")).not.toBe(fill("fleet-pane-state-w-waiting"));
  });

  it("ignores a stale waiting reason on non-waiting states", () => {
    renderBadge("p2", "working", "approval");
    const badge = screen.getByTestId("fleet-pane-state-p2-working");
    expect(badge.textContent).toBe("Working");
    expect(badge.hasAttribute("data-waiting-reason")).toBe(false);
  });
});
