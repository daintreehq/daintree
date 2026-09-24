// @vitest-environment jsdom
import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorktreeMoveBanner } from "../WorktreeMoveBanner";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// jsdom ships no `matchMedia`, and `InlineStatusBanner` reads it directly while
// rendering to resolve `prefers-reduced-motion`. Same stub the sibling banner
// suite installs.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderBanner(destinationPath: string | undefined, deliveryFailed = false) {
  const onTell = vi.fn();
  const onDismiss = vi.fn();
  // Stands in for TerminalPane, which focuses the pane from a React `onClick`
  // on the shell wrapping every banner slot. A control inside the bar has to
  // stop the click before it reaches that handler.
  const onPaneClick = vi.fn();
  const result = render(
    <WindowControlsInsetProvider>
      <div onClick={onPaneClick}>
        <WorktreeMoveBanner
          destinationPath={destinationPath}
          deliveryFailed={deliveryFailed}
          onTell={onTell}
          onDismiss={onDismiss}
        />
      </div>
    </WindowControlsInsetProvider>
  );
  return { ...result, onTell, onDismiss, onPaneClick };
}

const PATH = "/repo/wt-b";
const TELL = "Tell it to continue here";
const RETRY = "Retry telling the agent to continue in this worktree";
const DISMISS = "Dismiss worktree move notice";

describe("WorktreeMoveBanner", () => {
  it("offers the tell without printing the destination path in its label", () => {
    // The pane already lives in the destination; the label only has to say
    // "here". The path is disclosed in the tooltip, word for word as sent.
    renderBanner(PATH);

    expect(screen.getByText("Agent may still be in the old worktree")).not.toBeNull();
    const tell = screen.getByRole("button", { name: TELL });
    expect(tell.textContent).not.toContain(PATH);
    expect(screen.getByText(`Sends “Please continue in the directory ${PATH}”`)).not.toBeNull();
  });

  it("offers exactly two outcomes while the destination resolves", () => {
    // One action plus the built-in close. A third control for two outcomes is
    // what made the #11840 dialog feel like an interrogation.
    renderBanner(PATH);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: TELL })).not.toBeNull();
    expect(screen.getByRole("button", { name: DISMISS })).not.toBeNull();
  });

  it.each([
    { state: "first attempt", deliveryFailed: false, controlName: TELL },
    { state: "after a failed send", deliveryFailed: true, controlName: RETRY },
  ])(
    "keeps the dismiss straight after the action, with nothing between ($state)",
    ({ deliveryFailed, controlName }) => {
      // Clearing the notice must not mean a trip to the far edge of a wide pane.
      // The action and the X share one controls group, the X immediately after
      // the action, so wherever the row puts the action the X comes with it.
      renderBanner(PATH, deliveryFailed);

      const action = screen.getByRole("button", { name: controlName });
      const dismiss = screen.getByRole("button", { name: DISMISS });
      expect(action.parentElement).toBe(dismiss.parentElement);
      expect(action.nextElementSibling).toBe(dismiss);
      // A native button, not a `role="button"` stand-in: Enter/Space activation
      // comes free, and TerminalPane's keydown handler passes over events whose
      // target is a BUTTON — a span would leak them to the pane.
      expect(action).toBeInstanceOf(HTMLButtonElement);
    }
  );

  it("draws no severity wash behind the routine notice, only behind a failure", () => {
    // Moving agents is routine, so the advisory's severity rides on the glyph
    // alone. A failed send is something the user asked for going wrong, and
    // keeps the red band that says so.
    const { container, unmount } = renderBanner(PATH);
    expect(container.querySelector<HTMLElement>('[role="status"]')!.style.backgroundColor).toBe("");
    unmount();

    const failed = renderBanner(PATH, true);
    expect(
      failed.container.querySelector<HTMLElement>('[role="alert"]')!.style.backgroundColor
    ).not.toBe("");
  });

  it("is a polite status, not an alert", () => {
    // It reports a condition the user created; it must not interrupt them.
    const { container } = renderBanner(PATH);

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("reports the click through to tell without reaching the pane", () => {
    const { onTell, onDismiss, onPaneClick } = renderBanner(PATH);

    fireEvent.click(screen.getByRole("button", { name: TELL }));

    expect(onTell).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it("reports the close through to dismiss without reaching the pane", () => {
    const { onTell, onDismiss, onPaneClick } = renderBanner(PATH);

    fireEvent.click(screen.getByRole("button", { name: DISMISS }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onTell).not.toHaveBeenCalled();
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it("says so and offers no tell at all when the destination is gone", () => {
    // No fallback path is offered — guessing one is how a destructive default
    // ships (#7880) — and no dead disabled control either: there is nothing to
    // tell, so the sentence explains itself and the X is the only way out.
    renderBanner(undefined);

    expect(screen.getByText("Its new worktree no longer exists")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /continue/ })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("interrupts once a delivery has failed, instead of staying polite", () => {
    // The user asked for something and it did not happen (#11867) — that is
    // worth taking the screen reader off its queue for.
    const { container } = renderBanner(PATH, true);

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("offers one recovery action and the close, and no more, on failure", () => {
    const { onTell, onPaneClick } = renderBanner(PATH, true);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    // The first-attempt wording is gone: the sentence now says it is a retry.
    expect(screen.queryByRole("button", { name: TELL })).toBeNull();
    expect(screen.getByRole("button", { name: DISMISS })).not.toBeNull();
    const retry = screen.getByRole("button", { name: RETRY });

    fireEvent.click(retry);
    expect(onTell).toHaveBeenCalledTimes(1);
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it("says the send failed before offering the retry", () => {
    // The description carries the why; the sentence-control carries the what.
    renderBanner(PATH, true);

    expect(screen.getByRole("alert").textContent).toContain(
      "The instruction didn't reach the terminal"
    );
    expect(screen.getByRole("button", { name: RETRY })).not.toBeNull();
  });

  it("offers no recovery at all when the destination is gone", () => {
    // A failed send does not conjure a destination back into existence, and a
    // dead disabled Retry would only look like the app had stopped responding.
    renderBanner(undefined, true);

    expect(screen.getByText("Its new worktree no longer exists")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /continue/ })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps the dismiss available when the destination is gone", () => {
    // Losing the worktree must not trap the bar on the pane.
    const { onDismiss } = renderBanner(undefined);

    const dismiss = screen.getByRole("button", { name: DISMISS });
    expect(dismiss.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
