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

  it("names a waiting pane by its fleet band, and only needs-you is Waiting", () => {
    const cases = [
      ["needs-you", "Waiting"],
      ["review", "Unread"],
      ["done", "Finished"],
      ["blocked", "Blocked"],
      ["parked", "Parked"],
      ["snoozed", "Snoozed"],
      ["idle", "Idle"],
    ] as const;
    for (const [band, label] of cases) {
      renderBadge(`p-${band}`, "waiting", "question", band);
      expect(screen.getByTestId(`fleet-pane-state-p-${band}-waiting`).textContent).toBe(label);
    }
  });

  it("wears the waiting hue only for needs-you", () => {
    renderBadge("ask", "waiting", "question", "needs-you");
    renderBadge("unread", "waiting", "question", "review");
    renderBadge("prompt", "waiting", "prompt", "idle");
    renderBadge("k", "working", undefined, "needs-you");
    expect(screen.getByTestId("fleet-pane-state-ask-waiting").className).toContain(
      "text-state-waiting"
    );
    for (const id of ["unread-waiting", "prompt-waiting", "k-working"]) {
      expect(screen.getByTestId(`fleet-pane-state-${id}`).className).not.toContain(
        "text-state-waiting"
      );
    }
  });

  // The band is polled and the pane's state is pushed: a wait that has turned
  // into an error since must not keep a stale ask's hue or its word.
  it("drops a stale ask once the pane shows an error wait", () => {
    renderBadge("stale", "waiting", "error", "needs-you");
    const badge = screen.getByTestId("fleet-pane-state-stale-waiting");
    expect(badge.className).not.toContain("text-state-waiting");
    expect(badge.textContent).toBe("Last seen waiting");
  });

  it("says only what the terminal showed while the fleet has no band for it", () => {
    renderBadge("none", "waiting", "approval");
    renderBadge("lagging", "waiting", "prompt", "running");
    for (const id of ["none", "lagging"]) {
      const badge = screen.getByTestId(`fleet-pane-state-${id}-waiting`);
      expect(badge.textContent).toBe("Last seen waiting");
      expect(badge.className).not.toContain("text-state-waiting");
    }
  });

  it("keeps the classified reason as an observation, never the label", () => {
    renderBadge("p1", "waiting", "approval", "needs-you");
    const badge = screen.getByTestId("fleet-pane-state-p1-waiting");
    expect(badge.getAttribute("data-waiting-reason")).toBe("approval");
    expect(badge.getAttribute("data-state")).toBe("waiting");
    expect(badge.textContent).toBe("Waiting");

    renderBadge("p2", "waiting", "prompt", "needs-you");
    expect(
      screen.getByTestId("fleet-pane-state-p2-waiting").hasAttribute("data-waiting-reason")
    ).toBe(false);
  });

  // The exited badge reads at the same text contrast as the live states, so the
  // "dead pane recedes" signal rides the chip fill instead. Pinned as a relation
  // between the states rather than against whichever fill class is in use.
  it("drops the chip fill on exited panes while live states keep it", () => {
    renderBadge("x", "exited");
    renderBadge("w", "waiting", "question", "needs-you");
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
